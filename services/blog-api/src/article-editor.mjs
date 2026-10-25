import { adminLoginForm, ADMIN_AUTH_HELPERS } from './admin-auth.mjs';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const STYLE = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fcfbf8;color:#28352f;font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1120px;margin:32px auto;padding:0 24px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:1px solid #dddcd3;padding-bottom:16px}a{color:#37654e;text-underline-offset:3px}h1{font:600 30px/1.4 Georgia,"Noto Serif SC",serif;margin:24px 0 8px;overflow-wrap:anywhere}p{margin:12px 0}label{display:block;margin:12px 0 4px}input,textarea,button{font:inherit;max-width:100%}input{display:block;width:min(100%,460px);padding:10px;border:1px solid #b5b9ad;border-radius:4px;background:#fffefa}button{padding:9px 17px;border:1px solid #b5b9ad;background:#f3f1e8;color:inherit;border-radius:4px;cursor:pointer}button:disabled{opacity:.55;cursor:default}button.primary{background:#37654e;border-color:#37654e;color:white}textarea{display:block;width:100%;min-height:56vh;resize:vertical;padding:18px;margin-top:8px;background:#fffefa;color:#242e2a;border:1px solid #b5b9ad;border-radius:4px;font:14px/1.7 Consolas,"Cascadia Code",monospace;tab-size:2;white-space:pre;overflow:auto}input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #89ad96;outline-offset:3px}.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0}.muted{color:#626b63;font-size:14px}#message{min-height:1.7em;white-space:pre-wrap;overflow-wrap:anywhere}#login-form{max-width:520px;margin:22px 0}#source-label{font-weight:600}#revision{overflow-wrap:anywhere}#logout{margin-left:auto}[hidden]{display:none!important}@media(max-width:520px){main{margin:20px auto;padding:0 16px}h1{font-size:25px}textarea{padding:12px;font-size:13px;min-height:60vh}.actions button{flex:1}.actions .primary{flex-basis:100%}#logout{margin-left:0}}\n`;

export const EDITOR_SCRIPT = String.raw`(function initArticleEditor() {
  'use strict';
  let password = '', sha = '', savedSource = '', submittedBase = '', session = 0, busy = false, publishing = false, publicationTimer = null;
  const requests = new Map();
  const byId = id => document.getElementById(id);
  const message = value => { byId('message').textContent = value; };
  const base = document.body.dataset.editorApi;
  const id = document.body.dataset.documentId;
  const endpoint = '/v1/admin/articles/' + encodeURIComponent(id);
  const source = byId('source');
` + ADMIN_AUTH_HELPERS + String.raw`
  if (!isDirectAdminPage()) { message('请直接打开文章编辑页面后登录。'); return; }
  if (!base || !/^[1-9][0-9]*$/.test(id)) { message('文章编辑服务尚未配置。'); return; }
  ['username', 'token', 'load'].forEach(name => { byId(name).disabled = false; });

  function dirty() { return Boolean(password && source.value !== savedSource); }
  function stopPolling() { if (publicationTimer !== null) window.clearTimeout(publicationTimer); publicationTimer = null; }
  function setBusy(value) {
    busy = value;
    byId('load').disabled = value;
    byId('save').disabled = value || publishing || !sha;
    byId('reload').disabled = value || publishing;
    source.readOnly = value || publishing;
  }
  async function api(path, method = 'GET', payload) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(base + path, {
        method, headers: { Authorization: 'Bearer ' + password, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.message || '请求未完成，请重试。');
        error.code = data.error; error.status = response.status; throw error;
      }
      return data;
    } finally { window.clearTimeout(timeout); }
  }
  function errorText(error) {
    if (error.status === 401) return '密码不正确，请退出后重新登录。';
    if (error.status === 409) return '这篇文章已有其他修改，请先复制当前内容，再重新载入最新版本。当前编辑内容已保留。';
    if (error.status === 503) return '在线保存服务尚未配置完成。当前编辑内容已保留。';
    return error.message || '连接暂时失败，当前编辑内容已保留。';
  }
  function clearSession(show = true) {
    password = ''; sha = ''; savedSource = ''; submittedBase = ''; publishing = false; requests.clear(); session++; stopPolling();
    byId('token').value = ''; source.value = ''; byId('revision').textContent = '';
    byId('editor').hidden = true; byId('login-form').hidden = false;
    byId('details').hidden = true; byId('details').removeAttribute('href');
    setBusy(false);
    if (show) message('已退出登录。');
  }
  async function loadArticle(login) {
    if (busy) return;
    if (!login && dirty() && !window.confirm('重新载入会丢弃尚未保存的修改，继续吗？')) return;
    if (login) { password = byId('token').value.trim(); session++; }
    if (!password) { message('请输入管理员密码。'); return; }
    const currentSession = session, entered = password;
    setBusy(true); message('正在载入文章…');
    try {
      const data = await api(endpoint);
      if (currentSession !== session) return;
      if (String(data.document) !== id || typeof data.source !== 'string' || !/^[0-9a-f]{40}$/.test(data.sha)) throw new Error('文章响应不完整，请重试。');
      sha = data.sha; savedSource = data.source; source.value = data.source; stopPolling();
      byId('login-form').hidden = true; byId('token').value = ''; byId('editor').hidden = false;
      byId('revision').textContent = '已载入最新版本';
      message('修改后点击“保存并更新网站”。构建与校验通过后会自动上线。');
      if (login) void offerPasswordSave(entered);
    } catch (error) { if (currentSession === session) message(errorText(error)); }
    finally { if (currentSession === session) setBusy(false); }
  }
  async function pollPublication(revision, currentSession, attempt = 0) {
    if (currentSession !== session || !password) return;
    try {
      const data = await api(endpoint + '/publication?revision=' + encodeURIComponent(revision));
      if (currentSession !== session) return;
      if (typeof data.url === 'string' && data.url.startsWith('https://github.com/pku-xht/pku-xht.github.io/')) {
        byId('details').href = data.url; byId('details').hidden = false;
      }
      if (data.state === 'success') {
        publishing = false;
        byId('revision').textContent = '网站已更新';
        message('已保存并上线。可返回文章查看。'); sha = '';
        // Reload before the next save, since the source SHA has changed.
        setBusy(false); return;
      }
      if (data.state === 'failure' || data.state === 'error') {
        publishing = false;
        if (data.source_saved) sha = '';
        else savedSource = submittedBase;
        byId('revision').textContent = '更新未完成';
        message(data.message || '构建或发布未完成。当前编辑内容已保留，请查看更新详情。'); setBusy(false); return;
      }
      byId('revision').textContent = '已提交，正在构建与发布…';
    } catch {
      if (currentSession !== session) return;
      message('修改已提交，暂时无法获取更新状态。可查看更新详情，或稍后重新载入。');
    }
    if (attempt < 120 && currentSession === session) publicationTimer = window.setTimeout(() => pollPublication(revision, currentSession, attempt + 1), 5000);
    else if (currentSession === session) { publishing = false; setBusy(false); message('更新仍未完成，请查看更新详情或稍后重新载入。'); }
  }
  async function saveArticle() {
    if (busy || publishing || !password || !sha) return;
    if (!dirty()) { message('没有需要保存的修改。'); return; }
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') { message('请使用新版浏览器保存文章。'); return; }
    const currentSession = session, text = source.value;
    const fingerprint = sha + '\n' + text;
    if (!requests.has(fingerprint)) requests.set(fingerprint, window.crypto.randomUUID());
    setBusy(true); stopPolling(); message('正在提交修改…');
    try {
      const data = await api(endpoint, 'POST', { source: text, sha, request_id: requests.get(fingerprint) });
      if (currentSession !== session) return;
      if (!/^[0-9a-f]{40}$/.test(data.revision)) throw new Error('未收到有效的更新版本。当前内容已保留。');
      submittedBase = savedSource; savedSource = text; publishing = true;
      message('修改已提交，正在构建与发布…');
      void pollPublication(data.revision, currentSession);
    } catch (error) { if (currentSession === session) message(errorText(error)); }
    finally { if (currentSession === session) setBusy(false); }
  }
  byId('login-form').addEventListener('submit', event => { event.preventDefault(); void loadArticle(true); });
  byId('reload').addEventListener('click', () => { void loadArticle(false); });
  byId('save').addEventListener('click', () => { void saveArticle(); });
  byId('logout').addEventListener('click', () => { if (!dirty() || window.confirm('退出会丢弃尚未保存的修改，继续吗？')) clearSession(); });
  window.addEventListener('pagehide', () => clearSession(false));
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && password) { event.preventDefault(); void saveArticle(); }
  });
})();
`;

export function staticArticleEditorAssets(apiBase, documents) {
  if (typeof apiBase !== 'string' || !Array.isArray(documents)) throw new TypeError('Expected a public API address and registered documents');
  let origin = "'none'";
  if (apiBase) {
    const url = new URL(apiBase);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || /\s/.test(apiBase)) throw new TypeError('Invalid fixed editor API');
    origin = url.origin;
  }
  const seen = new Set();
  const policy = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${origin}; base-uri 'none'; form-action 'none'`;
  const pages = documents.map(row => {
    if (!row || Object.keys(row).sort().join(',') !== 'id,path,title' || !/^[1-9][0-9]*$/.test(String(row.id)) || !new RegExp('^/blog/(?:posts|pages)/' + row.id + '/$').test(row.path) || typeof row.title !== 'string' || seen.has(String(row.id))) throw new TypeError('Invalid registered editor document');
    seen.add(String(row.id));
    return { document: String(row.id), path: row.path + 'exit/', html: `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><title>编辑 · ${escape(row.title)}</title>
<link rel="stylesheet" href="/blog/editor/editor.css?v=1"><script defer src="/blog/editor/editor.js?v=1"></script></head>
<body data-editor-api="${escape(apiBase.replace(/\/+$/, ''))}" data-document-id="${row.id}"><main>
<header><a href="${escape(row.path)}">← 返回文章</a><a href="/blog/comment/">评论管理</a></header>
<h1>编辑 · ${escape(row.title)}</h1>
${adminLoginForm()}
<p id="message" role="status" aria-live="polite">请输入管理员密码后登录。</p>
<section id="editor" hidden>
<div class="actions"><button id="save" class="primary" type="button" disabled>保存并更新网站</button><button id="reload" type="button" disabled>重新载入</button><button id="logout" type="button">退出登录</button></div>
<p class="muted"><span id="revision"></span> <a id="details" target="_blank" rel="noopener noreferrer" hidden>更新详情 ↗</a></p>
<label id="source-label" for="source">Markdown 正文与 YAML 元数据</label>
<p class="muted">保留文件开头的文章编号与链接信息。公式、代码和 HTML 均可直接编辑。</p>
<textarea id="source" spellcheck="false" aria-describedby="source-label"></textarea>
</section><noscript><p>文章编辑需要启用 JavaScript。</p></noscript></main></body></html>\n` };
  });
  return { pages, script: EDITOR_SCRIPT, style: STYLE };
}
