import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { articleRequest } from '../src/articles.mjs';
import worker from '../src/worker.mjs';

const TOKEN = 'fictional-github-edit-token-not-real-1234567890';
const ADMIN = 'fictional-blog-admin-password-123456789012345';
const ORIGIN = 'https://pku-xht.github.io';
const PATH = 'content/blog/posts/46.md';
const MAIN = 'a'.repeat(40), TREE = 'b'.repeat(40);
const source = body => '---\nid: 46\ntype: post\ntitle: 测试文章\n---\n\n' + body + '\n';
const original = source('原来的正文 $x_i$。');
const digest = value => createHash('sha1').update(value).digest('hex');
const blobSHA = value => digest(Buffer.concat([Buffer.from('blob ' + Buffer.byteLength(value) + '\0'), Buffer.from(value)]));

function fixture() {
  const calls = [], writes = [], refs = new Map([['heads/main', MAIN]]), commits = new Map([[MAIN, { sha: MAIN, tree: { sha: TREE }, message: 'Published site' }]]);
  const blobs = new Map([[blobSHA(original), original]]), statuses = new Map();
  const state = { mainSource: original, mainBlob: blobSHA(original), rejectRefOnce: false, responseStatus: null };
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  async function transport(url, options) {
    const parsed = new URL(url), path = parsed.pathname.replace('/repos/pku-xht/pku-xht.github.io', '');
    const value = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, value });
    if (state.responseStatus) return response({ message: 'upstream must not be relayed ' + TOKEN }, state.responseStatus);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    if (options.method === 'GET' && path.startsWith('/git/ref/')) {
      const revision = refs.get(path.slice('/git/ref/'.length));
      return revision ? response({ object: { type: 'commit', sha: revision } }) : response({ message: 'not found' }, 404);
    }
    if (options.method === 'GET' && path === '/contents/' + PATH) {
      assert.equal(parsed.searchParams.get('ref'), refs.get('heads/main'));
      return response({ type: 'file', path: PATH, sha: state.mainBlob, size: Buffer.byteLength(state.mainSource), encoding: 'base64', content: Buffer.from(state.mainSource).toString('base64') });
    }
    if (options.method === 'GET' && path.startsWith('/git/commits/')) {
      return commits.has(path.slice('/git/commits/'.length)) ? response(commits.get(path.slice('/git/commits/'.length))) : response({}, 404);
    }
    if (options.method === 'GET' && /^\/commits\/[0-9a-f]{40}\/status$/.test(path)) return response({ statuses: statuses.get(path.split('/')[2]) || [] });
    if (options.method === 'POST') {
      writes.push({ path, value });
      if (path === '/git/blobs') { const sha = blobSHA(value.content); blobs.set(sha, value.content); return response({ sha }, 201); }
      if (path === '/git/trees') return response({ sha: digest(JSON.stringify(value)) }, 201);
      if (path === '/git/commits') { const sha = digest(JSON.stringify(value)); commits.set(sha, { ...value, sha }); return response({ sha }, 201); }
      if (path === '/git/refs') {
        assert.match(value.ref, /^refs\/heads\/codex\/article-edit\/[0-9a-f-]+$/);
        refs.set(value.ref.slice(5), value.sha);
        if (state.rejectRefOnce) { state.rejectRefOnce = false; return response({}, 422); }
        return response({ ref: value.ref, object: { type: 'commit', sha: value.sha } }, 201);
      }
    }
    assert.fail('Unexpected GitHub call: ' + options.method + ' ' + path);
  }
  async function request(suffix = '', { method = 'GET', value, body, headers = {} } = {}) {
    const request = new Request('https://api.example.test/v1/admin/articles/46' + suffix, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? value === undefined ? {} : { body: JSON.stringify(value) } : { body, duplex: 'half' }),
    });
    const result = await articleRequest(request, { GITHUB_EDIT_TOKEN: TOKEN }, new URL(request.url), { transport });
    return { status: result.status, data: await result.json() };
  }
  return { calls, writes, refs, commits, blobs, statuses, state, request };
}

test('reads the allowlisted Markdown from a coherent main revision without exposing the GitHub token', async () => {
  const f = fixture(), result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.data.source, original); assert.equal(result.data.sha, blobSHA(original));
  assert.equal(result.data.path, PATH); assert.equal(result.data.revision, MAIN);
  assert.equal(f.writes.length, 0); assert.ok(!JSON.stringify(result.data).includes(TOKEN));
  assert.equal((await f.request('?repo=elsewhere')).status, 400);
});

test('saving creates only one document blob on a candidate branch and leaves main untouched', async () => {
  const f = fixture(), changed = source('新的正文、公式 $x^2$ 和代码 `a < b`。'), requestID = randomUUID();
  const result = await f.request('', { method: 'POST', value: { source: changed, sha: f.state.mainBlob, request_id: requestID } });
  assert.equal(result.status, 202); assert.equal(result.data.status, 'pending'); assert.equal(result.data.document, '46');
  assert.equal(f.refs.get('heads/main'), MAIN); assert.equal(f.state.mainSource, original);
  assert.equal(f.refs.get('heads/codex/article-edit/' + requestID), result.data.revision);
  const tree = f.writes.find(row => row.path === '/git/trees').value;
  assert.equal(tree.base_tree, TREE); assert.deepEqual(tree.tree, [{ path: PATH, mode: '100644', type: 'blob', sha: blobSHA(changed) }]);
  const commit = f.commits.get(result.data.revision);
  assert.deepEqual(commit.parents, [MAIN]); assert.match(commit.message, new RegExp('XHT37-Base: ' + f.state.mainBlob));
  assert.ok(f.calls.every(row => !row.url.includes(TOKEN)));
});

test('same save ID reuses the candidate after response loss while changed content conflicts', async () => {
  const f = fixture(), payload = { source: source('已经保存的修改'), sha: f.state.mainBlob, request_id: randomUUID() };
  const first = await f.request('', { method: 'POST', value: payload }), before = f.writes.length;
  // A publication can advance main before the browser retries a lost response.
  f.state.mainSource = payload.source; f.state.mainBlob = blobSHA(payload.source);
  const repeated = await f.request('', { method: 'POST', value: payload });
  assert.equal(repeated.status, 202); assert.equal(repeated.data.revision, first.data.revision); assert.equal(f.writes.length, before);
  const conflict = await f.request('', { method: 'POST', value: { ...payload, source: source('不同的修改') } });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'request_conflict'); assert.equal(f.writes.length, before);
});

test('a racing creation of the same candidate ref returns the existing submission', async () => {
  const f = fixture(); f.state.rejectRefOnce = true;
  const result = await f.request('', { method: 'POST', value: { source: source('并发保存'), sha: f.state.mainBlob, request_id: randomUUID() } });
  assert.equal(result.status, 202); assert.equal(f.commits.get(result.data.revision).parents[0], MAIN);
});

test('stale source SHA refuses to write and an unchanged source does not start a publication', async () => {
  const f = fixture(), payload = { source: source('待提交'), sha: 'c'.repeat(40), request_id: randomUUID() };
  const conflict = await f.request('', { method: 'POST', value: payload });
  assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'source_conflict'); assert.equal(f.writes.length, 0);
  const unchanged = await f.request('', { method: 'POST', value: { ...payload, source: original, sha: f.state.mainBlob } });
  assert.equal(unchanged.status, 200); assert.equal(unchanged.data.status, 'unchanged'); assert.equal(f.writes.length, 0);
});

test('request fields, fixed document identity and malformed Markdown envelopes fail before GitHub access', async () => {
  const f = fixture(), payload = { source: source('修改'), sha: f.state.mainBlob, request_id: randomUUID() };
  for (const value of [
    { ...payload, path: '../secret.md' }, { ...payload, source: original.replace('id: 46', 'id: 215') },
    { ...payload, source: original.replace('type: post', 'type: page') },
    { ...payload, source: original.replace('id: 46', 'id: 46\nid: 215') },
    { ...payload, source: 'Only a body' }, { ...payload, source: original + '\0' },
    { ...payload, source: 'x'.repeat(950001) }, { ...payload, sha: 'main' }, { ...payload, request_id: 'not-a-save-id' },
  ]) assert.equal((await f.request('', { method: 'POST', value })).status, 400);
  assert.equal(f.calls.length, 0);
  const foreign = new Request('https://api.example.test/v1/admin/articles/999999');
  assert.equal((await articleRequest(foreign, { GITHUB_EDIT_TOKEN: TOKEN }, new URL(foreign.url), { transport: () => assert.fail('No foreign document request') })).status, 404);
});

test('editor accepts existing-size articles over the comment limit and bounds chunked requests at 1MiB', async () => {
  const f = fixture(), large = source('正文'.repeat(18000));
  assert.ok(Buffer.byteLength(large) > 65536);
  assert.equal((await f.request('', { method: 'POST', value: { source: large, sha: f.state.mainBlob, request_id: randomUUID() } })).status, 202);
  let cancelled = false, pulls = 0;
  const stream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(262144).fill(65)); }, cancel() { cancelled = true; } });
  const overflow = await f.request('', { method: 'POST', body: stream });
  assert.equal(overflow.status, 413); assert.equal(cancelled, true); assert.ok(pulls <= 6);
});

test('publication reports only the requested article and the fixed workflow status context', async () => {
  const f = fixture(), saved = await f.request('', { method: 'POST', value: { source: source('发布中'), sha: f.state.mainBlob, request_id: randomUUID() } });
  const revision = saved.data.revision, suffix = '/publication?revision=' + revision;
  const waiting = await f.request(suffix); assert.equal(waiting.data.state, 'pending'); assert.equal(waiting.data.source_saved, false);
  f.statuses.set(revision, [{ context: 'unrelated', state: 'failure' }, { context: 'blog-publish', state: 'success', target_url: 'https://github.com/pku-xht/pku-xht.github.io/actions/runs/123' }]);
  const published = await f.request(suffix); assert.equal(published.data.state, 'success'); assert.equal(published.data.source_saved, true); assert.ok(published.data.url.endsWith('/123'));
  f.statuses.set(revision, [{ context: 'blog-publish', state: 'failure', target_url: 'javascript:alert(1)', description: TOKEN }]);
  const failed = await f.request(suffix); assert.equal(failed.data.state, 'failure'); assert.equal(failed.data.source_saved, false); assert.match(failed.data.message, /正式文章未更新/); assert.equal(failed.data.url, 'https://github.com/pku-xht/pku-xht.github.io/actions'); assert.ok(!JSON.stringify(failed.data).includes(TOKEN));
  f.statuses.set(revision, [{ context: 'blog-publish', state: 'failure', description: '正文已保存，网站发布尚未确认完成，请查看构建记录。' }]);
  const savedButUnpublished = await f.request(suffix); assert.equal(savedButUnpublished.data.source_saved, true); assert.match(savedButUnpublished.data.message, /正文已保存.*重新运行工作流/);
  assert.equal((await f.request('/publication?revision=' + MAIN)).status, 404);
  assert.equal((await f.request('/publication?revision=' + revision + '&path=elsewhere')).status, 400);
});

test('GitHub authorization/network errors do not relay upstream bodies or credentials', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(); f.state.responseStatus = status;
    const result = await f.request();
    assert.equal(result.status, [401, 403].includes(status) ? 503 : 502);
    assert.ok(!JSON.stringify(result.data).includes(TOKEN));
  }
  const request = new Request('https://api.example.test/v1/admin/articles/46');
  const failed = await articleRequest(request, { GITHUB_EDIT_TOKEN: TOKEN }, new URL(request.url), { transport: async () => { throw new Error(TOKEN); } });
  assert.equal(failed.status, 502); assert.ok(!(await failed.text()).includes(TOKEN));
});

test('worker authenticates every edit route before accessing GitHub and distinguishes password from edit setup', async () => {
  const env = { ADMIN_TOKEN: ADMIN, VISITS_ENABLED: 'false' };
  const request = (path, password, origin = ORIGIN) => worker.fetch(new Request('https://api.example.test' + path, { headers: { Origin: origin, ...(password ? { Authorization: 'Bearer ' + password } : {}) } }), env);
  assert.equal((await request('/v1/admin/articles/46')).status, 401);
  assert.equal((await request('/v1/admin/articles/46', 'wrong')).status, 401);
  const session = await request('/v1/admin/session', ADMIN);
  assert.equal(session.status, 200); assert.deepEqual(await session.json(), { authenticated: true, article_editing: false });
  const unavailable = await request('/v1/admin/articles/46', ADMIN);
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error, 'edit_not_configured');
  assert.equal((await request('/v1/admin/articles/46', ADMIN, 'https://evil.example')).status, 403);
});
