import routes from './routes.json' with { type: 'json' };

const HOSTS = new Set(['xht37.com', 'www.xht37.com']);
const TARGET = 'https://pku-xht.github.io';

export function destination(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  if (!HOSTS.has(url.hostname)) return null;
  // Encoded separators, controls and a decoded percent can change meaning
  // across URL parsers or an additional decoding pass. Fail closed.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f|25)/i.test(url.pathname)) return null;
  let path;
  try { path = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/'; }
  catch { return null; }
  if (/[\\\x00-\x1f\x7f%]/.test(path)) return null;
  // Never let an extra parameter change WordPress behavior behind a redirect.
  if (url.search) {
    if (path !== '/' && path !== '/index.php') return null;
    const entries = [...url.searchParams];
    if (entries.length !== 1) return null;
    const [name, value] = entries[0];
    if (!['p', 'page_id'].includes(name) || !/^[1-9]\d*$/.test(value)) return null;
    const key = `${name}=${value}`;
    return Object.hasOwn(routes.queries, key) ? routes.queries[key] : null;
  }
  if (path === '/') return '/blog/';
  return Object.hasOwn(routes.paths, path) ? routes.paths[path] : null;
}

export default {
  async fetch(request, env) {
    const target = destination(request);
    if (!target) return fetch(request);
    const status = env.REDIRECT_STATUS === '301' ? 301 : 302;
    return new Response(null, { status, headers: { Location: TARGET + target, 'Cache-Control': status === 302 ? 'no-store' : 'public, max-age=3600' } });
  }
};
