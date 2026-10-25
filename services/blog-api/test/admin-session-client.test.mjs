import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ADMIN_SESSION_HELPERS } from '../src/admin-session-client.mjs';

const base = 'https://comments.example.test';
const key = 'xht37.admin.session.v1:' + base;
const password = 'fictional-password-not-a-real-secret';
const token = 'bs_' + 'a'.repeat(64), nextToken = 'bs_' + 'b'.repeat(64);
const start = Date.parse('2026-10-26T00:00:00Z');
const expiry = new Date(start + 30 * 86400000).toISOString();
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ storage = new Map(), respond, blockedStorage = false } = {}) {
  let now = start, invalidated = 0, timerId = 0;
  const calls = [], writes = [], events = {}, timers = new Map();
  class Clock extends Date { static now() { return now; } }
  const window = {
    addEventListener(type, handler) { (events[type] ||= []).push(handler); },
    setTimeout(handler, delay) { const id = ++timerId; timers.set(id, { handler, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  Object.defineProperty(window, 'localStorage', { get() {
    if (blockedStorage) throw Error('Storage unavailable');
    return {
      getItem: name => storage.get(name) ?? null,
      setItem(name, value) { writes.push({ name, value }); storage.set(name, value); },
      removeItem: name => storage.delete(name),
    };
  } });
  const context = { window, Date: Clock, AbortController, fetch: async (url, options) => {
    calls.push({ url, options });
    const value = respond ? await respond(url, options) : url.endsWith('/login')
      ? { authenticated: true, token, expires_at: expiry }
      : options.method === 'DELETE' ? { logged_out: true }
      : url.endsWith('/session') ? { authenticated: true, expires_at: expiry } : { ok: true };
    return { ok: !value.httpStatus || value.httpStatus < 400, status: value.httpStatus || 200, json: async () => value };
  } };
  const create = vm.runInNewContext(ADMIN_SESSION_HELPERS + '\ncreateAdminSession;', context);
  const auth = create(base, () => invalidated++);
  return { auth, storage, calls, writes, timers, invalidated: () => invalidated,
    advance(ms) { now += ms; },
    async fire(event) { for (const handler of events.storage || []) await handler(event); await settle(); },
  };
}

test('the password is sent only to login; local persistence contains a revocable token and absolute expiry', async () => {
  const f = fixture();
  assert.equal(await f.auth.login(password), true);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { username: 'admin', password });
  assert.equal(f.calls[0].options.headers.Authorization, undefined);
  assert.equal(f.calls[0].url, base + '/v1/admin/login');
  assert.deepEqual(JSON.parse(f.storage.get(key)), { token, expires_at: expiry });
  assert.equal(f.writes.length, 1); assert.ok(!f.writes[0].value.includes(password));
  await f.auth.request('/v1/admin/articles/46', 'POST', { source: 'public source', sha: 'a'.repeat(40), request_id: 'fictional' });
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer ' + token);
  assert.ok(!f.calls[1].options.body.includes(password));
  for (const { url, options } of f.calls) {
    assert.ok(!url.includes(password) && !url.includes(token));
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(f.timers.size, 0, 'Every request releases its bounded timeout');
});

test('all page types restore the same session without sending or saving the password again', async () => {
  const storage = new Map(), first = fixture({ storage }); await first.auth.login(password);
  first.auth.clearMemory();
  assert.equal(storage.has(key), true); assert.equal(first.auth.hasSession(), false);
  assert.equal(first.calls.length, 1, 'Leaving a page must not revoke a persistent session');
  const second = fixture({ storage });
  assert.equal(await second.auth.restore(), true);
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0].url, base + '/v1/admin/session');
  assert.equal(second.calls[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(second.calls[0].options.body, undefined);
  assert.equal(second.auth.hasSession(), true);
});

test('absolute expiration clears the browser session and blocks requests before another network call', async () => {
  const f = fixture(); await f.auth.login(password);
  f.advance(30 * 86400000);
  assert.equal(f.auth.hasSession(), false);
  assert.equal(f.storage.size, 0); assert.equal(f.invalidated(), 1);
  await assert.rejects(f.auth.request('/v1/admin/comments'), error => error.status === 401);
  assert.equal(f.calls.length, 1);
  const old = new Map([[key, JSON.stringify({ token, expires_at: new Date(start - 1).toISOString() })]]);
  const expired = fixture({ storage: old });
  assert.equal(await expired.auth.restore(), false); assert.equal(expired.calls.length, 0); assert.equal(old.size, 0);
});

test('401 invalidates the accepted session but network failures keep a potentially valid saved login', async () => {
  let rejected = false;
  const f = fixture({ respond: (url) => url.endsWith('/login') ? { token, expires_at: expiry }
    : rejected ? { httpStatus: 401 } : { ok: true } });
  await f.auth.login(password); rejected = true;
  await assert.rejects(f.auth.request('/v1/admin/comments'), error => error.status === 401);
  assert.equal(f.auth.hasSession(), false); assert.equal(f.storage.size, 0); assert.equal(f.invalidated(), 1);
  const storage = new Map([[key, JSON.stringify({ token, expires_at: expiry })]]);
  const offline = fixture({ storage, respond: () => { throw Error('offline'); } });
  await assert.rejects(offline.auth.restore(), /offline/);
  assert.equal(storage.has(key), true);
});

test('a shared logout clears active peer pages and a late restore cannot recreate it', async () => {
  const storage = new Map([[key, JSON.stringify({ token, expires_at: expiry })]]);
  let finish;
  const restoring = fixture({ storage, respond: () => new Promise(resolve => { finish = resolve; }) });
  const pending = restoring.auth.restore();
  storage.delete(key); await restoring.fire({ key });
  finish({ authenticated: true, expires_at: expiry });
  assert.equal(await pending, false); assert.equal(storage.size, 0); assert.equal(restoring.auth.hasSession(), false);
  const active = fixture({ storage }); await active.auth.login(password);
  storage.delete(key); await active.fire({ key });
  assert.equal(active.invalidated(), 1); assert.equal(active.auth.hasSession(), false);
});

test('a restore cannot overwrite a newer session even before a storage event is delivered', async () => {
  const storage = new Map([[key, JSON.stringify({ token, expires_at: expiry })]]);
  let finish;
  const f = fixture({ storage, respond: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.auth.restore();
  storage.set(key, JSON.stringify({ token: nextToken, expires_at: expiry }));
  finish({ authenticated: true, expires_at: expiry });
  assert.equal(await pending, false);
  assert.equal(JSON.parse(storage.get(key)).token, nextToken);
});

test('late login after local exit is discarded and the newly issued session is revoked', async () => {
  let finish;
  const f = fixture({ respond: (url, options) => options.method === 'DELETE' ? { logged_out: true }
    : new Promise(resolve => { finish = resolve; }) });
  const pending = f.auth.login(password);
  assert.equal(await f.auth.logout(), true);
  finish({ token, expires_at: expiry });
  assert.equal(await pending, false); await settle();
  assert.equal(f.storage.size, 0); assert.equal(f.auth.hasSession(), false);
  assert.equal(f.calls.at(-1).options.method, 'DELETE');
  assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer ' + token);
});

test('an old in-flight 401 cannot invalidate a successful replacement login', async () => {
  let issue = 0, finish;
  const f = fixture({ respond: (url, options) => url.endsWith('/login') ? { token: ++issue === 1 ? token : nextToken, expires_at: expiry }
    : options.method === 'DELETE' ? { logged_out: true } : new Promise(resolve => { finish = resolve; }) });
  await f.auth.login(password);
  const oldRequest = f.auth.request('/v1/admin/comments');
  await f.auth.login(password);
  finish({ httpStatus: 401 });
  await assert.rejects(oldRequest, error => error.status === 401);
  assert.equal(f.auth.hasSession(), true); assert.equal(f.invalidated(), 0);
  assert.equal(JSON.parse(f.storage.get(key)).token, nextToken);
  assert.ok(f.calls.some(row => row.options.method === 'DELETE' && row.options.headers.Authorization === 'Bearer ' + token));
});

test('logout revokes both remembered and active tokens, and reports a failed remote revoke', async () => {
  const f = fixture(); await f.auth.login(password);
  f.storage.set(key, JSON.stringify({ token: nextToken, expires_at: expiry }));
  assert.equal(await f.auth.logout(), true);
  const headers = f.calls.filter(row => row.options.method === 'DELETE').map(row => row.options.headers.Authorization).sort();
  assert.deepEqual(headers, ['Bearer ' + token, 'Bearer ' + nextToken].sort());
  assert.equal(f.auth.hasSession(), false); assert.equal(f.storage.size, 0);
  const offline = fixture({ respond: (url, options) => { if (options.method === 'DELETE') throw Error('offline'); return { token, expires_at: expiry }; } });
  await offline.auth.login(password);
  assert.equal(await offline.auth.logout(), false); assert.equal(offline.storage.size, 0); assert.equal(offline.auth.hasSession(), false);
});

test('invalid server credentials are never persisted and unavailable browser storage still permits current-page use', async () => {
  for (const value of [{ token: password, expires_at: expiry }, { token, expires_at: 'invalid' }, { token, expires_at: new Date(start).toISOString() }]) {
    const f = fixture({ respond: () => value });
    await assert.rejects(f.auth.login(password), /登录响应不完整/);
    assert.equal(f.storage.size, 0); assert.equal(f.auth.hasSession(), false);
  }
  const restricted = fixture({ blockedStorage: true });
  assert.equal(await restricted.auth.restore(), false);
  assert.equal(await restricted.auth.login(password), true);
  assert.equal(restricted.auth.hasSession(), true);
  await restricted.auth.request('/v1/admin/comments');
  assert.equal(await restricted.auth.logout(), true);
});
