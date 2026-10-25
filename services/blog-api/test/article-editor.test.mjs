import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EDITOR_SCRIPT, staticArticleEditorAssets } from '../src/article-editor.mjs';

const api = 'https://editor.example.test';
const password = 'fictional-editor-password-not-a-real-secret-123456';
const sessionToken = 'bs_' + 'c'.repeat(64);
const sessionKey = 'xht37.admin.session.v1:' + api;
const sessionResult = () => ({ authenticated: true, token: sessionToken, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), article_editing: true });
const sha = 'a'.repeat(40), revision = 'b'.repeat(40);
const initialSource = '---\nid: 46\ntitle: 文章\n---\n\n原正文 $x_i$\n';
const editedSource = initialSource + '\n修改正文与代码 `a < b`。\n';
const endpoint = '/v1/admin/articles/46';
const loaded = () => ({ document: '46', source: initialSource, sha });
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor() {
    this.listeners = {}; this.value = ''; this.textContent = '';
    this.disabled = true; this.hidden = false; this.readOnly = false;
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async dispatch(type, event = {}) {
    event.preventDefault ||= () => { event.prevented = true; };
    for (const handler of this.listeners[type] || []) await handler(event);
    await settle();
    return event;
  }
  removeAttribute(name) { delete this[name]; }
  set innerHTML(_) { throw Error('HTML injection attempted'); }
}

function fixture({ base = api, documentId = '46', foreignFrame = false,
  respond = (url, options) => options.method === 'POST' ? { revision } : url.includes('/publication?') ? { state: 'pending' } : loaded(),
  confirm = () => true, passwordManager = true, storage = new Map(), storageUnavailable = false,
  loginRespond = () => sessionResult(), sessionRespond = () => sessionResult(), clock = { now: Date.now() } } = {}) {
  const elements = Object.fromEntries(['source', 'editor', 'save', 'reload', 'revision', 'details', 'token', 'username', 'load', 'logout', 'login-form', 'message'].map(id => [id, new Element()]));
  elements.editor.hidden = true; elements.details.hidden = true; elements.username.value = 'admin';
  const documentEvents = {}, events = {}, calls = [], savedPasswords = [], timers = new Map();
  let timerId = 0, requestId = 0;
  const document = {
    body: { dataset: { editorApi: base, documentId } },
    getElementById: id => elements[id],
    addEventListener(type, handler) { documentEvents[type] = handler; },
  };
  Object.defineProperty(document, 'cookie', { get() { throw Error('Cookie access attempted'); }, set() { throw Error('Cookie write attempted'); } });
  const window = {
    location: { origin: 'https://pku-xht.github.io', search: '?api=https://evil.example&password=ignored' },
    addEventListener(type, handler) { events[type] = handler; },
    confirm,
    setTimeout(handler, delay) { const id = ++timerId; timers.set(id, { handler, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    crypto: { randomUUID() { return '00000000-0000-4000-8000-' + String(++requestId).padStart(12, '0'); } },
  };
  Object.defineProperty(window, 'localStorage', { get() {
    if (storageUnavailable) throw Error('Storage unavailable');
    return { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  } });
  window.top = foreignFrame ? { location: { origin: 'https://evil.example' } } : window;
  const context = {
    document, window, AbortController, encodeURIComponent, Date: class extends Date { static now() { return clock.now; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const data = await (url === base + '/v1/admin/login' ? loginRespond(url, options)
        : url === base + '/v1/admin/session' ? (options.method === 'DELETE' ? { logged_out: true } : sessionRespond(url, options))
          : respond(url, options));
      return { ok: !data.httpStatus || data.httpStatus < 400, status: data.httpStatus || 200, json: async () => data };
    },
  };
  if (passwordManager) {
    context.PasswordCredential = class { constructor(value) { Object.assign(this, value); } };
    context.navigator = { credentials: { async store(value) { savedPasswords.push(value); } } };
  }
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(context, key, { get() { throw Error('Persistent credential storage attempted'); } });
  vm.runInNewContext(EDITOR_SCRIPT, context);
  return {
    elements, calls, events, documentEvents, timers, savedPasswords, storage, clock,
    get articleCalls() { return calls.filter(call => call.url.startsWith(base + '/v1/admin/articles/')); },
    async ready() { await settle(); },
    async login() { await settle(); elements.token.value = password; await elements['login-form'].dispatch('submit'); },
    async save() { await elements.save.dispatch('click'); },
    async poll() {
      const scheduled = [...timers].find(([, value]) => value.delay === 5000);
      assert.ok(scheduled, 'Expected a bounded publication-status retry');
      timers.delete(scheduled[0]); scheduled[1].handler(); await settle();
    },
  };
}

test('renderer creates one escaped exit route per registered post or page with a fixed API and password form', () => {
  const title = '<script>"quoted" & unsafe</script>';
  const assets = staticArticleEditorAssets(api + '/', [{ id: 46, path: '/blog/posts/46/', title }, { id: '215', path: '/blog/pages/215/', title: '关于我' }]);
  assert.deepEqual(assets.pages.map(row => row.path), ['/blog/posts/46/exit/', '/blog/pages/215/exit/']);
  assert.equal(assets.script, EDITOR_SCRIPT);
  const html = assets.pages[0].html;
  assert.match(html, /data-editor-api="https:\/\/editor\.example\.test" data-document-id="46"/);
  assert.ok(html.includes('&lt;script&gt;&quot;quoted&quot; &amp; unsafe&lt;/script&gt;'));
  assert.ok(!html.includes('<script>"quoted"') && !html.includes(initialSource) && !html.includes(password));
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.ok(html.includes("default-src 'none'; script-src 'self'; style-src 'self'; connect-src https://editor.example.test; base-uri 'none'; form-action 'none'"));
  assert.match(html, /name="username"[^>]+autocomplete="username"/);
  assert.match(html, /name="password" type="password" autocomplete="current-password"/);
  assert.match(html, /<form id="login-form"[^>]* method="post" autocomplete="on">/);
  assert.match(html, /href="\/blog\/posts\/46\/"/);
});

test('renderer rejects untrusted API configuration, duplicate documents and arbitrary exit paths', () => {
  const row = { id: '46', path: '/blog/posts/46/', title: '文章' };
  for (const base of ['http://public.example', 'javascript:alert(1)', 'https://name:secret@example.test', 'https://example.test?api=evil', 'https://example.test/#token', 'https://example.test/ bad', null]) {
    assert.throws(() => staticArticleEditorAssets(base, [row]));
  }
  for (const documents of [[row, row], [{ ...row, id: '0' }], [{ ...row, path: '/blog/posts/47/' }], [{ ...row, path: '/outside/46/' }], [{ ...row, path: '/blog/posts/46/../' }], [{ ...row, title: null }], [{ ...row, password }], null]) {
    assert.throws(() => staticArticleEditorAssets(api, documents));
  }
  assert.match(staticArticleEditorAssets('http://127.0.0.1:8787', [row]).pages[0].html, /connect-src http:\/\/127\.0\.0\.1:8787/);
  const renderer = fileURLToPath(new URL('../../../tools/render_article_editor.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [renderer], { input: JSON.stringify({ api_base: api, documents: [row] }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).pages[0].path, '/blog/posts/46/exit/');
  const rejected = spawnSync(process.execPath, [renderer], { input: JSON.stringify({ api_base: api, documents: [row], password }), encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.ok(!rejected.stdout.includes(password) && !rejected.stderr.includes(password));
});

test('only an accepted login offers password storage and article requests use the revocable session', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ loginRespond: () => pending });
  await f.login();
  assert.equal(f.savedPasswords.length, 0);
  assert.equal(f.elements.editor.hidden, true);
  finish(sessionResult()); await settle();
  assert.equal(f.elements.source.value, initialSource);
  assert.equal(f.elements.token.value, '');
  assert.equal(f.elements.editor.hidden, false);
  assert.equal(f.elements['login-form'].hidden, true);
  assert.equal(f.savedPasswords.length, 1);
  assert.equal(f.savedPasswords[0].id, 'admin');
  assert.equal(f.savedPasswords[0].password, password);
  const login = f.calls[0];
  assert.equal(login.url, api + '/v1/admin/login');
  assert.deepEqual(JSON.parse(login.options.body), { username: 'admin', password });
  assert.equal(login.options.headers.Authorization, undefined);
  const call = f.articleCalls[0];
  assert.equal(call.url, api + endpoint);
  assert.equal(call.options.headers.Authorization, 'Bearer ' + sessionToken);
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.cache, 'no-store');
  assert.ok(!call.url.includes(password));
  const denied = fixture({ loginRespond: () => ({ httpStatus: 401, error: 'unauthorized' }) }); await denied.login();
  assert.equal(denied.savedPasswords.length, 0);
  assert.equal(denied.articleCalls.length, 0);
  assert.equal(denied.storage.size, 0);
  for (const data of [{ ...loaded(), sha: 'broken' }, { ...loaded(), document: '47' }]) {
    const failed = fixture({ respond: () => data }); await failed.login();
    assert.equal(failed.savedPasswords.length, 1, 'A verified login remains valid even if the article response is malformed');
    assert.equal(failed.elements.editor.hidden, true);
    assert.equal(failed.elements.source.value, '');
  }
});

test('unconfigured and cross-origin-framed editors cannot send or save a password', async () => {
  for (const options of [{ base: '' }, { foreignFrame: true }, { documentId: '../46' }]) {
    const f = fixture(options); await f.login();
    assert.equal(f.calls.length, 0);
    assert.equal(f.savedPasswords.length, 0);
    assert.equal(f.elements.token.disabled, true);
    assert.equal(f.elements.editor.hidden, true);
  }
});

test('save submits exact Markdown and base SHA while publication remains explicitly pending', async () => {
  const f = fixture(); await f.login();
  f.elements.source.value = editedSource; await f.save();
  const post = f.articleCalls.find(call => call.options.method === 'POST');
  const payload = JSON.parse(post.options.body);
  assert.equal(post.url, api + endpoint);
  assert.equal(payload.source, editedSource);
  assert.equal(payload.sha, sha);
  assert.match(payload.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(payload).sort(), ['request_id', 'sha', 'source']);
  assert.equal(post.options.headers['Content-Type'], 'application/json');
  assert.ok(!post.options.body.includes(password));
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements.source.readOnly, true);
  assert.equal(f.elements.save.disabled, true);
  assert.match(f.elements.revision.textContent, /正在构建与发布/);
  assert.doesNotMatch(f.elements.message.textContent, /已保存并上线|网站已更新/);
  assert.equal(f.calls.filter(call => call.url.includes('/publication?')).length, 1);
});

test('409 conflict keeps the current source and makes no publication request', async () => {
  const f = fixture({ respond: (url, options) => options.method === 'POST' ? { httpStatus: 409, error: 'source_conflict' } : loaded() });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements.save.disabled, false);
  assert.equal(f.elements.source.readOnly, false);
  assert.match(f.elements.message.textContent, /已有其他修改.*当前编辑内容已保留/);
  assert.equal(f.calls.some(call => call.url.includes('/publication?')), false);
});

test('a network retry reuses its request identifier for the same source and base SHA', async () => {
  let posts = 0;
  const f = fixture({ respond: (url, options) => {
    if (options.method === 'POST') { if (++posts === 1) throw Error('Temporary network failure'); return { revision }; }
    return url.includes('/publication?') ? { state: 'pending' } : loaded();
  } });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements.save.disabled, false);
  await f.save();
  const payloads = f.articleCalls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body));
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
});

test('only a successful publication status claims that the website was updated', async () => {
  let state = 'pending';
  const f = fixture({ respond: (url, options) => options.method === 'POST' ? { revision } : url.includes('/publication?') ? { state, url: 'https://github.com/pku-xht/pku-xht.github.io/actions/runs/123' } : loaded() });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  assert.doesNotMatch(f.elements.message.textContent, /已保存并上线/);
  state = 'success'; await f.poll();
  assert.match(f.elements.message.textContent, /已保存并上线/);
  assert.equal(f.elements.revision.textContent, '网站已更新');
  assert.equal(f.elements.details.hidden, false);
  assert.equal(f.elements.details.href, 'https://github.com/pku-xht/pku-xht.github.io/actions/runs/123');
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements.save.disabled, true, 'A successful save requires reloading the new source SHA');
});

test('publication failure retains source, restores its dirty state and rejects foreign status links', async () => {
  let state = 'pending';
  const f = fixture({ respond: (url, options) => options.method === 'POST' ? { revision } : url.includes('/publication?') ? { state, url: 'https://github.com.evil.example/actions/123' } : loaded() });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  state = 'failure'; await f.poll();
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements.source.readOnly, false);
  assert.match(f.elements.message.textContent, /未完成.*当前编辑内容已保留/);
  assert.equal(f.elements.details.hidden, true);
  const event = { preventDefault() { this.prevented = true; } };
  f.events.beforeunload(event);
  assert.equal(event.prevented, true);
});

test('a Pages failure after the source was saved requires reload instead of resubmitting saved changes', async () => {
  let state = 'pending';
  const f = fixture({ respond: (url, options) => options.method === 'POST' ? { revision } : url.includes('/publication?') ? { state, source_saved: state === 'failure' } : loaded() });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  state = 'failure'; await f.poll();
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements.source.readOnly, false);
  assert.equal(f.elements.save.disabled, true, 'Reload the current source SHA after a successful source write');
  assert.equal(f.elements.revision.textContent, '更新未完成');
  assert.doesNotMatch(f.elements.message.textContent, /已保存并上线|网站已更新|尚未保存/);
  const event = { preventDefault() { this.prevented = true; } };
  f.events.beforeunload(event);
  assert.equal(event.prevented, undefined, 'Saved source must not be reported as an unsaved edit');
  const posts = f.articleCalls.filter(call => call.options.method === 'POST').length;
  await f.save();
  assert.equal(f.articleCalls.filter(call => call.options.method === 'POST').length, posts, 'Do not repeat a source write whose publication failed');
});

test('logout or pagehide prevents late source and publication responses from restoring private state', async () => {
  for (const leave of [false, true]) {
    let finish;
    const f = fixture({ loginRespond: () => new Promise(resolve => { finish = resolve; }) });
    await f.login();
    if (leave) f.events.pagehide(); else await f.elements.logout.dispatch('click');
    finish(sessionResult()); await settle();
    assert.equal(f.elements.source.value, '');
    assert.equal(f.elements.editor.hidden, true);
    assert.equal(f.savedPasswords.length, 0);
  }
  let finishStatus;
  const f = fixture({ respond: (url, options) => options.method === 'POST' ? { revision } : url.includes('/publication?') ? new Promise(resolve => { finishStatus = resolve; }) : loaded() });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  await f.elements.logout.dispatch('click');
  finishStatus({ state: 'success', url: 'https://github.com/pku-xht/pku-xht.github.io/actions/runs/123' }); await settle();
  assert.equal(f.elements.source.value, '');
  assert.equal(f.elements.revision.textContent, '');
  assert.equal(f.elements.details.hidden, true);
  assert.equal(f.elements.message.textContent, '已退出登录。');
  assert.equal([...f.timers.values()].some(timer => timer.delay === 5000), false);
});

test('unsaved edits trigger beforeunload and destructive reload requires confirmation', async () => {
  let allow = false;
  const f = fixture({ confirm: () => allow }); await f.login();
  const cleanEvent = { preventDefault() { this.prevented = true; } }; f.events.beforeunload(cleanEvent);
  assert.equal(cleanEvent.prevented, undefined);
  f.elements.source.value = editedSource;
  const dirtyEvent = { preventDefault() { this.prevented = true; } }; f.events.beforeunload(dirtyEvent);
  assert.equal(dirtyEvent.prevented, true);
  assert.equal(dirtyEvent.returnValue, '');
  await f.elements.reload.dispatch('click');
  assert.equal(f.articleCalls.length, 1);
  assert.equal(f.elements.source.value, editedSource);
  allow = true; await f.elements.reload.dispatch('click');
  assert.equal(f.articleCalls.length, 2);
  assert.equal(f.elements.source.value, initialSource);
});

test('leaving an editor retains only the revocable session and a new page restores without the password', async () => {
  const first = fixture(); await first.login();
  const stored = JSON.parse(first.storage.get(sessionKey));
  assert.deepEqual(Object.keys(stored).sort(), ['expires_at', 'token']);
  assert.equal(stored.token, sessionToken);
  assert.ok(!first.storage.get(sessionKey).includes(password));
  assert.ok(!first.storage.get(sessionKey).includes(initialSource));
  first.events.pagehide();
  assert.equal(first.elements.source.value, '');
  assert.equal(first.storage.size, 1);
  assert.equal(first.calls.some(call => call.options.method === 'DELETE'), false);
  const second = fixture({ storage: first.storage }); await second.ready();
  assert.equal(second.calls[0].url, api + '/v1/admin/session');
  assert.equal(second.calls[0].options.headers.Authorization, 'Bearer ' + sessionToken);
  assert.equal(second.calls.some(call => call.url.endsWith('/login')), false);
  assert.equal(second.savedPasswords.length, 0);
  assert.equal(second.elements.source.value, initialSource);
  assert.equal(second.elements.editor.hidden, false);
  assert.equal(second.elements['login-form'].hidden, true);
});

test('logout revokes the session while a different open editor retains unsaved text and asks for login', async () => {
  const first = fixture(); await first.login();
  const second = fixture({ storage: first.storage }); await second.ready();
  second.elements.source.value = editedSource;
  await first.elements.logout.dispatch('click');
  const revoke = first.calls.find(call => call.options.method === 'DELETE');
  assert.equal(revoke.url, api + '/v1/admin/session');
  assert.equal(revoke.options.headers.Authorization, 'Bearer ' + sessionToken);
  assert.equal(first.storage.size, 0);
  second.events.storage({ key: sessionKey });
  assert.equal(second.elements.source.value, editedSource);
  assert.equal(second.elements['login-form'].hidden, false);
  assert.equal(second.elements.save.disabled, true);
  assert.match(second.elements.message.textContent, /其他页面退出.*编辑内容已保留/);
  const event = { preventDefault() { this.prevented = true; } }; second.events.beforeunload(event);
  assert.equal(event.prevented, true);
  const posts = second.articleCalls.filter(call => call.options.method === 'POST').length;
  await second.save();
  assert.equal(second.articleCalls.filter(call => call.options.method === 'POST').length, posts);
});

test('server expiry preserves the draft and reauthentication keeps the original base SHA', async () => {
  let expired = true;
  const f = fixture({ respond: (url, options) => options.method === 'POST'
    ? expired ? { httpStatus: 401, error: 'unauthorized' } : { revision }
    : url.includes('/publication?') ? { state: 'pending' } : loaded() });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements['login-form'].hidden, false);
  assert.equal(f.elements.save.disabled, true);
  assert.equal(f.storage.size, 0);
  assert.match(f.elements.message.textContent, /登录已失效.*编辑内容已保留/);
  const event = { preventDefault() { this.prevented = true; } }; f.events.beforeunload(event);
  assert.equal(event.prevented, true);
  expired = false; await f.login();
  assert.equal(f.elements.source.value, editedSource);
  assert.match(f.elements.message.textContent, /登录已恢复.*修改已保留/);
  await f.save();
  const post = f.articleCalls.filter(call => call.options.method === 'POST').at(-1);
  assert.equal(JSON.parse(post.options.body).sha, sha);
  assert.equal(JSON.parse(post.options.body).source, editedSource);
});

test('reauthentication after an external article change preserves the draft without rebasing its SHA', async () => {
  const externalSha = 'd'.repeat(40);
  let latest = false;
  const f = fixture({ respond: (url, options) => options.method === 'POST'
    ? { httpStatus: 409, error: 'source_conflict' }
    : { ...loaded(), ...(latest ? { sha: externalSha, source: initialSource + '\n外部改动\n' } : {}) } });
  await f.login(); f.elements.source.value = editedSource;
  f.storage.delete(sessionKey); f.events.storage({ key: sessionKey });
  latest = true; await f.login();
  assert.equal(f.elements.source.value, editedSource);
  assert.match(f.elements.message.textContent, /文章已有新版本.*当前编辑内容已保留/);
  await f.save();
  assert.equal(JSON.parse(f.articleCalls.at(-1).options.body).sha, sha);
  assert.equal(f.elements.source.value, editedSource);
  assert.match(f.elements.message.textContent, /已有其他修改/);
});

test('crossing the stored absolute expiry shows login and preserves unsaved content before saving', async () => {
  const f = fixture(); await f.login();
  f.elements.source.value = editedSource;
  f.clock.now = Date.parse(JSON.parse(f.storage.get(sessionKey)).expires_at) + 1;
  const posts = f.articleCalls.filter(call => call.options.method === 'POST').length;
  await f.save();
  assert.equal(f.elements.source.value, editedSource);
  assert.equal(f.elements['login-form'].hidden, false);
  assert.equal(f.elements.save.disabled, true);
  assert.equal(f.storage.size, 0);
  assert.match(f.elements.message.textContent, /登录已失效.*编辑内容已保留/);
  assert.equal(f.articleCalls.filter(call => call.options.method === 'POST').length, posts);
});

test('unavailable browser storage does not block editing and expired restore never loads source', async () => {
  const ephemeral = fixture({ storageUnavailable: true }); await ephemeral.login();
  assert.equal(ephemeral.elements.source.value, initialSource);
  assert.equal(ephemeral.storage.size, 0);
  const storage = new Map([[sessionKey, JSON.stringify({ token: sessionToken, expires_at: new Date(Date.now() - 1).toISOString() })]]);
  const expired = fixture({ storage }); await expired.ready();
  assert.equal(expired.calls.length, 0);
  assert.equal(expired.elements.source.value, '');
  assert.equal(expired.elements['login-form'].hidden, false);
  assert.equal(expired.storage.size, 0);
});

for (const outcome of ['success', 'source-saved-publication-failure']) {
  test('editing again after ' + outcome + ' keeps discard protection and survives expiry with a fresh source SHA', async () => {
    const afterSaveSha = 'e'.repeat(40), nextDraft = editedSource + '\n继续修改，尚未保存。\n';
    let state = 'pending', saved = false, expireReload = false, allowDiscard = false;
    const confirmations = [];
    const f = fixture({ confirm: text => { confirmations.push(text); return allowDiscard; }, respond: (url, options) => {
      if (options.method === 'POST') return { revision };
      if (url.includes('/publication?')) return { state, source_saved: saved };
      if (expireReload) return { httpStatus: 401, error: 'unauthorized' };
      return saved ? { ...loaded(), source: editedSource, sha: afterSaveSha } : loaded();
    } });
    await f.login(); f.elements.source.value = editedSource; await f.save();
    saved = true; state = outcome === 'success' ? 'success' : 'failure'; await f.poll();
    assert.equal(f.elements.save.disabled, true, 'A new base SHA must be loaded before another save');
    assert.equal(f.elements.source.readOnly, false);
    f.elements.source.value = nextDraft;
    const leaving = { preventDefault() { this.prevented = true; } }; f.events.beforeunload(leaving);
    assert.equal(leaving.prevented, true, 'Clearing the previous SHA must not hide later unsaved edits');
    const requestsBeforeLogout = f.calls.length;
    await f.elements.logout.dispatch('click');
    assert.match(confirmations.at(-1), /退出会丢弃尚未保存/);
    assert.equal(f.calls.length, requestsBeforeLogout, 'Declining logout must not revoke the live session');
    assert.equal(f.elements.source.value, nextDraft);
    expireReload = true; allowDiscard = true;
    await f.elements.reload.dispatch('click');
    assert.equal(f.elements.source.value, nextDraft);
    assert.equal(f.elements['login-form'].hidden, false);
    assert.equal(f.elements.save.disabled, true);
    assert.match(f.elements.message.textContent, /登录已失效.*编辑内容已保留/);
    expireReload = false; await f.login();
    assert.equal(f.elements.source.value, nextDraft);
    assert.match(f.elements.message.textContent, /登录已恢复.*修改已保留/);
    assert.equal(f.elements.save.disabled, false, 'Unchanged saved text allows adopting its new server SHA');
    await f.save();
    const posted = JSON.parse(f.articleCalls.filter(call => call.options.method === 'POST').at(-1).options.body);
    assert.equal(posted.sha, afterSaveSha);
    assert.equal(posted.source, nextDraft);
  });
}

test('after a completed save, reauthentication preserves a new draft but does not adopt an externally changed base', async () => {
  const nextDraft = editedSource + '\n本机继续修改。\n';
  let state = 'pending', externalChange = false;
  const f = fixture({ respond: (url, options) => {
    if (options.method === 'POST') return { revision };
    if (url.includes('/publication?')) return { state };
    return externalChange ? { ...loaded(), source: editedSource + '\n别人已更新。\n', sha: 'f'.repeat(40) } : loaded();
  } });
  await f.login(); f.elements.source.value = editedSource; await f.save();
  state = 'success'; await f.poll();
  f.elements.source.value = nextDraft;
  f.storage.delete(sessionKey); f.events.storage({ key: sessionKey });
  externalChange = true; await f.login();
  assert.equal(f.elements.source.value, nextDraft);
  assert.equal(f.elements.save.disabled, true, 'No base SHA should be invented for a changed server source');
  assert.match(f.elements.message.textContent, /文章已有新版本.*当前编辑内容已保留/);
  const leaving = { preventDefault() { this.prevented = true; } }; f.events.beforeunload(leaving);
  assert.equal(leaving.prevented, true);
  const writes = f.articleCalls.filter(call => call.options.method === 'POST').length;
  await f.save();
  assert.equal(f.articleCalls.filter(call => call.options.method === 'POST').length, writes);
});
