import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { destination } from './worker.mjs';

const routes = JSON.parse(await readFile(new URL('./routes.json', import.meta.url)));
const request = (path, method = 'GET', host = 'www.xht37.com') => new Request(`https://${host}${path}`, { method });
assert.equal(destination(request('/')), '/blog/');
assert.equal(destination(request('/', 'HEAD', 'xht37.com')), '/blog/');
for (const [path, target] of Object.entries(routes.paths)) {
  assert.match(target, /^\/blog\//);
  assert.equal(new URL(target, 'https://pku-xht.github.io').origin, 'https://pku-xht.github.io');
  assert.equal(destination(request(encodeURI(path))), target, path);
  assert.equal(destination(request(encodeURI(path) + '/')), target, path);
}
for (const [query, target] of Object.entries(routes.queries)) {
  assert.equal(destination(request('/?' + query)), target, query);
  assert.equal(destination(request('/index.php?' + query)), target, query);
}
for (const path of ['/wp-admin/', '/wp-admin/?p=1154', '/wp-login.php?p=1154', '/wp-json/?p=1154', '/index.php?rest_route=/wp/v2/posts&p=1154', '/feed/', '/sitemap.xml', '/unknown-private/', '/?p=999999999', '/?page_id=999999999', '/?page_id=1154', '/?p=215', '/?p=01154', '/?p=1154&preview=true', '/?p=1154&p=1154', '/?rest_route=/wp/v2/posts', '/?s=test', '/%ZZ', '/%2f', '/%5c', '/%252f', '/%00', '/%7f', '/__proto__']) {
  assert.equal(destination(request(path)), null, path);
}
assert.equal(destination(request('/', 'POST')), null);
assert.equal(destination(request('/', 'GET', 'another.example')), null);
const first = Object.entries(routes.paths)[0];
assert.equal(destination(request(encodeURI(first[0]) + '?preview=true')), null);
assert.equal(destination(request(encodeURI(first[0]).replace('/', '/%2f'))), null);
let response = await worker.fetch(request('/'), {});
assert.equal(response.status, 302);
assert.equal(response.headers.get('location'), 'https://pku-xht.github.io/blog/');
assert.equal(response.headers.get('cache-control'), 'no-store');
response = await worker.fetch(request('/'), { REDIRECT_STATUS: '301' });
assert.equal(response.status, 301);
// Location has no fragment; the browser carries the incoming fragment under HTTP redirect semantics.
assert.equal(new URL(response.headers.get('location')).hash, '');
const savedFetch = globalThis.fetch;
try {
  const original = request('/wp-login.php', 'POST');
  globalThis.fetch = async req => { assert.equal(req, original); return new Response('origin'); };
  response = await worker.fetch(original, {});
  assert.equal(await response.text(), 'origin');
} finally { globalThis.fetch = savedFetch; }
console.log(`OK: ${Object.keys(routes.paths).length} paths and ${Object.keys(routes.queries).length} query mappings`);
