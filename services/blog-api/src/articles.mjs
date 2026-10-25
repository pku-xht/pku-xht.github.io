import registry from '../data/public-documents.json' with { type: 'json' };

// The administrator may edit only documents already registered in this public
// collection. Repository, branch and paths never come from a browser request.
const REPOSITORY = 'pku-xht/pku-xht.github.io';
const API = 'https://api.github.com/repos/' + REPOSITORY;
const WEB = 'https://github.com/' + REPOSITORY;
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REQUEST = 1048576;
const MAX_SOURCE = 950000;
const DOCUMENTS = new Map(registry.documents.map(row => [row.id, row.kind]));

class ArticleError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
class UpstreamError extends Error {
  constructor(status) { super('GitHub request failed'); this.status = status; }
}
const fail = (status, code, message) => { throw new ArticleError(status, code, message); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const validSHA = value => typeof value === 'string' && SHA.test(value);

function sourcePath(id) {
  const kind = DOCUMENTS.get(id);
  if (!kind) fail(404, 'unknown_document', '该文章不在可编辑的公开集合中。');
  return 'content/blog/' + (kind === 'post' ? 'posts/' : 'pages/') + id + '.md';
}
function secret(env) {
  const value = env.GITHUB_EDIT_TOKEN;
  if (typeof value !== 'string' || value.length < 32) fail(503, 'edit_not_configured', '文章编辑尚未配置 GitHub 写入授权。');
  return value;
}
async function requestJSON(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) fail(415, 'json_required', '请使用 JSON 提交文章。');
  if (Number(request.headers.get('Content-Length')) > MAX_REQUEST) fail(413, 'body_too_large', '文章提交超过大小限制。');
  const reader = request.body?.getReader(), parts = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_REQUEST) { await reader.cancel(); fail(413, 'body_too_large', '文章提交超过大小限制。'); }
        parts.push(decoder.decode(value, { stream: true }));
      }
    }
    parts.push(decoder.decode());
  } catch (error) {
    if (error instanceof ArticleError) throw error;
    fail(400, 'invalid_json', '文章请求不是有效的 UTF-8 JSON。');
  }
  let value;
  try { value = JSON.parse(parts.join('')); } catch { fail(400, 'invalid_json', '文章请求不是有效的 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'request_id,sha,source') fail(400, 'unknown_field', '提交只接受 source、sha 和 request_id。');
  return value;
}
function validateSource(source, id) {
  if (typeof source !== 'string' || !source.trim() || new TextEncoder().encode(source).byteLength > MAX_SOURCE || /\u0000/.test(source)) fail(400, 'invalid_source', '请提交大小不超过 950000 字节的 Markdown 源文件。');
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!front) fail(400, 'invalid_front_matter', '请保留文章开头的 YAML 元数据。');
  const identifiers = [...front[1].matchAll(/^id:[ \t]*(.*?)\s*$/gm)];
  const kinds = [...front[1].matchAll(/^type:[ \t]*(.*?)\s*$/gm)];
  if (identifiers.length !== 1 || identifiers[0][1] !== id || kinds.length !== 1 || kinds[0][1] !== DOCUMENTS.get(id)) fail(400, 'document_identity_changed', '请保留该文章的 id 和 type，不能修改文章身份。');
  // Full YAML, Markdown, TeX, resource and generated-site checks are performed
  // by the trusted publication workflow before it changes the main branch.
}
async function hashSource(source) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function decodeSource(value, path) {
  if (!value || value.type !== 'file' || value.path !== path || value.encoding !== 'base64' || !validSHA(value.sha) || typeof value.content !== 'string' || value.size > MAX_SOURCE) fail(502, 'invalid_github_response', '无法读取有效的文章源文件。');
  try {
    const bytes = Uint8Array.from(atob(value.content.replace(/\s/g, '')), char => char.charCodeAt(0));
    if (bytes.byteLength > MAX_SOURCE) throw new Error('too large');
    return { source: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha: value.sha };
  } catch { fail(502, 'invalid_github_response', '无法读取有效的 UTF-8 文章源文件。'); }
}
function editMessage(id, requestID, base, hash) {
  return `Edit blog article ${id}\n\nXHT37-Edit: ${requestID}\nXHT37-Document: ${id}\nXHT37-Base: ${base}\nXHT37-Source-SHA256: ${hash}\n`;
}
function publicationURL(value) {
  if (typeof value !== 'string') return WEB + '/actions';
  return new RegExp('^https://github\\.com/pku-xht/pku-xht\\.github\\.io/actions/runs/[0-9]+(?:/attempts/[0-9]+)?$').test(value) ? value : WEB + '/actions';
}

/** Handle an already authenticated article request. Tests inject only transport. */
export async function articleRequest(request, env, url = new URL(request.url), { transport = globalThis.fetch.bind(globalThis) } = {}) {
  try {
    const match = /^\/v1\/admin\/articles\/([1-9][0-9]{0,15})(\/publication)?$/.exec(url.pathname);
    if (!match) fail(404, 'not_found', '未找到文章编辑接口。');
    const id = match[1], path = sourcePath(id), token = secret(env);
    const github = async (suffix, { method = 'GET', value, missing = false, raw = false } = {}) => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
      let response;
      try {
        response = await transport(API + suffix, {
          method, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'xht37-blog-editor', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
          // Workers rejects redirect:"error" before sending the request.
          // Manual mode plus the non-2xx check below never forwards the token.
          credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: controller.signal,
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        });
      } catch { fail(502, 'github_unavailable', 'GitHub 暂时无法连接，修改尚未提交，请保留编辑内容后重试。'); }
      finally { clearTimeout(timer); }
      if (response.status === 404 && missing) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new UpstreamError(response.status); }
      if (raw) return response;
      try { return await response.json(); } catch { fail(502, 'invalid_github_response', 'GitHub 返回了无法识别的响应。'); }
    };
    const readHead = async () => {
      const value = await github('/git/ref/heads/main');
      if (!validSHA(value?.object?.sha) || value.object.type !== 'commit') fail(502, 'invalid_github_response', '无法读取正式文章版本。');
      return value.object.sha;
    };
    const readSource = async revision => decodeSource(await github('/contents/' + path + '?ref=' + revision), path);
    if (match[2]) {
      if (request.method !== 'GET') fail(405, 'method_not_allowed', '发布状态只接受 GET。');
      if ([...url.searchParams.keys()].some(key => key !== 'revision') || url.searchParams.getAll('revision').length !== 1 || !validSHA(url.searchParams.get('revision'))) fail(400, 'invalid_revision', '请提供保存时返回的文章版本。');
      const revision = url.searchParams.get('revision');
      const commit = await github('/git/commits/' + revision, { missing: true });
      if (!commit || !new RegExp('^Edit blog article ' + id + '\\n\\nXHT37-Edit: [0-9a-f-]+\\nXHT37-Document: ' + id + '\\n').test(commit.message || '')) fail(404, 'unknown_revision', '该版本不是这篇文章的保存记录。');
      const value = await github('/commits/' + revision + '/status');
      if (!Array.isArray(value?.statuses)) fail(502, 'invalid_github_response', '无法读取文章发布状态。');
      const status = value.statuses.find(row => row.context === 'blog-publish');
      const state = status?.state === 'success' ? 'success' : ['failure', 'error'].includes(status?.state) ? 'failure' : 'pending';
      // The trusted publisher uses this fixed prefix only after main contains
      // the source plus generated pages. Do not expose its arbitrary upstream
      // description: return our bounded messages and an explicit saved state.
      const sourceSaved = state === 'success' || (state === 'failure' && typeof status?.description === 'string' && status.description.startsWith('正文已保存'));
      const message = state === 'success' ? '文章已更新并上线。' : state === 'failure'
        ? sourceSaved ? '正文已保存，但网站发布未完成，请在详情中重新运行工作流。' : '本次保存未通过校验或发布前检查，正式文章未更新。请查看详情，修正后重新保存。'
        : '修改已接收，正在校验、构建并发布。';
      return json({ document: id, revision, state, source_saved: sourceSaved, message, url: publicationURL(status?.target_url) });
    }
    if ([...url.searchParams.keys()].length) fail(400, 'unknown_field', '文章编辑地址不接受额外参数。');
    if (request.method === 'GET') {
      const revision = await readHead(), value = await readSource(revision);
      return json({ document: id, path, revision, ...value });
    }
    if (request.method !== 'POST') fail(405, 'method_not_allowed', '文章编辑只接受 GET 和 POST。');
    const value = await requestJSON(request);
    if (!validSHA(value.sha) || typeof value.request_id !== 'string' || !UUID.test(value.request_id)) fail(400, 'invalid_version', '请保留加载时的文章版本，并提供有效的保存标识。');
    validateSource(value.source, id);
    const requestID = value.request_id.toLowerCase(), branch = 'codex/article-edit/' + requestID;
    const message = editMessage(id, requestID, value.sha, await hashSource(value.source));
    const existingSubmission = async () => {
      const ref = await github('/git/ref/heads/' + branch, { missing: true });
      if (!ref) return null;
      if (!validSHA(ref.object?.sha) || ref.object?.type !== 'commit') fail(409, 'request_conflict', '此保存标识已用于其他修改。');
      const commit = await github('/git/commits/' + ref.object.sha);
      if (commit?.message !== message) fail(409, 'request_conflict', '此保存标识已用于其他修改。');
      return ref.object.sha;
    };
    const pending = revision => json({ document: id, revision, sha: value.sha, status: 'pending', url: WEB + '/actions' }, 202);
    const existing = await existingSubmission();
    if (existing) return pending(existing);
    const head = await readHead(), current = await readSource(head);
    if (current.sha !== value.sha) fail(409, 'source_conflict', '文章已被其他窗口或本地修改更新。请保留当前内容，重新载入后比较。');
    if (current.source === value.source) return json({ document: id, revision: head, sha: current.sha, status: 'unchanged' });
    const parent = await github('/git/commits/' + head);
    if (!validSHA(parent?.tree?.sha)) fail(502, 'invalid_github_response', '无法读取正式文章目录。');
    const blob = await github('/git/blobs', { method: 'POST', value: { content: value.source, encoding: 'utf-8' } });
    if (!validSHA(blob?.sha)) fail(502, 'invalid_github_response', '无法保存文章内容。');
    const tree = await github('/git/trees', { method: 'POST', value: { base_tree: parent.tree.sha, tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] } });
    if (!validSHA(tree?.sha)) fail(502, 'invalid_github_response', '无法保存文章目录。');
    const commit = await github('/git/commits', { method: 'POST', value: { message, tree: tree.sha, parents: [head] } });
    if (!validSHA(commit?.sha)) fail(502, 'invalid_github_response', '无法创建文章保存记录。');
    try { await github('/git/refs', { method: 'POST', value: { ref: 'refs/heads/' + branch, sha: commit.sha } }); }
    catch (error) {
      if (error instanceof UpstreamError && [409, 422].includes(error.status)) {
        const concurrent = await existingSubmission();
        if (concurrent) return pending(concurrent);
      }
      throw error;
    }
    return pending(commit.sha);
  } catch (error) {
    if (error instanceof ArticleError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof UpstreamError) {
      if ([401, 403].includes(error.status)) return json({ error: 'github_authorization_failed', message: 'GitHub 编辑授权不可用，请检查该仓库的访问权限或有效期。' }, 503);
      return json({ error: 'github_unavailable', message: 'GitHub 未完成本次请求。请保留编辑内容并使用同一保存标识重试。' }, 502);
    }
    return json({ error: 'edit_failed', message: '文章请求未能完成，请保留编辑内容后重试。' }, 500);
  }
}
