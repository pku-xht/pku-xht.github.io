import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

// Run the bundled Worker with temporary D1 and a local outbound-service mock.
const ADMIN = 'fictional-admin-password-for-local-workers-runtime-12345';
let dependencies;

// Split the checked-in SQLite migrations without splitting trigger bodies or
// quoted values. CASE ... END can occur inside a trigger's BEGIN ... END.
function migrationStatements(sql) {
  const statements = [];
  let statement = '', token = '', quote = null, comment = null, depth = 0;
  const flushToken = () => {
    if (/^\s*CREATE\s+TRIGGER\b/i.test(statement)) {
      if (/^(BEGIN|CASE)$/i.test(token)) depth++;
      else if (/^END$/i.test(token)) depth--;
    }
    token = '';
  };
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1];
    if (comment) {
      if (comment === '--' && char === '\n') { comment = null; statement += '\n'; }
      else if (comment === '/*' && char === '*' && next === '/') { comment = null; i++; statement += ' '; }
      continue;
    }
    if (quote) {
      statement += char;
      if (char === quote) {
        if (next === quote && quote !== ']') { statement += next; i++; }
        else quote = null;
      }
      continue;
    }
    if ((char === '-' && next === '-') || (char === '/' && next === '*')) { flushToken(); comment = char + next; i++; continue; }
    statement += char;
    if (/[A-Za-z_]/.test(char)) token += char;
    else {
      flushToken();
      if (['\'', '"', '`', '['].includes(char)) quote = char === '[' ? ']' : char;
      else if (char === ';' && depth === 0) { statements.push(statement.trim()); statement = ''; }
    }
  }
  assert.equal(quote, null, 'migration has an unterminated quote');
  assert.equal(depth, 0, 'migration has an unterminated trigger');
  assert.equal(statement.trim(), '', 'migration ends without a statement terminator');
  return statements;
}

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

async function fixture(context, { visits = false } = {}) {
  const loaded = await runtime(context);
  if (!loaded) return null;
  const { miniflare, script } = loaded;
  const calls = [];
  const options = {
    modules: true, script, compatibilityDate: '2026-10-25', cf: false,
    bindings: {
      ADMIN_TOKEN: ADMIN,
      GITHUB_EDIT_TOKEN: 'fictional-retired-editor-token-for-local-workers-runtime-12345',
      RATE_LIMIT_SALT: 'fictional-runtime-address-salt-12345678901234567890',
      VISITS_ENABLED: visits ? 'true' : 'false',
    },
    d1Databases: ['DB'], d1Persist: false,
    outboundService(request) {
      calls.push(request.url);
      return new miniflare.Response(null, { status: 502 });
    },
  };
  // Wrangler 4.152 bundles Miniflare's new API and an explicit V4 adapter;
  // older installed Miniflare releases accept these options directly.
  const configured = typeof miniflare.convertV4MiniflareOptions === 'function'
    ? miniflare.convertV4MiniflareOptions(options) : options;
  const mf = new miniflare.Miniflare(configured);
  context.after(() => mf.dispose());
  const database = await mf.getD1Database('DB');
  for (const migration of ['0001_initial.sql', '0002_unified_comments.sql', '0003_admin_sessions.sql', '0004_visit_history.sql']) {
    // D1.exec() treats newlines as query boundaries; send complete statements.
    const sql = await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8');
    for (const statement of migrationStatements(sql)) await database.prepare(statement).run();
  }
  await database.prepare("INSERT INTO public_documents(id, kind) VALUES ('1154', 'post')").run();
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
  };
}

test('retired editor endpoints return 404 without outbound requests even with the old GitHub binding', async context => {
  const f = await fixture(context);
  if (!f) return;
  const login = await f.request('/v1/admin/login', { method: 'POST', value: { username: 'admin', password: ADMIN } });
  assert.equal(login.status, 200);
  const session = await login.json();
  const article = '/v1/admin/articles/1154';
  for (const password of [ADMIN, session.token]) {
    for (const [path, method, value] of [
      [article, 'GET'],
      [article, 'POST', {
        source: '---\nid: 1154\ntype: post\n---\n\nLocal runtime article.\n',
        sha: 'a'.repeat(40),
        request_id: '12345678-1234-4234-8234-123456789abc',
      }],
      [article + '/publication?revision=' + 'b'.repeat(40), 'GET'],
    ]) {
      const response = await f.request(path, { method, password, value });
      assert.equal(response.status, 404, method + ' ' + path);
      assert.equal((await response.json()).error, 'not_found');
    }
  }
  assert.deepEqual(f.calls, []);
});

test('the real Workers runtime issues, restores and revokes a 30-day D1 session without storing its plaintext', async context => {
  const f = await fixture(context);
  if (!f) return;
  const wrong = await f.request('/v1/admin/login', { method: 'POST', value: { username: 'admin', password: 'fictional-wrong-password' } });
  assert.equal(wrong.status, 401);
  const login = await f.request('/v1/admin/login', { method: 'POST', value: { username: 'admin', password: ADMIN } });
  assert.equal(login.status, 200, await login.clone().text());
  const session = await login.json();
  assert.match(session.token, /^bs_[a-f0-9]{64}$/);
  assert.equal(session.authenticated, true);
  assert.deepEqual(Object.keys(session).sort(), ['authenticated', 'expires_at', 'token']);
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
  assert.deepEqual(await restored.json(), { authenticated: true, expires_at: session.expires_at });
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

test('the real Workers runtime atomically imports daily history and reads Shanghai PV without changing cumulative counters', async context => {
  const f = await fixture(context, { visits: true });
  if (!f) return;
  const capture = '2020-10-25T16:30:00.000Z';
  const manifest = {
    timezone: 'Asia/Shanghai', captured_at: capture, site_base: 1000,
    first_date: '2020-10-24', cutover_date: '2020-10-26',
    items: [{ date: '2020-10-24', visits: 726, partial: false },
      { date: '2020-10-25', visits: null, partial: false },
      { date: '2020-10-26', visits: 274, partial: true }],
  };
  const upload = (value = manifest, batch = 'runtime-history') => f.request('/v1/admin/visits/history', {
    method: 'POST', password: ADMIN, value: { confirm_import: true, batch_id: batch, ...value },
  });
  const snapshot = async () => {
    const state = {};
    for (const [table, order] of [['visit_baselines', 'singleton'], ['document_baselines', 'document'], ['visit_deltas', 'key'], ['visit_events', 'nonce'], ['rate_buckets', 'key']]) {
      state[table] = (await f.database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results;
    }
    return state;
  };
  await f.database.prepare('INSERT INTO visit_baselines VALUES (1,?,?,?,?,?)').bind('runtime-base', 'fictional-baseline-hash', 1000, capture, capture).run();
  await f.database.prepare("INSERT INTO document_baselines VALUES ('1154',100)").run();
  for (const [nonce, document, created] of [
    ['before-cutover', null, '2020-10-25T16:29:59.999Z'],
    ['site-view', null, '2020-10-25T16:45:00.000Z'],
    ['document-view', '1154', '2020-10-25T17:00:00.000Z'],
    ['next-day', '1154', '2020-10-26T16:00:00.000Z'],
    ['future-view', null, '2099-01-01T00:00:00.000Z'],
  ]) await f.database.prepare('INSERT INTO visit_events VALUES (?,?,?)').bind(nonce, document, created).run();
  const original = await snapshot();
  const mismatched = await upload({ ...manifest, captured_at: '2020-10-25T16:31:00.000Z' });
  assert.equal(mismatched.status, 409);
  assert.equal((await mismatched.json()).error, 'baseline_mismatch');
  await f.database.prepare("CREATE TRIGGER runtime_history_failure BEFORE INSERT ON visit_history WHEN NEW.date='2020-10-25' BEGIN SELECT RAISE(ABORT, 'fictional runtime failure'); END").run();
  const failed = await upload();
  assert.equal(failed.status, 500, await failed.clone().text());
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM visit_history').first()).n, 0);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM visit_history_import').first()).n, 0);
  assert.deepEqual(await snapshot(), original, 'an aborted history trigger must preserve cumulative state');
  await f.database.prepare('DROP TRIGGER runtime_history_failure').run();
  const concurrent = await Promise.all([upload(), upload(manifest, 'runtime-retry')]);
  for (const response of concurrent) assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await Promise.all(concurrent.map(response => response.json()))).map(value => value.imported).sort(), [false, true]);
  assert.deepEqual(await snapshot(), original, 'history import must not change any cumulative baseline, event, delta or rate bucket');
  const stored = await f.database.prepare('SELECT payload FROM visit_history_import').first();
  assert.equal(stored.payload, null);
  assert.equal((await f.database.prepare('SELECT COUNT(*) AS n FROM visit_history').first()).n, 3);
  const conflict = await upload({ ...manifest, items: manifest.items.map((item, i) => i ? item : { ...item, partial: true }) });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'history_exists');
  const response = await f.request('/v1/visits/daily?range=all');
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://pku-xht.github.io');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const data = await response.json();
  assert.equal(data.timezone, 'Asia/Shanghai');
  assert.equal(data.seeded, true);
  assert.equal(data.history_seeded, true);
  assert.deepEqual(data.items.slice(0, 4), [
    { date: '2020-10-24', visits: 726, partial: true },
    { date: '2020-10-25', visits: null, partial: false },
    { date: '2020-10-26', visits: 276, partial: true },
    { date: '2020-10-27', visits: 1, partial: false },
  ]);
  assert.equal(data.items.at(-1).partial, true);
  assert.equal(data.items.reduce((sum, item) => sum + (item.visits ?? 0), 0), 1003, 'exclude pre-capture/future events and count document views once');
  assert.equal((await (await f.request('/v1/visits/daily?range=7')).json()).items.length, 7);
  assert.deepEqual(await snapshot(), original, 'GET and retry/conflict paths must preserve cumulative state');
  assert.equal(f.calls.length, 0, 'daily history requires no external service');
});
