// Opaque, revocable administrator sessions. No password or plaintext session
// token is written to D1; changing ADMIN_TOKEN also changes every lookup hash.
export const ADMIN_SESSION_DAYS = 30;
export const ADMIN_SESSION_TTL = ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000;
const SESSION_TOKEN = /^bs_[a-f0-9]{64}$/;
const encoder = new TextEncoder();

export class AdminSessionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const unauthorized = () => { throw new AdminSessionError(401, 'unauthorized', 'Administrator authorization is required.'); };
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function passwordMatches(supplied, expected) {
  const [left, right] = await Promise.all([supplied, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}
function database(value) {
  if (!value) throw new AdminSessionError(503, 'database_unconfigured', 'Database binding is not configured.');
  return value;
}
async function sessionHash(token, password) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode('xht37-admin-session-v1\0' + token)));
}

export async function createAdminSession(db, password, now = Date.now()) {
  const store = database(db);
  const token = 'bs_' + hex(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sessionHash(token, password);
  const expiry = now + ADMIN_SESSION_TTL;
  await store.batch([
    store.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now),
    store.prepare('INSERT INTO admin_sessions(token_hash, created_at, expires_at) VALUES (?, ?, ?)').bind(hash, now, expiry),
  ]);
  return { token, expires_at: new Date(expiry).toISOString() };
}

export async function administratorAuthorization(token, password, db, now = Date.now()) {
  if (await passwordMatches(token, password)) return { kind: 'password' };
  if (!SESSION_TOKEN.test(token)) unauthorized();
  const hash = await sessionHash(token, password);
  const found = await database(db).prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').bind(hash, now).first();
  if (!found) unauthorized();
  return { kind: 'session', hash, expires_at: new Date(found.expires_at).toISOString() };
}

export async function revokeAdminSession(authorization, db) {
  if (authorization.kind === 'session') await database(db).prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(authorization.hash).run();
}
