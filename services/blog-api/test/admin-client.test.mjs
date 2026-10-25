import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ADMIN_SCRIPT } from '../src/admin-client.mjs';
import { staticAdminAssets, adminPage } from '../src/admin.mjs';

const api = 'https://comments.example.test', token = 'fictional-admin-token-not-a-real-secret-123456';
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.disabled = true; this.hidden = false; this.textContent = ''; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  async dispatch(type) { for (const handler of this.listeners[type] || []) await handler(); }
  set innerHTML(_) { throw Error('HTML injection attempted'); }
}
function fixture({ base = api, enabled = true, foreignFrame = false, respond = () => ({ comments: [], next_cursor: null }), confirm = () => true, script = ADMIN_SCRIPT } = {}) {
  const elements = Object.fromEntries(['token', 'status', 'load', 'logout', 'more', 'message', 'comments'].map(id => [id, new Element()]));
  elements.status.value = 'pending'; elements.more.hidden = true;
  const document = { body: { dataset: { adminApi: base, adminEnabled: String(enabled) } }, getElementById: id => elements[id], createElement: tag => new Element(tag) };
  Object.defineProperty(document, 'cookie', { get() { throw Error('Cookie access attempted'); }, set() { throw Error('Cookie write attempted'); } });
  const events = {}, calls = [];
  const window = { location: { origin: 'https://pku-xht.github.io', search: '?api=https://evil.example&token=not-accepted' }, addEventListener(type, handler) { events[type] = handler; } };
  window.top = foreignFrame ? { location: { origin: 'https://evil.example' } } : window;
  const context = { document, window, confirm, encodeURIComponent, fetch: async (url, options) => {
    calls.push({ url, options });
    const data = await respond(url, options);
    return { ok: data.httpStatus ? data.httpStatus < 400 : true, json: async () => data };
  } };
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(context, key, { get() { throw Error('Persistent credential storage attempted'); } });
  vm.runInNewContext(script, context);
  return { elements, calls, events, async login() { elements.token.value = '  ' + token + '  '; await elements.load.dispatch('click'); } };
}
const comment = (id = 'first') => ({ id, nickname: '<img src=x onerror=alert(1)>', document: '46', body: '<script>untrusted</script>', parent_id: null, created_at: '2026-10-25T00:00:00Z' });

test('static UI sends the token only as a header to its fixed API and renders comments as text', async () => {
  const f = fixture({ respond: () => ({ comments: [comment()], next_cursor: 100 }) });
  assert.equal(f.calls.length, 0);
  await f.login();
  assert.equal(f.elements.token.value, '');
  assert.equal(f.calls[0].url, api + '/v1/admin/comments?status=pending');
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(f.calls[0].options.credentials, 'omit');
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.ok(!f.calls[0].url.includes(token));
  const article = f.elements.comments.children[0];
  assert.equal(article.children[0].textContent, comment().nickname + ' · 文档 46');
  assert.equal(article.children[2].textContent, comment().body);
  assert.equal(f.elements.more.hidden, false);
  await f.elements.more.dispatch('click');
  assert.equal(f.calls[1].url, api + '/v1/admin/comments?status=pending&cursor=100');
});

test('shared UI applies approve and reject actions and preserves the destructive-action confirmation', async () => {
  let allowDelete = false;
  const f = fixture({ respond: (_, options) => options.method === 'GET' ? { comments: [comment('one'), comment('two'), comment('three')], next_cursor: null } : { status: 'approved' }, confirm: () => allowDelete });
  await f.login();
  const [one, two, three] = f.elements.comments.children;
  await one.children[3].dispatch('click');
  assert.equal(f.calls.at(-1).url, api + '/v1/admin/comments/one/approve');
  assert.equal(f.calls.at(-1).options.method, 'POST');
  assert.equal(one.parent, null);
  await two.children[4].dispatch('click');
  assert.equal(f.calls.at(-1).url, api + '/v1/admin/comments/two/reject');
  assert.equal(two.parent, null);
  const before = f.calls.length;
  await three.children[5].dispatch('click');
  assert.equal(f.calls.length, before);
  assert.equal(three.parent, f.elements.comments);
  allowDelete = true;
  await three.children[5].dispatch('click');
  assert.equal(f.calls.at(-1).options.method, 'DELETE');
  assert.equal(three.parent, null);
  await f.elements.logout.dispatch('click');
  await f.elements.load.dispatch('click');
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.elements.message.textContent, '请输入管理员令牌');
});

test('clearing or leaving the page cannot be undone by an in-flight private response', async () => {
  for (const leave of [false, true]) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ respond: () => pending });
    const login = f.login();
    if (leave) f.events.pagehide();
    else await f.elements.logout.dispatch('click');
    finish({ comments: [comment()], next_cursor: 100 });
    await login;
    assert.equal(f.elements.comments.children.length, 0);
    assert.equal(f.elements.more.hidden, true);
    assert.equal(f.elements.token.value, '');
    await f.elements.load.dispatch('click');
    assert.equal(f.calls.length, 1);
  }
});

test('unconfigured and foreign-framed pages leave password controls disabled and make no requests', async () => {
  for (const options of [{ enabled: false, base: '' }, { foreignFrame: true }]) {
    const f = fixture(options);
    assert.equal(f.elements.token.disabled, true);
    assert.equal(f.elements.load.disabled, true);
    await f.login();
    assert.equal(f.calls.length, 0);
    assert.match(f.elements.message.textContent, /尚未配置|直接打开/);
  }
});

test('Worker and static documents share one client while preserving their distinct CSP delivery', async () => {
  const assets = staticAdminAssets(api + '/');
  assert.match(assets.html, /data-admin-api="https:\/\/comments\.example\.test"/);
  assert.match(assets.html, /http-equiv="Content-Security-Policy"/);
  assert.match(assets.html, /connect-src https:\/\/comments\.example\.test/);
  assert.match(assets.html, /name="robots" content="noindex,nofollow"/);
  assert.match(assets.html, /name="referrer" content="no-referrer"/);
  assert.match(assets.html, /<script defer src="\/blog\/comment\/admin\.js\?v=1"><\/script>/);
  assert.ok(!assets.html.includes('<iframe') && !assets.html.includes('http-equiv="refresh"'));
  const worker = adminPage(), html = await worker.text();
  assert.match(worker.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(worker.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  assert.ok(html.includes(assets.script));
  assert.match(html, /data-admin-api="" data-admin-enabled="true"/);
  assert.match(staticAdminAssets('').html, /data-admin-enabled="false"/);
});

test('renderer validates its fixed endpoint and accepts only the public configuration input', () => {
  for (const value of ['http://public.example', 'javascript:alert(1)', 'https://u:p@example.test', 'https://example.test?api=evil', 'https://example.test/#token', 'https://example.test/ bad', null]) assert.throws(() => staticAdminAssets(value));
  assert.match(staticAdminAssets('http://127.0.0.1:8787').html, /data-admin-enabled="true"/);
  const script = fileURLToPath(new URL('../../../tools/render_comment_admin.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify({ api_base: api }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const assets = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(assets).sort(), ['html', 'script', 'style']);
  assert.ok(!result.stdout.includes(token));
  const rejected = spawnSync(process.execPath, [script], { input: JSON.stringify({ api_base: api, token }), encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.ok(!rejected.stderr.includes(token));
});

test('keepNames esbuild Worker bundle embeds a standalone browser script', async context => {
  // Use the esbuild installed with Wrangler (BLOG_ESBUILD_MODULE), or a local
  // development installation. It is not a Worker/runtime dependency.
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
  const html = await response.text();
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0], ADMIN_SCRIPT);
  const f = fixture({ base: '', script: scripts[0], respond: () => ({ comments: [comment()], next_cursor: null }) });
  await f.login();
  assert.equal(f.calls[0].url, '/v1/admin/comments?status=pending');
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer ' + token);
  assert.equal(f.elements.comments.children.length, 1);
});
