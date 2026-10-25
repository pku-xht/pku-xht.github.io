/** Shared password-manager-friendly login markup and raw browser helpers. */
import { ADMIN_SESSION_HELPERS } from './admin-session-client.mjs';
export function adminLoginForm() {
  return `<form id="login-form" class="login-panel" method="post" autocomplete="on">
<h2 class="login-heading">管理员登录</h2>
<label for="username">账号 <input id="username" name="username" type="text" value="admin" autocomplete="username" readonly disabled></label>
<label for="token">管理员密码 <input id="token" name="password" type="password" autocomplete="current-password" required spellcheck="false" disabled></label>
<button id="load" class="primary" type="submit" disabled>登录</button>
<p class="form-note">在此浏览器保持登录 30 天，评论管理与文章编辑通用。你也可以随时退出登录。</p>
</form>`;
}

// Embed this source string inside each client's own scope. Serializing a
// function after bundling can capture helpers introduced by the bundler.
export const ADMIN_AUTH_HELPERS = ADMIN_SESSION_HELPERS + String.raw`
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
`;
