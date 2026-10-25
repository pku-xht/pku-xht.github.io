/** Raw browser asset shared by the Worker and static management page. */
export const ADMIN_SCRIPT = String.raw`(function initAdmin() {
  let token = '', cursor = null, session = 0, loadVersion = 0;
  const byId = id => document.getElementById(id);
  const message = text => { byId('message').textContent = text; };
  const enabled = document.body.dataset.adminEnabled === 'true';
  const apiBase = document.body.dataset.adminApi;
  const controls = ['token', 'status', 'load', 'logout', 'more'].map(byId);
  try {
    if (window.top && window.top !== window && window.top.location.origin !== window.location.origin) throw new Error('foreign_frame');
  } catch {
    message('请直接打开评论管理页面，不要通过其他网站的嵌入窗口输入密码。');
    return;
  }
  if (!enabled) { message('评论管理服务尚未配置。'); return; }
  controls.forEach(control => { control.disabled = false; });

  async function api(path, method = 'GET') {
    const response = await fetch(apiBase + path, {
      method, headers: { Authorization: 'Bearer ' + token }, credentials: 'omit', redirect: 'error',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '请求失败');
    return data;
  }
  function clearSession(showMessage = true) {
    token = ''; cursor = null; session++; loadVersion++;
    byId('token').value = '';
    byId('comments').replaceChildren();
    byId('more').hidden = true;
    byId('load').disabled = false; byId('more').disabled = false;
    if (showMessage) message('令牌已清除');
  }
  function showComment(comment) {
    const article = document.createElement('article');
    const title = document.createElement('h2'); title.textContent = comment.nickname + ' · 文档 ' + comment.document;
    const meta = document.createElement('small'); meta.textContent = comment.created_at + (comment.parent_id ? ' · 回复 ' + comment.parent_id : '');
    const body = document.createElement('pre'); body.textContent = comment.body;
    article.append(title, meta, body);
    for (const [action, label, method] of [['approve', '公开', 'POST'], ['reject', '拒绝及隐藏回复', 'POST'], ['', '删除及删除回复', 'DELETE']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', async () => {
        if (!token) { message('请输入管理员令牌'); return; }
        if (method === 'DELETE' && !confirm('删除此新评论及其所有新评论回复？历史评论不受影响。')) return;
        const currentSession = session;
        button.disabled = true;
        try {
          await api('/v1/admin/comments/' + encodeURIComponent(comment.id) + (action ? '/' + action : ''), method);
          if (currentSession !== session) return;
          article.remove(); message('操作完成');
        } catch (error) {
          if (currentSession !== session) return;
          message(error.message); button.disabled = false;
        }
      });
      article.append(button);
    }
    byId('comments').append(article);
  }
  async function load(reset) {
    if (reset) {
      const entered = byId('token').value.trim();
      if (entered && entered !== token) { token = entered; session++; }
      byId('token').value = ''; cursor = null; loadVersion++;
      byId('comments').replaceChildren(); byId('more').hidden = true;
    }
    if (!token) { message('请输入管理员令牌'); return; }
    const currentSession = session, currentLoad = loadVersion;
    byId('load').disabled = true; byId('more').disabled = true;
    try {
      const data = await api('/v1/admin/comments?status=' + encodeURIComponent(byId('status').value) + (cursor ? '&cursor=' + cursor : ''));
      if (currentSession !== session || currentLoad !== loadVersion) return;
      data.comments.forEach(showComment); cursor = data.next_cursor; byId('more').hidden = cursor === null;
      message(data.comments.length ? '已载入 ' + data.comments.length + ' 条' : '此状态下没有评论');
    } catch (error) {
      if (currentSession !== session || currentLoad !== loadVersion) return;
      message(error.message);
    } finally {
      if (currentSession === session && currentLoad === loadVersion) { byId('load').disabled = false; byId('more').disabled = false; }
    }
  }
  byId('load').addEventListener('click', () => load(true));
  byId('status').addEventListener('change', () => load(true));
  byId('more').addEventListener('click', () => load(false));
  byId('logout').addEventListener('click', () => clearSession());
  window.addEventListener('pagehide', () => clearSession(false));
})();
`;
