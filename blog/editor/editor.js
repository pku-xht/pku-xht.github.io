(function initArticleEditor() {
  'use strict';
  let sha = '', savedSource = '', submittedBase = '', loadedSource = false, session = 0, busy = false, publishing = false, publicationTimer = null;
  const requests = new Map();
  const byId = id => document.getElementById(id);
  const message = value => { byId('message').textContent = value; };
  const base = document.body.dataset.editorApi;
  const id = document.body.dataset.documentId;
  const endpoint = '/v1/admin/articles/' + encodeURIComponent(id);
  const source = byId('source');

  function createAdminSession(apiBase, onInvalidated = () => {}) {
    const key = 'xht37.admin.session.v1:' + apiBase;
    let token = '', expiresAt = 0, generation = 0;
    const validToken = value => typeof value === 'string' && /^bs_[0-9a-f]{64}$/.test(value);
    function stored() {
      try {
        const value = JSON.parse(window.localStorage.getItem(key));
        if (value && validToken(value.token) && Number.isFinite(Date.parse(value.expires_at))) return value;
      } catch { /* Storage may be unavailable in private or restricted windows. */ }
      return null;
    }
    function forget(expected) {
      try { if (!expected || stored()?.token === expected) window.localStorage.removeItem(key); } catch {}
    }
    function clearMemory() { token = ''; expiresAt = 0; generation++; }
    function invalidate() {
      forget(token); clearMemory(); onInvalidated();
    }
    async function transport(path, method = 'GET', payload, bearer = '') {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(apiBase + path, {
          method, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(payload ? { 'Content-Type': 'application/json' } : {}) },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
        });
        const data = await response.json();
        if (!response.ok) {
          const error = new Error(response.status === 401 ? '密码不正确或登录已失效，请重新登录。' : response.status === 429 ? '登录尝试过于频繁，请稍后重试。' : data.message || '请求未完成，请重试。');
          error.status = response.status; error.code = data.error; throw error;
        }
        return data;
      } finally { window.clearTimeout(timer); }
    }
    async function revoke(value) {
      if (!validToken(value)) return true;
      try { await transport('/v1/admin/session', 'DELETE', undefined, value); return true; }
      catch (error) { return error.status === 401; }
    }
    function accept(data) {
      const expiry = Date.parse(data.expires_at);
      if (!validToken(data.token) || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('登录响应不完整，请重试。');
      token = data.token; expiresAt = expiry;
      try { window.localStorage.setItem(key, JSON.stringify({ token, expires_at: data.expires_at })); } catch {}
    }
    async function login(password) {
      const current = ++generation;
      const data = await transport('/v1/admin/login', 'POST', { username: 'admin', password });
      if (current !== generation) { void revoke(data.token); return false; }
      const previous = stored()?.token;
      accept(data);
      if (previous && previous !== data.token) void revoke(previous);
      return true;
    }
    async function restore() {
      const value = stored();
      if (!value) return false;
      if (Date.parse(value.expires_at) <= Date.now()) { forget(value.token); return false; }
      const current = ++generation;
      try {
        const data = await transport('/v1/admin/session', 'GET', undefined, value.token);
        if (current !== generation || stored()?.token !== value.token) return false;
        if (!data.authenticated) throw new Error('登录响应不完整，请重试。');
        accept({ token: value.token, expires_at: data.expires_at }); return true;
      } catch (error) {
        if (current === generation && error.status === 401) { forget(value.token); clearMemory(); return false; }
        throw error;
      }
    }
    async function request(path, method = 'GET', payload) {
      if (!token || expiresAt <= Date.now()) {
        if (token) invalidate();
        const error = new Error('登录已过期，请重新登录。'); error.status = 401; throw error;
      }
      const current = generation, bearer = token;
      try { return await transport(path, method, payload, bearer); }
      catch (error) { if (error.status === 401 && current === generation && bearer === token) invalidate(); throw error; }
    }
    async function logout() {
      const values = new Set([token, stored()?.token].filter(validToken));
      forget(); clearMemory();
      const results = await Promise.all([...values].map(revoke));
      return results.every(Boolean);
    }
    window.addEventListener('storage', event => {
      if (event.key !== key && event.key !== null) return;
      if (token && stored()?.token !== token) { clearMemory(); onInvalidated(); }
      else if (!token) generation++;
    });
    function hasSession() {
      if (token && expiresAt <= Date.now()) invalidate();
      return Boolean(token);
    }
    return { login, restore, request, logout, clearMemory, hasSession };
  }

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

  const auth = createAdminSession(base, expireSession);
  function dirty() { return loadedSource && source.value !== savedSource; }
  function stopPolling() { if (publicationTimer !== null) window.clearTimeout(publicationTimer); publicationTimer = null; }
  function setBusy(value) {
    busy = value;
    byId('load').disabled = value;
    byId('save').disabled = value || publishing || !sha;
    byId('reload').disabled = value || publishing;
    source.readOnly = value || publishing;
  }
  async function api(path, method = 'GET', payload) { return auth.request(path, method, payload); }
  function errorText(error) {
    if (error.status === 401) return '登录已失效，请重新登录。当前编辑内容已保留。';
    if (error.status === 409) return '这篇文章已有其他修改，请先复制当前内容，再重新载入最新版本。当前编辑内容已保留。';
    if (error.status === 503) return '在线保存服务尚未配置完成。当前编辑内容已保留。';
    return error.message || '连接暂时失败，当前编辑内容已保留。';
  }
  function clearSession(show = true) {
    sha = ''; savedSource = ''; submittedBase = ''; loadedSource = false; publishing = false; requests.clear(); session++; stopPolling();
    byId('token').value = ''; source.value = ''; byId('revision').textContent = '';
    byId('editor').hidden = true; byId('login-form').hidden = false;
    byId('details').hidden = true; byId('details').removeAttribute('href');
    setBusy(false);
    if (show) message('已退出登录。');
  }
  function expireSession() {
    session++; stopPolling(); publishing = false; busy = false;
    byId('login-form').hidden = false; byId('token').value = '';
    byId('load').disabled = false; byId('save').disabled = true; byId('reload').disabled = true;
    source.readOnly = false;
    message(source.value ? '登录已失效或已在其他页面退出。当前编辑内容已保留，重新登录后可继续。' : '登录已失效，请重新登录。');
  }
  async function loadArticle(login) {
    if (busy) return;
    if (!login && dirty() && !window.confirm('重新载入会丢弃尚未保存的修改，继续吗？')) return;
    const entered = login ? byId('token').value.trim() : '';
    if (login && !entered) { message('请输入管理员密码。'); return; }
    if (!login && !auth.hasSession()) { message('请先登录。'); return; }
    const draft = login && dirty() ? { source: source.value, sha, savedSource } : null;
    const currentSession = ++session;
    setBusy(true); message(login ? '正在登录并载入文章…' : '正在载入文章…');
    try {
      if (login) {
        if (!await auth.login(entered) || currentSession !== session) return;
        void offerPasswordSave(entered);
      }
      const data = await api(endpoint);
      if (currentSession !== session) return;
      if (String(data.document) !== id || typeof data.source !== 'string' || !/^[0-9a-f]{40}$/.test(data.sha)) throw new Error('文章响应不完整，请重试。');
      stopPolling();
      if (draft) {
        source.value = draft.source;
        sha = draft.sha || (data.source === draft.savedSource ? data.sha : ''); savedSource = draft.savedSource;
        message(sha === data.sha ? '登录已恢复，未保存的修改已保留。' : '登录已恢复，但文章已有新版本。请先复制当前内容，再重新载入并比较；当前编辑内容已保留。');
      } else {
        sha = data.sha; savedSource = data.source; source.value = data.source;
        message('修改后点击“保存并更新网站”。构建与校验通过后会自动上线。');
      }
      loadedSource = true;
      byId('login-form').hidden = true; byId('token').value = ''; byId('editor').hidden = false;
      byId('revision').textContent = draft ? '登录已恢复' : '已载入最新版本';
    } catch (error) { if (currentSession === session) message(errorText(error)); }
    finally { if (currentSession === session) { byId('token').value = ''; setBusy(false); } }
  }
  async function resume() {
    const currentSession = ++session;
    setBusy(true);
    try {
      if (await auth.restore() && currentSession === session) { setBusy(false); await loadArticle(false); }
    } catch { if (currentSession === session) message('暂时无法恢复登录，请刷新重试，或输入密码重新登录。'); }
    finally { if (currentSession === session) setBusy(false); }
  }
  async function pollPublication(revision, currentSession, attempt = 0) {
    if (currentSession !== session || !auth.hasSession()) return;
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
    if (busy || publishing || !auth.hasSession() || !sha) return;
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
  byId('logout').addEventListener('click', async () => {
    if (dirty() && !window.confirm('退出会丢弃尚未保存的修改，继续吗？')) return;
    clearSession(false);
    const currentSession = session, revoked = await auth.logout();
    if (currentSession === session) message(revoked ? '已退出登录。' : '已从本机退出；网络连接失败，暂未确认服务器撤销。');
  });
  window.addEventListener('pagehide', () => { auth.clearMemory(); clearSession(false); });
  window.addEventListener('pageshow', event => { if (event.persisted) void resume(); });
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  void resume();
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && auth.hasSession()) { event.preventDefault(); void saveArticle(); }
  });
})();
