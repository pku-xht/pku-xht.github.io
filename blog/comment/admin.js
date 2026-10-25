(function initAdmin() {
  'use strict';

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

  let cursor = null, session = 0, loadVersion = 0, loaded = 0, searchTimer = null;
  let documents = new Map();
  const byId = id => document.getElementById(id);
  const message = text => { byId('message').textContent = text; };
  const enabled = document.body.dataset.adminEnabled === 'true';
  const apiBase = document.body.dataset.adminApi;
  const controls = ['status', 'document-filter', 'search', 'refresh', 'logout', 'more'].map(byId);
  if (!isDirectAdminPage()) { message('请直接打开评论管理页面后登录。'); return; }
  if (!enabled) { message('评论管理服务尚未配置。'); return; }
  const auth = createAdminSession(apiBase, () => clearView('登录已失效或已在其他页面退出，请重新登录。'));
  ['username', 'token', 'load'].map(byId).forEach(control => { control.disabled = false; });

  function clearView(text = '') {
    cursor = null; loaded = 0; session++; loadVersion++;
    byId('token').value = '';
    byId('comments').replaceChildren();
    byId('summary').textContent = ''; byId('loaded-count').textContent = '';
    byId('empty-state').hidden = true; byId('more').hidden = true;
    byId('login-form').hidden = false; byId('management').hidden = true;
    controls.forEach(control => { control.disabled = true; });
    byId('load').disabled = false;
    if (text) message(text);
  }
  function showManagement() {
    byId('login-form').hidden = true; byId('management').hidden = false;
    controls.forEach(control => { control.disabled = false; });
    byId('token').value = '';
  }
  function documentURL(comment) {
    const value = documents.get(String(comment.document));
    return value && new RegExp('^/blog/(?:posts|pages)/' + comment.document + '/$').test(value.url) ? value.url : null;
  }
  function showComment(comment) {
    const article = document.createElement('article'); article.className = 'comment-card';
    article.dataset.state = comment.status; article.dataset.commentId = comment.id;
    const header = document.createElement('div'); header.className = 'comment-header';
    const title = document.createElement('h2'); title.textContent = comment.nickname;
    const badge = document.createElement('span'); badge.className = 'status-badge'; badge.dataset.state = comment.status;
    badge.textContent = ({ pending: '待审核', approved: '已公开', rejected: '已拒绝' })[comment.status] || '未知状态';
    header.append(title, badge);
    const meta = document.createElement('div'); meta.className = 'comment-meta';
    const stamp = document.createElement('time'); stamp.dateTime = comment.created_at;
    const date = new Date(comment.created_at);
    stamp.textContent = Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : comment.created_at;
    meta.append(stamp);
    const path = documentURL(comment), documentInfo = documents.get(String(comment.document));
    if (comment.parent_id) { const parent = document.createElement('span'); parent.textContent = '回复 ' + comment.parent_id; meta.append(parent); }
    const location = document.createElement(path ? 'a' : 'span');
    location.textContent = documentInfo?.title || '文章 ' + comment.document;
    if (path) { location.href = path; location.target = '_blank'; location.rel = 'noopener noreferrer'; }
    meta.append(location);
    const body = document.createElement('pre'); body.className = 'comment-body'; body.textContent = comment.body;
    const actions = document.createElement('div'); actions.className = 'comment-actions';
    for (const [action, label, method] of [['approve', '公开', 'POST'], ['reject', '拒绝及隐藏回复', 'POST'], ['', '删除及删除回复', 'DELETE']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      if (action === 'approve') { button.className = 'primary'; button.disabled = comment.status === 'approved'; }
      if (method === 'DELETE') button.className = 'danger';
      button.addEventListener('click', async () => {
        if (!auth.hasSession()) { message('请先登录。'); return; }
        if (method === 'DELETE' && !window.confirm('删除此评论及其所有回复？此操作无法撤销。')) return;
        const currentSession = session;
        [...actions.children].forEach(control => { control.disabled = true; });
        try {
          await auth.request('/v1/admin/comments/' + encodeURIComponent(comment.id) + (action ? '/' + action : ''), method);
          if (currentSession !== session) return;
          await load(true);
          if (currentSession === session) message('操作完成，列表已更新。');
        } catch (error) {
          if (currentSession !== session) return;
          message(error.message);
          [...actions.children].forEach(control => { control.disabled = false; });
        }
      });
      actions.append(button);
    }
    if (path) {
      const link = document.createElement('a'); link.textContent = '查看原文 ↗'; link.href = path;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
    }
    article.append(header, meta, body, actions); byId('comments').append(article);
  }
  function updateDocuments(rows) {
    if (!Array.isArray(rows)) throw new Error('文章列表不完整，请重试。');
    const selected = byId('document-filter').value;
    documents = new Map(rows.filter(row => /^[1-9][0-9]*$/.test(String(row.id)) && typeof row.title === 'string').map(row => [String(row.id), row]));
    const options = [];
    const all = document.createElement('option'); all.value = ''; all.textContent = '全部文章'; options.push(all);
    for (const [id, row] of documents) { const option = document.createElement('option'); option.value = id; option.textContent = row.title; options.push(option); }
    byId('document-filter').replaceChildren(...options); byId('document-filter').value = documents.has(selected) ? selected : '';
  }
  async function load(reset) {
    if (!auth.hasSession()) { message('请先登录。'); return; }
    if (reset) {
      cursor = null; loaded = 0; loadVersion++;
      byId('comments').replaceChildren(); byId('more').hidden = true; byId('empty-state').hidden = true;
    }
    const currentSession = session, currentLoad = loadVersion;
    byId('refresh').disabled = true; byId('more').disabled = true; message('正在载入评论…');
    try {
      const documentId = byId('document-filter').value, query = byId('search').value.trim();
      const path = '/v1/admin/comments?status=' + encodeURIComponent(byId('status').value)
        + (documentId ? '&document=' + encodeURIComponent(documentId) : '')
        + (query ? '&q=' + encodeURIComponent(query) : '') + (cursor !== null ? '&cursor=' + cursor : '');
      const data = await auth.request(path);
      if (currentSession !== session || currentLoad !== loadVersion) return;
      if (!Array.isArray(data.comments) || !(data.next_cursor === null || Number.isSafeInteger(data.next_cursor) && data.next_cursor >= 0)
        || !data.counts || !['all', 'pending', 'approved', 'rejected'].every(name => Number.isSafeInteger(data.counts[name]) && data.counts[name] >= 0)) throw new Error('评论响应格式不正确，请重试。');
      updateDocuments(data.documents);
      data.comments.forEach(showComment); loaded += data.comments.length; cursor = data.next_cursor;
      byId('more').hidden = cursor === null; byId('empty-state').hidden = loaded !== 0;
      byId('summary').textContent = '全部 ' + data.counts.all + ' · 待审核 ' + data.counts.pending + ' · 已公开 ' + data.counts.approved + ' · 已拒绝 ' + data.counts.rejected;
      byId('loaded-count').textContent = '已显示 ' + loaded + ' / ' + data.counts[byId('status').value] + ' 条';
      message(loaded ? '评论列表已更新。' : '没有符合筛选条件的评论。');
    } catch (error) { if (currentSession === session && currentLoad === loadVersion) message(error.message); }
    finally { if (currentSession === session && currentLoad === loadVersion) { byId('refresh').disabled = false; byId('more').disabled = false; } }
  }
  async function signIn() {
    const entered = byId('token').value.trim();
    if (!entered) { message('请输入管理员密码。'); return; }
    const current = ++session;
    byId('load').disabled = true; message('正在登录…');
    try {
      if (!await auth.login(entered) || current !== session) return;
      void offerPasswordSave(entered); showManagement(); await load(true);
    } catch (error) { if (current === session) message(error.message); }
    finally { if (current === session) { byId('load').disabled = false; byId('token').value = ''; } }
  }
  async function resume() {
    const current = ++session; byId('load').disabled = true;
    try { if (await auth.restore() && current === session) { showManagement(); await load(true); } }
    catch { if (current === session) message('暂时无法恢复登录，请刷新重试，或输入密码重新登录。'); }
    finally { if (current === session) byId('load').disabled = false; }
  }
  byId('login-form').addEventListener('submit', event => { event.preventDefault(); return signIn(); });
  byId('refresh').addEventListener('click', () => load(true));
  byId('status').addEventListener('change', () => load(true));
  byId('document-filter').addEventListener('change', () => load(true));
  byId('search').addEventListener('input', () => {
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => { searchTimer = null; void load(true); }, 300);
  });
  byId('more').addEventListener('click', () => load(false));
  byId('logout').addEventListener('click', async () => {
    clearView('正在退出…'); const current = session, revoked = await auth.logout();
    if (current === session) message(revoked ? '已退出登录。' : '已从本机退出；网络连接失败，暂未确认服务器撤销。');
  });
  window.addEventListener('pagehide', () => { auth.clearMemory(); clearView(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void resume(); });
  void resume();
})();
