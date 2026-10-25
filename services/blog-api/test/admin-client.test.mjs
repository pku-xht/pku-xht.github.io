import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ADMIN_SCRIPT } from '../src/admin-client.mjs';
import { staticAdminAssets, adminPage } from '../src/admin.mjs';

const api = 'https://comments.example.test';
const password = 'fictional-admin-password-not-a-real-secret-123456';
const sessionToken = 'bs_' + 'a'.repeat(64);
const sessionKey = base => 'xht37.admin.session.v1:' + base;
const expiresAt = () => new Date(Date.now() + 30 * 86400000).toISOString();
const settle = () => new Promise(resolve => setImmediate(resolve));
const comment = (id = 'first', status = 'pending') => ({
  id, status, nickname: '<img src=x onerror=alert(1)>', document: '46',
  body: '<script>untrusted</script>', parent_id: null, created_at: '2026-10-25T00:00:00Z',
});
const list = (comments = [], next_cursor = null, counts) => ({
  comments, next_cursor,
  counts: counts || { all: comments.length, pending: comments.filter(row => row.status === 'pending').length,
    approved: comments.filter(row => row.status === 'approved').length, rejected: comments.filter(row => row.status === 'rejected').length },
  documents: [{ id: '46', title: '<script>标题</script>', url: '/blog/posts/46/' }, { id: '215', title: '页面', url: '/blog/pages/215/' }],
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.listeners = {}; this.dataset = {};
    this.value = ''; this.disabled = false; this.hidden = false; this.textContent = '';
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async dispatch(type) {
    if (type === 'click' && this.disabled) return;
    for (const handler of this.listeners[type] || []) await handler({ preventDefault() {} });
    await settle();
  }
  set innerHTML(_) { throw Error('HTML injection attempted'); }
}
function fixture({ base = api, enabled = true, foreignFrame = false, respond = () => list(),
  loginRespond = () => ({ authenticated: true, token: sessionToken, expires_at: expiresAt(), article_editing: true }),
  sessionRespond = () => ({ authenticated: true, expires_at: expiresAt(), article_editing: true }),
  logoutRespond = () => ({ logged_out: true }), confirm = () => true, script = ADMIN_SCRIPT,
  passwordManager = true, declinePassword = false, storage = new Map(), blockedStorage = false } = {}) {
  const ids = ['login-form', 'management', 'username', 'token', 'status', 'document-filter', 'search',
    'summary', 'loaded-count', 'empty-state', 'load', 'refresh', 'logout', 'more', 'message', 'comments'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  elements.status.value = 'all'; elements.more.hidden = true; elements.management.hidden = true;
  for (const id of ['token', 'username', 'load', 'refresh', 'logout', 'more', 'status', 'search', 'document-filter']) elements[id].disabled = true;
  elements.username.value = 'admin';
  const document = {
    body: { dataset: { adminApi: base, adminEnabled: String(enabled) } },
    getElementById: id => elements[id], createElement: tag => new Element(tag),
  };
  Object.defineProperty(document, 'cookie', { get() { throw Error('Cookie access attempted'); }, set() { throw Error('Cookie write attempted'); } });
  const events = {}, calls = [], savedPasswords = [], writes = [], timers = new Map();
  let timerId = 0;
  const window = {
    location: { origin: 'https://pku-xht.github.io', search: '?api=https://evil.example&token=not-accepted' },
    addEventListener(type, handler) { (events[type] ||= []).push(handler); }, confirm,
    setTimeout(handler, delay) { const id = ++timerId; timers.set(id, { handler, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  window.top = foreignFrame ? { location: { origin: 'https://evil.example' } } : window;
  Object.defineProperty(window, 'localStorage', { get() {
    if (blockedStorage) throw Error('Storage disabled');
    return {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) { writes.push({ key, value }); storage.set(key, value); },
      removeItem: key => storage.delete(key),
    };
  } });
  Object.defineProperty(window, 'sessionStorage', { get() { throw Error('Unexpected sessionStorage access'); } });
  const context = { document, window, AbortController, encodeURIComponent, fetch: async (url, options) => {
    calls.push({ url, options });
    const handler = url === base + '/v1/admin/login' ? loginRespond
      : url === base + '/v1/admin/session' ? (options.method === 'DELETE' ? logoutRespond : sessionRespond) : respond;
    const data = await handler(url, options);
    return { ok: !data.httpStatus || data.httpStatus < 400, status: data.httpStatus || 200, json: async () => data };
  } };
  if (passwordManager) {
    context.PasswordCredential = class { constructor(value) { Object.assign(this, value); } };
    context.navigator = { credentials: { async store(value) {
      savedPasswords.push(value);
      if (declinePassword) throw Error('Browser declined saving');
    } } };
  }
  vm.runInNewContext(script, context);
  return {
    elements, calls, savedPasswords, storage, writes, timers,
    ready: settle,
    async login() { await settle(); elements.token.value = '  ' + password + '  '; await elements['login-form'].dispatch('submit'); },
    async fire(type, event = {}) { for (const handler of events[type] || []) await handler(event); await settle(); },
    async flush(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, 'Expected scheduled callback at ' + delay + 'ms');
      timers.delete(entry[0]); await entry[1].handler(); await settle();
    },
  };
}

test('login exchanges the original password for a persisted session and renders all comments as text', async () => {
  const f = fixture({ respond: () => list([comment()]) });
  await f.ready();
  assert.equal(f.calls.length, 0);
  await f.login();
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { username: 'admin', password });
  assert.equal(f.calls[0].url, api + '/v1/admin/login');
  assert.equal(f.calls[0].options.headers.Authorization, undefined);
  assert.equal(f.calls[1].url, api + '/v1/admin/comments?status=all');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer ' + sessionToken);
  for (const { url, options } of f.calls) {
    assert.ok(!url.includes(password) && !url.includes(sessionToken));
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  }
  assert.equal(f.elements.token.value, '');
  assert.equal(f.elements['login-form'].hidden, true);
  assert.equal(f.elements.management.hidden, false);
  assert.equal(f.elements.summary.textContent, '全部 1 · 待审核 1 · 已公开 0 · 已拒绝 0');
  const article = f.elements.comments.children[0];
  assert.equal(article.children[0].children[0].textContent, comment().nickname);
  assert.equal(article.children[0].children[1].textContent, '待审核');
  assert.equal(article.children[2].textContent, comment().body);
  assert.equal(article.children[1].children.at(-1).href, '/blog/posts/46/');
  assert.equal(article.children[1].children.at(-1).textContent, '<script>标题</script>');
  const stored = JSON.parse(f.storage.get(sessionKey(api)));
  assert.deepEqual(Object.keys(stored).sort(), ['expires_at', 'token']);
  assert.equal(stored.token, sessionToken);
  assert.ok(f.writes.every(row => !row.value.includes(password)));
});

test('all comments paginate and status, article and global search filters reset the cursor', async () => {
  const calls = [];
  const f = fixture({ respond: url => {
    calls.push(url);
    return list([comment(String(calls.length))], calls.length === 1 ? 91 : null, { all: 120, pending: 20, approved: 99, rejected: 1 });
  } });
  await f.login();
  assert.equal(f.elements.more.hidden, false);
  await f.elements.more.dispatch('click');
  assert.equal(calls[1], api + '/v1/admin/comments?status=all&cursor=91');
  assert.equal(f.elements.comments.children.length, 2);
  assert.equal(f.elements['loaded-count'].textContent, '已显示 2 / 120 条');
  f.elements.status.value = 'approved';
  await f.elements.status.dispatch('change');
  assert.equal(calls.at(-1), api + '/v1/admin/comments?status=approved');
  assert.equal(f.elements.comments.children.length, 1);
  f.elements['document-filter'].value = '46';
  await f.elements['document-filter'].dispatch('change');
  assert.equal(calls.at(-1), api + '/v1/admin/comments?status=approved&document=46');
  f.elements.search.value = '昵称 & 公式';
  await f.elements.search.dispatch('input');
  await f.flush(300);
  assert.equal(calls.at(-1), api + '/v1/admin/comments?status=approved&document=46&q=' + encodeURIComponent('昵称 & 公式'));
});

test('a slow earlier filter cannot replace the latest comment view', async () => {
  let finish;
  const f = fixture({ respond: url => url.endsWith('status=all')
    ? new Promise(resolve => { finish = resolve; }) : list([comment('latest', 'approved')]) });
  const firstLoad = f.login(); await settle(); await settle();
  assert.equal(typeof finish, 'function');
  f.elements.status.value = 'approved'; await f.elements.status.dispatch('change');
  assert.equal(f.elements.comments.children[0].dataset.commentId, 'latest');
  finish(list([comment('outdated')])); await firstLoad;
  assert.equal(f.elements.comments.children.length, 1);
  assert.equal(f.elements.comments.children[0].dataset.commentId, 'latest');
  assert.equal(f.elements['loaded-count'].textContent, '已显示 1 / 1 条');
});

test('moderation refreshes all-state rows and descendants while delete still requires confirmation', async () => {
  let allowDelete = false, current = [comment('parent'), { ...comment('child'), parent_id: 'parent' }];
  const f = fixture({ respond: (url, options) => {
    if (options.method === 'GET') return list(current);
    if (url.endsWith('/approve')) current[0].status = 'approved';
    else if (url.endsWith('/reject')) current = current.map(row => ({ ...row, status: 'rejected' }));
    else if (options.method === 'DELETE') current = [];
    return { status: current[0]?.status || 'deleted' };
  }, confirm: () => allowDelete });
  await f.login();
  await f.elements.comments.children[0].children[3].children[0].dispatch('click');
  assert.equal(f.elements.comments.children.length, 2, 'Approved rows remain in the all-state view');
  assert.equal(f.elements.comments.children[0].children[0].children[1].textContent, '已公开');
  await f.elements.comments.children[0].children[3].children[1].dispatch('click');
  assert.ok(f.elements.comments.children.every(row => row.dataset.state === 'rejected'));
  const before = f.calls.length;
  await f.elements.comments.children[0].children[3].children[2].dispatch('click');
  assert.equal(f.calls.length, before);
  allowDelete = true;
  await f.elements.comments.children[0].children[3].children[2].dispatch('click');
  assert.ok(f.calls.some(row => row.options.method === 'DELETE' && row.url.endsWith('/comments/parent')));
  assert.equal(f.elements.comments.children.length, 0);
  assert.equal(f.elements['empty-state'].hidden, false);
});

test('a new page restores the session and a page exit never revokes the shared login', async () => {
  const storage = new Map();
  const first = fixture({ storage, respond: () => list([comment()]) });
  await first.login(); await first.fire('pagehide');
  assert.equal(first.elements.comments.children.length, 0);
  assert.equal(first.calls.some(row => row.options.method === 'DELETE'), false);
  assert.equal(storage.has(sessionKey(api)), true);
  const second = fixture({ storage, respond: () => list([comment()]) });
  await second.ready();
  assert.equal(second.calls[0].url, api + '/v1/admin/session');
  assert.equal(second.calls[0].options.headers.Authorization, 'Bearer ' + sessionToken);
  assert.equal(second.elements.management.hidden, false);
  assert.equal(second.savedPasswords.length, 0);
});

test('logout revokes the session, removes saved access and clears another tab on a storage event', async () => {
  const storage = new Map(), first = fixture({ storage, respond: () => list([comment()]) });
  await first.login();
  const second = fixture({ storage, respond: () => list([comment()]) }); await second.ready();
  await first.elements.logout.dispatch('click');
  assert.equal(storage.size, 0);
  const logout = first.calls.find(row => row.options.method === 'DELETE');
  assert.equal(logout.url, api + '/v1/admin/session');
  assert.equal(logout.options.headers.Authorization, 'Bearer ' + sessionToken);
  assert.equal(first.elements.message.textContent, '已退出登录。');
  await second.fire('storage', { key: sessionKey(api) });
  assert.equal(second.elements.comments.children.length, 0);
  assert.equal(second.elements.management.hidden, true);
  assert.equal(second.elements['login-form'].hidden, false);
});

test('late private responses cannot restore data after logout or pagehide', async () => {
  for (const leave of [false, true]) {
    let finish;
    const f = fixture({ respond: () => new Promise(resolve => { finish = resolve; }) });
    const login = f.login(); await settle(); await settle();
    assert.equal(typeof finish, 'function');
    if (leave) await f.fire('pagehide'); else await f.elements.logout.dispatch('click');
    finish(list([comment()], 100)); await login;
    assert.equal(f.elements.comments.children.length, 0);
    assert.equal(f.elements.more.hidden, true);
    assert.equal(f.elements.token.value, '');
  }
});

test('disabled and foreign-framed pages make no authentication or storage requests', async () => {
  for (const options of [{ enabled: false, base: '' }, { foreignFrame: true }]) {
    const f = fixture({ ...options, blockedStorage: true });
    await f.login();
    assert.equal(f.elements.token.disabled, true); assert.equal(f.elements.load.disabled, true);
    assert.equal(f.calls.length, 0); assert.equal(f.savedPasswords.length, 0);
    assert.match(f.elements.message.textContent, /尚未配置|直接打开/);
  }
});

test('only a successful password exchange offers browser password saving and storage support is optional', async () => {
  const success = fixture(); await success.login();
  assert.equal(success.savedPasswords.length, 1);
  assert.equal(success.savedPasswords[0].id, 'admin');
  assert.equal(success.savedPasswords[0].password, password);
  await success.elements.refresh.dispatch('click');
  assert.equal(success.savedPasswords.length, 1);
  const failed = fixture({ loginRespond: () => ({ httpStatus: 401, error: 'unauthorized' }) });
  await failed.login();
  assert.equal(failed.savedPasswords.length, 0); assert.equal(failed.storage.size, 0);
  assert.equal(failed.elements.management.hidden, true); assert.equal(failed.elements.token.value, '');
  assert.match(failed.elements.message.textContent, /密码不正确/);
  for (const options of [{ passwordManager: false }, { declinePassword: true }, { blockedStorage: true }]) {
    const f = fixture(options); await f.login();
    assert.equal(f.elements.management.hidden, false, 'Storage and password-manager preferences must not prevent current-page use');
  }
});

test('401 clears private data and saved session while a failed revoke is reported honestly', async () => {
  let expired = false;
  const f = fixture({ respond: () => expired ? { httpStatus: 401 } : list([comment()]) });
  await f.login(); expired = true; await f.elements.refresh.dispatch('click');
  assert.equal(f.elements.comments.children.length, 0); assert.equal(f.storage.size, 0);
  assert.equal(f.elements.management.hidden, true); assert.equal(f.savedPasswords.length, 1);
  const offline = fixture({ logoutRespond: () => { throw Error('offline'); } }); await offline.login();
  await offline.elements.logout.dispatch('click');
  assert.equal(offline.storage.size, 0);
  assert.match(offline.elements.message.textContent, /本机退出.*暂未确认服务器撤销/);
});

test('static and Worker pages preserve fixed endpoint configuration, standard forms and CSP', async () => {
  const assets = staticAdminAssets(api + '/');
  assert.match(assets.html, /data-admin-api="https:\/\/comments\.example\.test"/);
  assert.match(assets.html, /http-equiv="Content-Security-Policy"/);
  assert.match(assets.html, /connect-src https:\/\/comments\.example\.test/);
  assert.match(assets.html, /name="robots" content="noindex,nofollow"/);
  assert.match(assets.html, /name="referrer" content="no-referrer"/);
  assert.match(assets.html, /<form id="login-form"[^>]*method="post" autocomplete="on">/);
  assert.match(assets.html, /name="username"[^>]+autocomplete="username"/);
  assert.match(assets.html, /name="password" type="password" autocomplete="current-password"/);
  assert.match(assets.html, /id="load"[^>]*type="submit"/);
  assert.match(assets.html, /<option value="all">全部评论<\/option>/);
  assert.ok(!assets.html.includes('<iframe') && !assets.html.includes('http-equiv="refresh"'));
  const worker = adminPage(), html = await worker.text();
  assert.match(worker.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(worker.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  assert.ok(html.includes(assets.script));
  assert.match(html, /data-admin-api="" data-admin-enabled="true"/);
  assert.match(staticAdminAssets('').html, /data-admin-enabled="false"/);
});

test('renderer rejects untrusted fixed endpoints and non-public configuration input', () => {
  for (const value of ['http://public.example', 'javascript:alert(1)', 'https://u:p@example.test',
    'https://example.test?api=evil', 'https://example.test/#token', 'https://example.test/ bad', null]) assert.throws(() => staticAdminAssets(value));
  assert.match(staticAdminAssets('http://127.0.0.1:8787').html, /data-admin-enabled="true"/);
  const renderer = fileURLToPath(new URL('../../../tools/render_comment_admin.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [renderer], { input: JSON.stringify({ api_base: api }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['html', 'script', 'style']);
  assert.ok(!result.stdout.includes(password));
  const rejected = spawnSync(process.execPath, [renderer], { input: JSON.stringify({ api_base: api, password }), encoding: 'utf8' });
  assert.notEqual(rejected.status, 0); assert.ok(!rejected.stderr.includes(password));
});

test('keepNames esbuild Worker bundle embeds the complete standalone session client', async context => {
  let esbuildPath = process.env.BLOG_ESBUILD_MODULE;
  if (!esbuildPath) {
    try { esbuildPath = createRequire(import.meta.url).resolve('esbuild'); }
    catch { context.skip('Set BLOG_ESBUILD_MODULE to Wrangler node_modules/esbuild/lib/main.js to run the packaging regression.'); return; }
  }
  const esbuild = await import(pathToFileURL(esbuildPath).href);
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    keepNames: true, logLevel: 'silent',
  });
  const bundled = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'));
  const response = await bundled.default.fetch(new Request('https://comments.example.test/admin'), {});
  assert.equal(response.status, 200);
  const scripts = [...(await response.text()).matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.deepEqual(scripts, [ADMIN_SCRIPT]);
  const f = fixture({ base: '', script: scripts[0], respond: () => list([comment()]) }); await f.login();
  assert.equal(f.calls[0].url, '/v1/admin/login');
  assert.equal(f.calls[1].url, '/v1/admin/comments?status=all');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer ' + sessionToken);
  assert.equal(f.elements.comments.children.length, 1);
});
