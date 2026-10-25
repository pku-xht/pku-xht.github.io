import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

// This suite uses the real Workers runtime with a local outbound-service mock.
// Neither GitHub nor Cloudflare APIs receive requests or real credentials.
const ADMIN = 'fictional-admin-password-for-local-workers-runtime-12345';
const GITHUB = 'fictional-github-token-for-local-workers-runtime-12345';
const HEAD = 'a'.repeat(40), BLOB = 'b'.repeat(40);
const SOURCE_PATH = 'content/blog/posts/1154.md';
const SOURCE = '---\nid: 1154\ntype: post\n---\n\nLocal runtime article.\n';
let dependencies;

async function runtime(context) {
  if (dependencies) return dependencies;
  const require = createRequire(import.meta.url);
  let miniflarePath = process.env.BLOG_MINIFLARE_MODULE;
  let esbuildPath = process.env.BLOG_ESBUILD_MODULE;
  try {
    miniflarePath ||= require.resolve('miniflare');
    esbuildPath ||= require.resolve('esbuild');
  } catch {
    context.skip('Set BLOG_MINIFLARE_MODULE and BLOG_ESBUILD_MODULE to the installed Wrangler toolchain to run the real Workers runtime regression.');
    return null;
  }
  const miniflare = await import(pathToFileURL(miniflarePath).href);
  const esbuild = await import(pathToFileURL(esbuildPath).href);
  const result = await esbuild.build({
    entryPoints: [fileURLToPath(new URL('../src/worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    keepNames: true, logLevel: 'silent',
  });
  dependencies = { miniflare, script: result.outputFiles[0].text };
  return dependencies;
}

async function fixture(context, reply, { sessions = false } = {}) {
  const loaded = await runtime(context);
  if (!loaded) return null;
  const { miniflare, script } = loaded;
  const calls = [];
  const options = {
    modules: true, script, compatibilityDate: '2026-10-25', cf: false,
    bindings: { ADMIN_TOKEN: ADMIN, GITHUB_EDIT_TOKEN: GITHUB, RATE_LIMIT_SALT: 'fictional-runtime-address-salt-12345678901234567890', VISITS_ENABLED: 'false' },
    ...(sessions ? { d1Databases: ['DB'], d1Persist: false } : {}),
    outboundService(request) {
      calls.push({ url: request.url, authorization: request.headers.get('Authorization') });
      const result = reply(request);
      return new miniflare.Response(JSON.stringify(result.body ?? {}), {
        status: result.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...result.headers },
      });
    },
  };
  // Wrangler 4.152 bundles Miniflare's new API and an explicit V4 adapter;
  // older installed Miniflare releases accept these options directly.
  const configured = typeof miniflare.convertV4MiniflareOptions === 'function'
    ? miniflare.convertV4MiniflareOptions(options) : options;
  const mf = new miniflare.Miniflare(configured);
  context.after(() => mf.dispose());
  let database;
  if (sessions) {
    database = await mf.getD1Database('DB');
    for (const migration of ['0001_initial.sql', '0002_unified_comments.sql', '0003_admin_sessions.sql']) {
      // D1.exec() treats newlines as query boundaries. These checked-in
      // migrations contain multiline DDL and at most one final trigger, so
      // submit each complete statement (including the entire trigger) instead.
      const sql = (await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8')).replace(/^\s*--[^\r\n]*$/gm, '');
      const trigger = sql.search(/^CREATE TRIGGER\b/m);
      const ordinary = trigger === -1 ? sql : sql.slice(0, trigger);
      for (const statement of ordinary.split(';').map(value => value.trim()).filter(Boolean)) await database.prepare(statement).run();
      if (trigger !== -1) await database.prepare(sql.slice(trigger)).run();
    }
    await database.prepare("INSERT INTO public_documents(id, kind) VALUES ('1154', 'post')").run();
  }
  return {
    calls, database,
    request(path, { method = 'GET', password, value } = {}) {
      return mf.dispatchFetch('https://worker.example.test' + path, {
        method,
        headers: { Origin: 'https://pku-xht.github.io', 'CF-Connecting-IP': '192.0.2.25',
          ...(password ? { Authorization: 'Bearer ' + password } : {}),
          ...(value ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
    },
    get(password = ADMIN) {
      return mf.dispatchFetch('https://worker.example.test/v1/admin/articles/1154', {
        headers: { Authorization: 'Bearer ' + password, Origin: 'https://pku-xht.github.io' },
      });
    },
  };
}

test('the real Workers runtime can read an article through its fixed authenticated GitHub transport', async context => {
  const f = await fixture(context, request => {
    const path = new URL(request.url).pathname;
    if (path === '/repos/pku-xht/pku-xht.github.io/git/ref/heads/main') {
      return { body: { object: { type: 'commit', sha: HEAD } } };
    }
    if (path === '/repos/pku-xht/pku-xht.github.io/contents/' + SOURCE_PATH) {
      return { body: { type: 'file', path: SOURCE_PATH, encoding: 'base64',
        content: Buffer.from(SOURCE).toString('base64'), size: Buffer.byteLength(SOURCE), sha: BLOB } };
    }
    return { status: 404 };
  });
  if (!f) return;
  const response = await f.get();
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.equal(data.document, '1154');
  assert.equal(data.source, SOURCE);
  assert.equal(data.sha, BLOB);
  assert.equal(data.revision, HEAD);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.authorization === 'Bearer ' + GITHUB));
  assert.ok(f.calls.every(call => new URL(call.url).origin === 'https://api.github.com'));
  assert.equal(new URL(f.calls[1].url).searchParams.get('ref'), HEAD);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://pku-xht.github.io');
  assert.ok(!JSON.stringify(data).includes(GITHUB));
});

test('the real Workers runtime rejects a GitHub redirect without forwarding its credential', async context => {
  const f = await fixture(context, () => ({ status: 302, headers: { Location: 'https://unexpected.example.test/collect' } }));
  if (!f) return;
  const response = await f.get();
  assert.equal(response.status, 502);
  const data = await response.json();
  assert.equal(data.error, 'github_unavailable');
  assert.equal(f.calls.length, 1, 'a redirected request must never reach another origin');
  assert.equal(new URL(f.calls[0].url).origin, 'https://api.github.com');
  assert.ok(!JSON.stringify(data).includes(GITHUB));
});

test('the real Workers runtime rejects a wrong administrator password before any GitHub call', async context => {
  const f = await fixture(context, () => ({ status: 500 }));
  if (!f) return;
  const response = await f.get('fictional-wrong-admin-password');
  assert.equal(response.status, 401);
  assert.equal(f.calls.length, 0);
});

test('the real Workers runtime issues, restores and revokes a 30-day D1 session without storing its plaintext', async context => {
  const f = await fixture(context, () => ({ status: 500 }), { sessions: true });
  if (!f) return;
  const wrong = await f.request('/v1/admin/login', { method: 'POST', value: { username: 'admin', password: 'fictional-wrong-password' } });
  assert.equal(wrong.status, 401);
  const login = await f.request('/v1/admin/login', { method: 'POST', value: { username: 'admin', password: ADMIN } });
  assert.equal(login.status, 200, await login.clone().text());
  const session = await login.json();
  assert.match(session.token, /^bs_[a-f0-9]{64}$/);
  assert.equal(session.authenticated, true); assert.equal(session.article_editing, true);
  assert.equal(login.headers.get('Cache-Control'), 'no-store');
  assert.equal(login.headers.get('Set-Cookie'), null);
  const stored = await f.database.prepare('SELECT token_hash, created_at, expires_at FROM admin_sessions').first();
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(stored.expires_at - stored.created_at, 30 * 86400000);
  assert.equal(session.expires_at, new Date(stored.expires_at).toISOString());
  assert.ok(!JSON.stringify(stored).includes(session.token));
  assert.ok(!JSON.stringify(stored).includes(ADMIN));
  const restored = await f.request('/v1/admin/session', { password: session.token });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), { authenticated: true, article_editing: true, expires_at: session.expires_at });
  const comments = await f.request('/v1/admin/comments?status=all', { password: session.token });
  assert.equal(comments.status, 200);
  const data = await comments.json();
  assert.deepEqual(data.comments, []);
  assert.deepEqual(data.counts, { all: 0, pending: 0, approved: 0, rejected: 0 });
  const logout = await f.request('/v1/admin/session', { method: 'DELETE', password: session.token });
  assert.equal(logout.status, 200); assert.deepEqual(await logout.json(), { logged_out: true });
  assert.equal((await f.request('/v1/admin/session', { password: session.token })).status, 401);
  assert.equal((await f.request('/v1/admin/comments', { password: session.token })).status, 401);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS count FROM admin_sessions').first()).count, 0);
  assert.equal(f.calls.length, 0, 'login and comments must never contact GitHub');
});
