/** Shared browser session transport. Only the revocable session is persisted. */
export const ADMIN_SESSION_HELPERS = String.raw`
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
`;
