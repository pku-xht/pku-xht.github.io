import { ADMIN_SCRIPT } from './admin-client.mjs';
import { adminLoginForm } from './admin-auth.mjs';
import { ADMIN_STYLE } from './admin-style.mjs';

const STYLE = ADMIN_STYLE;
const SCRIPT = ADMIN_SCRIPT;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function documentHTML({ apiBase, enabled, style, script, policy = '' }) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">${policy}
<title>评论管理 · 徐皓天</title>${style}${script}</head>
<body data-admin-api="${escape(apiBase)}" data-admin-enabled="${enabled}">
<header class="admin-header"><div class="admin-width">
<a class="identity" href="https://pku-xht.github.io/blog/">徐皓天 <span class="identity-note">/ 博客</span></a>
<nav class="admin-nav" aria-label="后台导航"><a href="https://pku-xht.github.io/blog/comment/" aria-current="page">评论管理</a><a href="https://pku-xht.github.io/blog/">返回博客 ↗</a></nav>
</div></header>
<main class="admin-width">
<section class="page-intro"><p class="eyebrow">COMMENTS</p><h1>评论管理</h1><p>在这里查看和管理所有文章的留言与回复。</p></section>
${adminLoginForm()}
<p id="message" role="status" aria-live="polite">${enabled ? '请输入管理员密码后登录。' : '评论管理服务尚未配置。'}</p>
<section id="management" hidden>
<div class="management-heading"><p id="summary">正在读取评论概况…</p><div class="management-actions"><button id="refresh" type="button" disabled>刷新评论</button><button id="logout" class="quiet" type="button" disabled>退出登录</button></div></div>
<div class="comment-filters">
<label for="status">评论状态<select id="status" disabled><option value="all">全部评论</option><option value="pending">待审核</option><option value="approved">已公开</option><option value="rejected">已拒绝</option></select></label>
<label for="document-filter">所属文章<select id="document-filter" disabled><option value="">全部文章</option></select></label>
<label class="filter-search" for="search">搜索评论<input id="search" type="search" maxlength="200" placeholder="搜索昵称或评论内容" autocomplete="off" disabled></label>
</div>
<p id="loaded-count" aria-live="polite"></p>
<div id="comments"></div>
<p id="empty-state" hidden>没有符合条件的评论。</p>
<div class="pagination"><button id="more" type="button" hidden disabled>加载更多评论</button></div>
</section>
<noscript><p>评论管理需要启用 JavaScript。</p></noscript></main>
<footer class="admin-footer"><div class="admin-width">徐皓天 · xht37</div></footer></body></html>\n`;
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
      style: '<link rel="stylesheet" href="/blog/comment/admin.css?v=3">',
      script: '<script defer src="/blog/comment/admin.js?v=3"></script>',
    }),
    script: SCRIPT,
    style: STYLE,
  };
}

export function adminPage() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = documentHTML({ apiBase: '', enabled: true, style: `<style nonce="${nonce}">${STYLE}</style>`, script: '' });
  return new Response(html.replace('</body>', () => `<script nonce="${nonce}">${SCRIPT}</script></body>`), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  } });
}
