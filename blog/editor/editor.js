(function initArticleEditor() {
  'use strict';
  let password = '', sha = '', savedSource = '', submittedBase = '', session = 0, busy = false, publishing = false, publicationTimer = null;
  const requests = new Map();
  const byId = id => document.getElementById(id);
  const message = value => { byId('message').textContent = value; };
  const base = document.body.dataset.editorApi;
  const id = document.body.dataset.documentId;
  const endpoint = '/v1/admin/articles/' + encodeURIComponent(id);
  const source = byId('source');

  function isDirectAdminPage() {
    try {
      return !window.top || window.top === window || window.top.location.origin === window.location.origin;
    } catch { return false; }
  }
  async function offerPasswordSave(password) {
    if (typeof PasswordCredential !== 'function' || typeof navigator === 'undefined' || !navigator.credentials || typeof navigator.credentials.store !== 'function') return;
    try {
      await navigator.credentials.store(new PasswordCredential({ id: 'admin', name: '博客管理员', password }));
    } catch {
      // A browser preference or declined prompt must not prevent management.
    }
  }

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
