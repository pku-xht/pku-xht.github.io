import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EDITOR_SCRIPT, staticArticleEditorAssets } from '../src/article-editor.mjs';

const api = 'https://editor.example.test';
const password = 'fictional-editor-password-not-a-real-secret-123456';
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
  confirm = () => true, passwordManager = true } = {}) {
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
  window.top = foreignFrame ? { location: { origin: 'https://evil.example' } } : window;
  const context = {
    document, window, AbortController, encodeURIComponent,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const data = await respond(url, options);
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
    elements, calls, events, documentEvents, timers, savedPasswords,
    async login() { elements.token.value = password; await elements['login-form'].dispatch('submit'); },
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
  assert.match(html, /<form id="login-form" method="post" autocomplete="on">/);
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

test('successful source GET authenticates before offering browser password storage', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ respond: () => pending });
  await f.login();
  assert.equal(f.savedPasswords.length, 0);
  assert.equal(f.elements.editor.hidden, true);
  finish(loaded()); await settle();
  assert.equal(f.elements.source.value, initialSource);
  assert.equal(f.elements.token.value, '');
  assert.equal(f.elements.editor.hidden, false);
  assert.equal(f.elements['login-form'].hidden, true);
  assert.equal(f.savedPasswords.length, 1);
  assert.equal(f.savedPasswords[0].id, 'admin');
  assert.equal(f.savedPasswords[0].password, password);
  const call = f.calls[0];
  assert.equal(call.url, api + endpoint);
  assert.equal(call.options.headers.Authorization, 'Bearer ' + password);
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.cache, 'no-store');
  assert.ok(!call.url.includes(password));
  for (const data of [{ httpStatus: 401, error: 'unauthorized' }, { ...loaded(), sha: 'broken' }, { ...loaded(), document: '47' }]) {
    const failed = fixture({ respond: () => data }); await failed.login();
    assert.equal(failed.savedPasswords.length, 0);
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
  const post = f.calls.find(call => call.options.method === 'POST');
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
  const payloads = f.calls.filter(call => call.options.method === 'POST').map(call => JSON.parse(call.options.body));
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
  const posts = f.calls.filter(call => call.options.method === 'POST').length;
  await f.save();
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, posts, 'Do not repeat a source write whose publication failed');
});

test('logout or pagehide prevents late source and publication responses from restoring private state', async () => {
  for (const leave of [false, true]) {
    let finish;
    const f = fixture({ respond: () => new Promise(resolve => { finish = resolve; }) });
    await f.login();
    if (leave) f.events.pagehide(); else await f.elements.logout.dispatch('click');
    finish(loaded()); await settle();
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
  assert.equal(f.calls.length, 1);
  assert.equal(f.elements.source.value, editedSource);
  allow = true; await f.elements.reload.dispatch('click');
  assert.equal(f.calls.length, 2);
  assert.equal(f.elements.source.value, initialSource);
});
