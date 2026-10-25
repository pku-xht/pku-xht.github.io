import { adminPage } from './admin.mjs';

const PUBLIC_ORIGIN = 'https://pku-xht.github.io';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/;
const PARENT_ID = /^(?:wp-[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const PUBLIC_FIELDS = 'id, document, nickname, body, parent_id, created_at';

class APIError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new APIError(status, code, message); }
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function strictObject(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'Expected a JSON object.');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'unknown_field', 'Unexpected request field.');
}
async function bodyJSON(request, allowed) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) fail(415, 'json_required', 'Use application/json.');
  if (Number(request.headers.get('Content-Length')) > 65536) fail(413, 'body_too_large', 'Request is too large.');
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) { await reader.cancel(); fail(413, 'body_too_large', 'Request is too large.'); }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  }
  const text = chunks.join('') + decoder.decode();
  let value;
  try { value = JSON.parse(text); } catch { fail(400, 'invalid_json', 'Invalid JSON.'); }
  strictObject(value, allowed);
  return value;
}
function docID(value, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value)) fail(400, 'invalid_document', 'Document must be a registered WordPress ID string.');
  return value;
}
function cursorValue(url) {
  const cursor = url.searchParams.get('cursor') || '0';
  if (!/^(?:0|[1-9][0-9]{0,14})$/.test(cursor)) fail(400, 'invalid_cursor', 'Invalid cursor.');
  return Number(cursor);
}
function db(env) {
  if (!env.DB) fail(503, 'database_unconfigured', 'Database binding is not configured.');
  return env.DB;
}
function secret(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || value.length < 32) fail(503, 'secret_unconfigured', 'Required service secret is not configured.');
  return value;
}
async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function authorized(request, env) {
  const expected = secret(env, 'ADMIN_TOKEN');
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('Authorization') || '');
  if (!match) fail(401, 'unauthorized', 'Administrator authorization is required.');
  const left = await sha256(match[1]), right = await sha256(expected);
  let different = 0;
  for (let index = 0; index < left.length; index++) different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  if (different) fail(401, 'unauthorized', 'Administrator authorization is required.');
}
function origins(env) {
  const result = new Set([PUBLIC_ORIGIN]);
  for (const entry of String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)) {
    let url;
    try { url = new URL(entry); } catch { fail(503, 'invalid_cors_config', 'Invalid origin allowlist.'); }
    if (!['http:', 'https:'].includes(url.protocol) || entry !== url.origin || url.username || url.password || entry === 'null') fail(503, 'invalid_cors_config', 'Invalid origin allowlist.');
    result.add(entry);
  }
  return result;
}
function corsOrigin(request, env, url) {
  const origin = request.headers.get('Origin');
  const admin = url.pathname.startsWith('/v1/admin/');
  if (origin && !origins(env).has(origin) && !(admin && origin === url.origin)) fail(403, 'origin_denied', 'Origin is not allowed.');
  if (!admin && request.method === 'POST' && !origin) fail(403, 'origin_required', 'A permitted Origin header is required.');
  return origin;
}
async function registered(database, id) {
  if (!(await database.prepare('SELECT id FROM public_documents WHERE id = ?').bind(id).first())) fail(404, 'unknown_document', 'Document is not registered.');
}
async function rateIdentity(request, env, scope, seconds) {
  const salt = secret(env, 'RATE_LIMIT_SALT');
  const address = request.headers.get('CF-Connecting-IP') || 'unavailable-local-address';
  const now = Math.floor(Date.now() / 1000);
  const key = `${scope}:${Math.floor(now / seconds)}:${await sha256(`${salt}\0${address}`)}`;
  return { key, now };
}
async function rateLimit(request, env, scope, limit, seconds) {
  const { key, now } = await rateIdentity(request, env, scope, seconds);
  const results = await db(env).batch([
    db(env).prepare('DELETE FROM rate_buckets WHERE expires_at < ?').bind(now - 86400),
    db(env).prepare(`INSERT INTO rate_buckets(key, count, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`).bind(key, now + seconds, limit),
  ]);
  if (!results[1].results.length) fail(429, 'rate_limited', 'Too many requests. Please try later.');
}
function validParentSQL() {
  return `( ? IS NULL OR EXISTS (SELECT 1 FROM comments p WHERE p.id = ? AND p.document = ? AND p.status = 'approved')
    OR EXISTS (SELECT 1 FROM legacy_parents p WHERE p.id = ? AND p.document = ?) )`;
}
async function parentExists(database, parent, document) {
  if (parent === null) return true;
  return Boolean(await database.prepare(`SELECT 1 AS found WHERE ${validParentSQL()}`).bind(parent, parent, document, parent, document).first());
}
function publicComment(row) {
  return { id: row.id, document: row.document, nickname: row.nickname, body: row.body, parent_id: row.parent_id, created_at: row.created_at };
}
async function listComments(url, env, admin = false) {
  const database = db(env), cursor = cursorValue(url);
  let rows;
  if (admin) {
    const status = url.searchParams.get('status') || 'pending';
    if (!['pending', 'approved', 'rejected'].includes(status)) fail(400, 'invalid_status', 'Invalid moderation status.');
    rows = (await database.prepare(`SELECT seq, ${PUBLIC_FIELDS}, status, moderated_at FROM comments WHERE status = ? AND seq > ? ORDER BY seq LIMIT 101`).bind(status, cursor).all()).results;
  } else {
    const document = docID(url.searchParams.get('document'));
    await registered(database, document);
    rows = (await database.prepare(`SELECT seq, ${PUBLIC_FIELDS} FROM comments WHERE document = ? AND status = 'approved' AND seq > ? ORDER BY seq LIMIT 101`).bind(document, cursor).all()).results;
  }
  const hasMore = rows.length > 100;
  rows = rows.slice(0, 100);
  return json({ comments: rows.map(row => admin ? { ...publicComment(row), status: row.status, moderated_at: row.moderated_at } : publicComment(row)), next_cursor: hasMore ? rows.at(-1).seq : null });
}
async function submitComment(request, env) {
  const value = await bodyJSON(request, ['document', 'nickname', 'body', 'parent_id', 'request_id', 'website']);
  const document = docID(value.document);
  if (typeof value.nickname !== 'string' || CONTROL.test(value.nickname)) fail(400, 'invalid_nickname', 'Enter your nickname (1–40 characters).');
  const nickname = value.nickname.trim();
  if (!nickname || [...nickname].length > 40) fail(400, 'invalid_nickname', 'Enter your nickname (1–40 characters).');
  if (typeof value.body !== 'string' || BODY_CONTROL.test(value.body)) fail(400, 'invalid_comment', 'Enter a plain-text comment (1–10000 characters).');
  const body = value.body.replace(/\r\n?/g, '\n').trim();
  if (!body || [...body].length > 10000) fail(400, 'invalid_comment', 'Enter a plain-text comment (1–10000 characters).');
  if (typeof value.request_id !== 'string' || !REQUEST_ID.test(value.request_id)) fail(400, 'invalid_request_id', 'Supply a unique request_id of 16–128 URL-safe characters.');
  const parent = value.parent_id === undefined || value.parent_id === null ? null : value.parent_id;
  if (parent !== null && (typeof parent !== 'string' || !PARENT_ID.test(parent))) fail(400, 'invalid_parent', 'Invalid reply target.');
  if (value.website !== undefined && typeof value.website !== 'string') fail(400, 'invalid_honeypot', 'Invalid request.');
  const database = db(env);
  await registered(database, document);
  secret(env, 'RATE_LIMIT_SALT');
  if (value.website?.trim()) return json({ status: 'pending' }, 202);
  const fingerprint = await sha256(JSON.stringify({ document, nickname, body, parent_id: parent }));
  const existing = await database.prepare('SELECT id, request_hash FROM comments WHERE request_id = ?').bind(value.request_id).first();
  if (existing) {
    if (existing.request_hash !== fingerprint) fail(409, 'request_conflict', 'request_id has already been used for different content.');
    return json({ id: existing.id, status: 'pending' }, 202);
  }
  if (!(await parentExists(database, parent, document))) fail(409, 'invalid_parent', 'Reply target must be an approved comment on this document.');
  const { key, now } = await rateIdentity(request, env, 'comments', 900);
  const identifier = crypto.randomUUID();
  const results = await database.batch([
    database.prepare('DELETE FROM rate_buckets WHERE expires_at < ?').bind(now - 86400),
    database.prepare(`INSERT INTO rate_buckets(key, count, expires_at)
      SELECT ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM comments WHERE request_id = ?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1
      WHERE count < 5 AND NOT EXISTS (SELECT 1 FROM comments WHERE request_id = ?) RETURNING count`)
      .bind(key, now + 900, value.request_id, value.request_id),
    database.prepare(`INSERT INTO comments(id, document, nickname, body, parent_id, request_id, request_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0 AND EXISTS (SELECT 1 FROM public_documents WHERE id = ?) AND ${validParentSQL()}
      ON CONFLICT(request_id) DO NOTHING`).bind(identifier, document, nickname, body, parent, value.request_id, fingerprint, new Date().toISOString(), document, parent, parent, document, parent, document),
    database.prepare('SELECT id, request_hash FROM comments WHERE request_id = ?').bind(value.request_id),
  ]);
  const inserted = results[3].results[0];
  if (!inserted && !results[1].results.length) fail(429, 'rate_limited', 'Too many requests. Please try later.');
  if (!inserted) fail(409, 'invalid_parent', 'Reply target is no longer available.');
  if (inserted.request_hash !== fingerprint) fail(409, 'request_conflict', 'request_id has already been used for different content.');
  return json({ id: inserted.id, status: 'pending' }, 202);
}
async function moderate(request, env, id, action) {
  if (!UUID.test(id)) fail(404, 'not_found', 'Comment not found.');
  const database = db(env);
  if (action === 'delete_leaf') {
    // Check for replies and delete this one row in the same SQLite statement.
    // A reply that wins the race blocks cleanup; a later submit revalidates its parent.
    const result = await database.prepare(`DELETE FROM comments WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM comments reply WHERE reply.parent_id = comments.id AND reply.document = comments.document)
      RETURNING id`).bind(id).all();
    if (!result.results.length) {
      if (!(await database.prepare('SELECT id FROM comments WHERE id = ?').bind(id).first())) fail(404, 'not_found', 'Comment not found.');
      fail(409, 'comment_has_replies', 'Comment has replies and was not deleted.');
    }
    return json({ id, deleted: 1 });
  }
  const comment = await database.prepare('SELECT document, parent_id FROM comments WHERE id = ?').bind(id).first();
  if (!comment) fail(404, 'not_found', 'Comment not found.');
  const now = new Date().toISOString();
  if (action === 'approve') {
    const result = await database.prepare(`UPDATE comments SET status = 'approved', moderated_at = ? WHERE id = ? AND ${validParentSQL()} RETURNING id`)
      .bind(now, id, comment.parent_id, comment.parent_id, comment.document, comment.parent_id, comment.document).all();
    if (!result.results.length) fail(409, 'invalid_parent', 'Approve the parent before approving this reply.');
    return json({ id, status: 'approved' });
  }
  const descendants = `WITH RECURSIVE descendants(id) AS (
    SELECT id FROM comments WHERE id = ? AND document = ?
    UNION ALL SELECT c.id FROM comments c JOIN descendants d ON c.parent_id = d.id WHERE c.document = ?
  ) SELECT id FROM descendants`;
  if (action === 'reject') {
    const result = await database.prepare(`UPDATE comments SET status = 'rejected', moderated_at = ? WHERE id IN (${descendants})`).bind(now, id, comment.document, comment.document).run();
    return json({ id, status: 'rejected', affected: result.meta.changes });
  }
  const result = await database.prepare(`DELETE FROM comments WHERE id IN (${descendants})`).bind(id, comment.document, comment.document).run();
  return json({ id, deleted: result.meta.changes });
}
function visitsEnabled(env) { return env.VISITS_ENABLED === true || env.VISITS_ENABLED === 'true'; }
async function visitStats(env, document = null) {
  if (!visitsEnabled(env)) return { enabled: false, seeded: false, site: null, document: null, document_id: document };
  const database = db(env);
  if (document !== null) await registered(database, document);
  const counts = await database.prepare(`SELECT b.site_base + COALESCE((SELECT count FROM visit_deltas WHERE key = 'site'), 0) AS site_total,
    CASE WHEN ? IS NULL THEN NULL ELSE (
      SELECT d.base + COALESCE(v.count, 0) FROM document_baselines d
      LEFT JOIN visit_deltas v ON v.key = 'document:' || d.document WHERE d.document = ?
    ) END AS document_total FROM visit_baselines b WHERE b.singleton = 1`).bind(document, document).first();
  if (!counts) return { enabled: true, seeded: false, site: null, document: null, document_id: document };
  if (document !== null && counts.document_total === null) fail(503, 'baseline_incomplete', 'Document baseline is unavailable.');
  return { enabled: true, seeded: true, site: counts.site_total, document: counts.document_total, document_id: document };
}
async function submitVisit(request, env) {
  if (!visitsEnabled(env)) fail(404, 'visits_disabled', 'Visits are not enabled.');
  const value = await bodyJSON(request, ['nonce', 'document']);
  const document = docID(value.document, true);
  if (typeof value.nonce !== 'string' || !REQUEST_ID.test(value.nonce)) fail(400, 'invalid_nonce', 'Supply a unique URL-safe nonce.');
  const database = db(env);
  secret(env, 'RATE_LIMIT_SALT');
  if (document !== null) await registered(database, document);
  if (!(await database.prepare('SELECT singleton FROM visit_baselines WHERE singleton = 1').first())) fail(409, 'visits_not_seeded', 'A verified baseline has not been imported.');
  const existing = await database.prepare('SELECT document FROM visit_events WHERE nonce = ?').bind(value.nonce).first();
  if (existing) {
    if (existing.document !== document) fail(409, 'nonce_conflict', 'Nonce has already been used for another document.');
    return json({ ...(await visitStats(env, document)), counted: false });
  }
  await rateLimit(request, env, 'visits', 120, 60);
  const result = await database.prepare(`INSERT INTO visit_events(nonce, document, created_at)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM visit_baselines WHERE singleton = 1)
    AND (? IS NULL OR EXISTS (SELECT 1 FROM public_documents WHERE id = ?))
    ON CONFLICT(nonce) DO NOTHING RETURNING nonce`).bind(value.nonce, document, new Date().toISOString(), document, document).all();
  const row = await database.prepare('SELECT document FROM visit_events WHERE nonce = ?').bind(value.nonce).first();
  if (!row || row.document !== document) fail(409, 'nonce_conflict', 'Nonce has already been used for another document.');
  return json({ ...(await visitStats(env, document)), counted: Boolean(result.results.length) });
}
async function importBaseline(request, env) {
  const value = await bodyJSON(request, ['confirm_cutover', 'batch_id', 'site_base', 'document_bases', 'captured_at']);
  if (value.confirm_cutover !== true) fail(400, 'cutover_confirmation_required', 'Explicit confirm_cutover: true is required.');
  if (typeof value.batch_id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(value.batch_id)) fail(400, 'invalid_batch', 'Invalid baseline batch identifier.');
  const count = number => Number.isSafeInteger(number) && number >= 0;
  if (!count(value.site_base)) fail(400, 'invalid_baseline', 'site_base must be a verified nonnegative integer.');
  if (typeof value.captured_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value.captured_at) || !Number.isFinite(Date.parse(value.captured_at))) fail(400, 'invalid_capture_date', 'Supply the baseline capture timestamp.');
  if (!Array.isArray(value.document_bases)) fail(400, 'invalid_baseline', 'document_bases must contain every registered document.');
  const bases = new Map();
  for (const entry of value.document_bases) {
    strictObject(entry, ['document', 'base']);
    const document = docID(entry.document);
    if (!count(entry.base) || bases.has(document)) fail(400, 'invalid_baseline', 'Baseline counts must be nonnegative, unique integers.');
    bases.set(document, entry.base);
  }
  const database = db(env);
  const registeredIDs = (await database.prepare('SELECT id FROM public_documents ORDER BY id').all()).results.map(row => row.id);
  if (!registeredIDs.length || registeredIDs.length !== bases.size || registeredIDs.some(id => !bases.has(id))) fail(400, 'incomplete_baseline', 'The baseline must exactly cover all registered public documents.');
  const canonical = { batch_id: value.batch_id, captured_at: value.captured_at, site_base: value.site_base, document_bases: [...bases].sort(([a], [b]) => a.localeCompare(b)).map(([document, base]) => ({ document, base })) };
  const fingerprint = await sha256(JSON.stringify(canonical));
  const statements = [database.prepare(`INSERT INTO visit_baselines(singleton, batch_id, manifest_hash, site_base, captured_at, imported_at)
    SELECT 1, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM visit_events) AND NOT EXISTS (SELECT 1 FROM visit_deltas WHERE count <> 0)
    ON CONFLICT(singleton) DO NOTHING`).bind(value.batch_id, fingerprint, value.site_base, value.captured_at, new Date().toISOString())];
  statements.push(database.prepare(`INSERT INTO document_baselines(document, base)
    SELECT json_extract(value, '$.document'), json_extract(value, '$.base') FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM visit_baselines WHERE singleton = 1 AND batch_id = ? AND manifest_hash = ?)
    ON CONFLICT(document) DO NOTHING`).bind(JSON.stringify(canonical.document_bases), value.batch_id, fingerprint));
  const results = await database.batch(statements);
  const actual = await database.prepare('SELECT batch_id, manifest_hash FROM visit_baselines WHERE singleton = 1').first();
  if (!actual || actual.batch_id !== value.batch_id || actual.manifest_hash !== fingerprint) fail(409, 'baseline_exists', 'A different baseline already exists; overwriting it is forbidden.');
  return json({ batch_id: value.batch_id, imported: results[0].meta.changes === 1, documents: bases.size, visits_enabled: visitsEnabled(env) });
}

async function route(request, env, url) {
  if (url.pathname === '/admin' && request.method === 'GET') return adminPage();
  if (url.pathname === '/v1/comments') {
    if (request.method === 'GET') return listComments(url, env);
    if (request.method === 'POST') return submitComment(request, env);
  }
  if (url.pathname === '/v1/visits') {
    if (request.method === 'GET') return json(await visitStats(env, docID(url.searchParams.get('document'), true)));
    if (request.method === 'POST') return submitVisit(request, env);
  }
  if (url.pathname.startsWith('/v1/admin/')) {
    await authorized(request, env);
    if (url.pathname === '/v1/admin/comments' && request.method === 'GET') return listComments(url, env, true);
    const moderation = /^\/v1\/admin\/comments\/([^/]+)(?:\/(approve|reject))?$/.exec(url.pathname);
    if (moderation && request.method === 'POST' && moderation[2]) return moderate(request, env, moderation[1], moderation[2]);
    if (moderation && request.method === 'DELETE' && !moderation[2]) {
      const condition = url.searchParams.getAll('only_if_no_replies');
      if (condition.length > 1 || (condition.length === 1 && condition[0] !== 'true')) fail(400, 'invalid_delete_condition', 'only_if_no_replies must be true when supplied.');
      return moderate(request, env, moderation[1], condition.length ? 'delete_leaf' : 'delete');
    }
    if (url.pathname === '/v1/admin/visits/baseline' && request.method === 'POST') return importBaseline(request, env);
  }
  fail(404, 'not_found', 'Endpoint not found.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let response, origin = null;
    try {
      origin = corsOrigin(request, env, url);
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await route(request, env, url);
    } catch (error) {
      response = error instanceof APIError ? json({ error: error.code, message: error.message }, error.status) : json({ error: 'internal_error', message: 'The request could not be completed.' }, 500);
    }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Vary', 'Origin');
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      headers.set('Access-Control-Max-Age', '600');
    }
    if (response.status === 429) headers.set('Retry-After', '900');
    return new Response(response.body, { status: response.status, headers });
  },
};
