/** Shared password-manager-friendly login markup and raw browser helpers. */
export function adminLoginForm() {
  return `<form id="login-form" method="post" autocomplete="on">
<label for="username">账号 <input id="username" name="username" type="text" value="admin" autocomplete="username" readonly disabled></label>
<label for="token">管理员密码 <input id="token" name="password" type="password" autocomplete="current-password" required spellcheck="false" disabled></label>
<button id="load" type="submit" disabled>登录</button>
</form>`;
}

// Embed this source string inside each client's own scope. Serializing a
// function after bundling can capture helpers introduced by the bundler.
export const ADMIN_AUTH_HELPERS = String.raw`
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
