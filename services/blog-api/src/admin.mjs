export function adminPage() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>博客评论审核</title><style nonce="${nonce}">
body{max-width:800px;margin:32px auto;padding:0 20px;font:16px/1.6 system-ui;color:#202c38}input,select,button{font:inherit;padding:8px}input{max-width:100%}label{display:block;margin:12px 0}article{border-top:1px solid #dde4eb;padding:18px 0}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}button{margin-right:8px}small{color:#586574}#message{white-space:pre-wrap}
</style><h1>博客评论审核</h1><p>令牌仅保存在当前页面内存中。离开或刷新页面后需重新输入；请只在自己的可信设备上审核。</p>
<label>管理员令牌 <input id="token" type="password" autocomplete="off" spellcheck="false"></label>
<label>状态 <select id="status"><option value="pending">待审核</option><option value="approved">已公开</option><option value="rejected">已拒绝</option></select></label>
<button id="load" type="button">载入</button><button id="logout" type="button">清除令牌</button>
<p id="message" role="status" aria-live="polite"></p><main id="comments"></main><button id="more" type="button" hidden>下一页</button>
<script nonce="${nonce}">
let token = '', cursor = null;
const byId = id => document.getElementById(id);
const message = text => { byId('message').textContent = text; };
async function api(path, method = 'GET') {
  const response = await fetch(path, {method, headers:{Authorization:'Bearer '+token}, credentials:'omit'});
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '请求失败');
  return data;
}
function showComment(comment) {
  const article = document.createElement('article');
  const title = document.createElement('h2'); title.textContent = comment.nickname + ' · 文档 ' + comment.document;
  const meta = document.createElement('small'); meta.textContent = comment.created_at + (comment.parent_id ? ' · 回复 '+comment.parent_id : '');
  const body = document.createElement('pre'); body.textContent = comment.body;
  article.append(title, meta, body);
  for (const [action,label,method] of [['approve','公开','POST'],['reject','拒绝及隐藏回复','POST'],['','删除及删除回复','DELETE']]) {
    const button = document.createElement('button'); button.type='button'; button.textContent=label;
    button.addEventListener('click', async () => {
      if (method === 'DELETE' && !confirm('删除此新评论及其所有新评论回复？历史评论不受影响。')) return;
      button.disabled = true;
      try { await api('/v1/admin/comments/'+encodeURIComponent(comment.id)+(action?'/'+action:''),method); article.remove(); message('操作完成'); }
      catch (error) { message(error.message); button.disabled=false; }
    });
    article.append(button);
  }
  byId('comments').append(article);
}
async function load(reset) {
  if (reset) { const entered=byId('token').value.trim(); if (entered) token=entered; byId('token').value=''; cursor=null; byId('comments').replaceChildren(); }
  if (!token) { message('请输入管理员令牌'); return; }
  byId('load').disabled=true; byId('more').disabled=true;
  try {
    const data=await api('/v1/admin/comments?status='+encodeURIComponent(byId('status').value)+(cursor?'&cursor='+cursor:''));
    data.comments.forEach(showComment); cursor=data.next_cursor; byId('more').hidden=cursor===null;
    message(data.comments.length ? '已载入 '+data.comments.length+' 条' : '此状态下没有评论');
  } catch (error) { message(error.message); }
  finally { byId('load').disabled=false; byId('more').disabled=false; }
}
byId('load').addEventListener('click',()=>load(true));
byId('status').addEventListener('change',()=>load(true));
byId('more').addEventListener('click',()=>load(false));
byId('logout').addEventListener('click',()=>{token='';byId('token').value='';byId('comments').replaceChildren();byId('more').hidden=true;message('令牌已清除');});
window.addEventListener('pagehide',()=>{token='';byId('token').value='';byId('comments').replaceChildren();});
</script></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  } });
}
