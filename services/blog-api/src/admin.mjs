import { ADMIN_SCRIPT } from './admin-client.mjs';
import { adminLoginForm } from './admin-auth.mjs';

const STYLE = `:root{color-scheme:light}*{box-sizing:border-box}body{max-width:800px;margin:32px auto;padding:0 20px;background:#fcfbf8;font:16px/1.7 system-ui;color:#202c38}a{color:#1f5d8d}h1{font-size:30px;line-height:1.3}h2{font-size:19px;overflow-wrap:anywhere}input,select,button{font:inherit;padding:8px;max-width:100%}input{width:min(100%,480px);display:block}label{display:block;margin:12px 0}article{border-top:1px solid #dde4eb;padding:18px 0}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}button{margin:0 8px 8px 0}small{color:#586574;overflow-wrap:anywhere}#message{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:480px){body{margin:24px auto;padding:0 18px}h1{font-size:26px}}\n`;
const SCRIPT = ADMIN_SCRIPT;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function documentHTML({ apiBase, enabled, style, script, policy = '' }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">${policy}
<title>博客评论审核 · 徐皓天</title>${style}${script}</head>
<body data-admin-api="${escape(apiBase)}" data-admin-enabled="${enabled}">
<p><a href="https://pku-xht.github.io/blog/">← 返回博客</a></p><h1>博客评论审核</h1>
<p>使用管理员密码登录。你可以让浏览器保存密码，下次自动填入。</p>
${adminLoginForm()}
<section id="management" hidden>
<label>状态 <select id="status" disabled><option value="pending">待审核</option><option value="approved">已公开</option><option value="rejected">已拒绝</option></select></label>
<button id="refresh" type="button" disabled>刷新</button><button id="logout" type="button" disabled>退出登录</button>
<main id="comments"></main><button id="more" type="button" hidden disabled>下一页</button>
</section>
<p id="message" role="status" aria-live="polite">${enabled ? '请输入管理员密码后登录。' : '评论管理服务尚未配置。'}</p>
<noscript><p>评论管理需要启用 JavaScript。</p></noscript></body></html>\n`;
}

export function staticAdminAssets(apiBase) {
  if (typeof apiBase !== 'string') throw new TypeError('api_base must be a string');
  let origin = "'none'";
  if (apiBase) {
    const parsed = new URL(apiBase);
    const loopback = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (!(parsed.protocol === 'https:' || loopback) || parsed.username || parsed.password || parsed.search || parsed.hash || /\s/.test(apiBase)) throw new TypeError('api_base must be HTTPS or loopback HTTP without credentials, query or fragment');
    origin = parsed.origin;
  }
  apiBase = apiBase.replace(/\/+$/, '');
  const policy = `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ${origin}; base-uri 'none'; form-action 'none'`;
  return {
    html: documentHTML({
      apiBase, enabled: Boolean(apiBase),
      policy: '<meta http-equiv="Content-Security-Policy" content="' + escape(policy) + '">',
      style: '<link rel="stylesheet" href="/blog/comment/admin.css?v=2">',
      script: '<script defer src="/blog/comment/admin.js?v=2"></script>',
    }),
    script: SCRIPT,
    style: STYLE,
  };
}

export function adminPage() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = documentHTML({ apiBase: '', enabled: true, style: `<style nonce="${nonce}">${STYLE}</style>`, script: '' });
  return new Response(html.replace('</body>', `<script nonce="${nonce}">${SCRIPT}</script></body>`), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  } });
}
