'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

// Only the DOM surface and HTTP boundary are simulated. Each test executes
// the maintained browser script, without copying its filtering or API logic.

function attrName(key) { return 'data-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()); }
function matchSimple(node, selector) {
  const tag = selector.match(/^[A-Za-z][\w-]*/)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const name of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(name[1])) return false;
  for (const id of selector.matchAll(/#([\w-]+)/g)) if (node.id !== id[1]) return false;
  for (const attr of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    if (!node.hasAttribute(attr[1])) return false;
    if (attr[2] !== undefined && node.getAttribute(attr[1]) !== attr[2]) return false;
  }
  return true;
}
function matches(node, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchSimple(node, parts.pop())) return false;
  let ancestor = node.parentNode;
  while (parts.length) {
    const part = parts.pop();
    while (ancestor && !matchSimple(ancestor, part)) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}
class Element {
  constructor(tag, document) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.parentNode = null;
    this.attributes = new Map(); this.listeners = new Map(); this.value = ''; this.disabled = false; this._text = '';
    this.dataset = new Proxy({}, { get: (_, key) => this.attributes.get(attrName(key)), set: (_, key, value) => { this.attributes.set(attrName(key), String(value)); return true; } });
    this.classList = { contains: (name) => this.className.split(/\s+/).includes(name) };
  }
  get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
  get type() { return this.getAttribute('type') || ''; } set type(v) { this.setAttribute('type', v); }
  get href() { return this.getAttribute('href') || ''; } set href(v) { this.setAttribute('href', v); }
  get target() { return this.getAttribute('target') || ''; } set target(v) { this.setAttribute('target', v); }
  get hidden() { return this.hasAttribute('hidden'); } set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get parentElement() { return this.parentNode; } get firstChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children.forEach((child) => { child.parentNode = null; }); this.children = []; }
  set innerHTML(_) { throw new Error('Unsafe innerHTML write'); }
  get innerHTML() { throw new Error('Unexpected innerHTML read'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { return this.insertBefore(child, null); }
  replaceChildren(...children) { this.textContent = ''; children.forEach((child) => this.appendChild(child)); }
  insertBefore(child, before) {
    if (child.contains(this)) throw new Error('DOM cycle');
    if (child.parentNode) child.remove();
    const index = before === null ? this.children.length : this.children.indexOf(before);
    if (index < 0) throw new Error('Reference is not a child');
    this.children.splice(index, 0, child); child.parentNode = this; return child;
  }
  remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
  contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
  querySelectorAll(selector) {
    const found = []; const choices = selector.split(',');
    const visit = (node) => { for (const child of node.children) { if (choices.some((choice) => matches(child, choice))) found.push(child); visit(child); } };
    visit(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let n = this; n; n = n.parentNode) if (matches(n, selector)) return n; return null; }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  async fire(type, extra = {}) {
    const event = { type, target: this, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (let node = this; node; node = node.parentNode) for (const handler of node.listeners.get(type) || []) await handler(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  setCustomValidity(text) { this.validationMessage = text; }
  reportValidity() { return !this.validationMessage; }
}
function environment(href = 'http://127.0.0.1:8791/blog/posts/1154/') {
  const doc = new Element('document'); doc.ownerDocument = doc; doc.readyState = 'complete';
  doc.createElement = (tag) => new Element(tag, doc);
  doc.createTextNode = (value) => { const node = new Element('#text', doc); node.nodeType = 3; node.nodeValue = String(value); node.textContent = value; return node; };
  doc.getElementById = (id) => doc.querySelector('#' + id);
  const windowEvents = new Map(); let random = 0;
  const win = { location: { href }, setTimeout, clearTimeout, isSecureContext: true, crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++random).padStart(12, '0') },
    addEventListener(type, fn) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(fn); },
    history: { pushState(_, __, url) { win.location.href = String(url); } },
    async fire(type) { for (const fn of windowEvents.get(type) || []) await fn(); } };
  const calls = []; let handleFetch = async () => { throw new Error('Unexpected fetch'); };
  // A tiny inert HTML fixture parser supplies browser-owned parsing; sanitizer
  // behavior itself is exercised only through the maintained application code.
  class DOMParser {
    parseFromString(value) {
      const root = doc.createElement('body'), stack = [root];
      const decode = (value) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);
      for (const token of value.match(/<[^>]*>|[^<]+/g) || []) {
        const closing = token.match(/^<\/([\w-]+)\s*>$/);
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        const opening = token.match(/^<([\w-]+)\b([^>]*)>$/);
        if (opening) {
          const node = doc.createElement(opening[1]);
          for (const attr of opening[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) node.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4]));
          stack.at(-1).appendChild(node);
          if (!/^(?:br|hr|img|input|embed|link|meta|base|source)$/i.test(opening[1])) stack.push(node);
        } else stack.at(-1).appendChild(doc.createTextNode(decode(token)));
      }
      return { body: root };
    }
  }
  const context = vm.createContext({ document: doc, window: win, HTMLElement: Element, DOMParser, URL, URLSearchParams, AbortController, Intl, Uint8Array, console,
    fetch: async (url, options) => { calls.push({ url: String(url), options, payload: options.body ? JSON.parse(options.body) : null }); return handleFetch(String(url), options, calls.at(-1)); } });
  function el(tag, attrs = {}, parent = doc, text) { const node = doc.createElement(tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; parent.appendChild(node); return node; }
  return { doc, win, calls, el, setFetch(fn) { handleFetch = fn; }, run(file) { const source = path.join(ROOT, file); vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source }); } };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function commentsFixture(enabled = true, api = 'https://comments.example.test/') {
  const env = environment(); const { el } = env;
  const section = el('section', { class: 'comments-section', 'data-document-id': '1154', 'data-comments-enabled': String(enabled), 'data-blog-api': api });
  const heading = el('h2', {}, section);
  const count = el('span', { 'data-comment-count': '' }, heading, '');
  const empty = el('p', { class: 'comments-empty', hidden: '' }, section, 'No comments');
  const loadStatus = el('p', { class: 'comments-load-status' }, section);
  const list = el('ol', { class: 'comment-list' }, section);
  const more = el('button', { type: 'button', 'data-comments-more': '', hidden: '' }, section);
  const form = el('form', { class: 'comment-form' }, section);
  const nickname = el('input', { name: 'nickname', required: '', maxlength: '40' }, form);
  const body = el('textarea', { name: 'body', required: '', maxlength: '10000' }, form);
  const website = el('input', { name: 'website' }, form);
  const submit = el('button', { type: 'submit' }, form, 'Submit');
  const status = el('p', { class: 'comment-form-status', role: 'status' }, form);
  return { ...env, section, count, empty, loadStatus, list,
    get old() { return section.querySelector('[data-comment-id="wp-12"]'); },
    get reply() { return this.old?.querySelector('[data-comment-reply]'); },
    more, form, nickname, body, website, submit, status };
}
const parentComment = { id: 'wp-12', document: '1154', nickname: 'Parent author', body: 'Existing approved comment', parent_id: null, created_at: '2020-01-02T00:00:00Z' };
function visitsFixture(enabled = true) {
  const env = environment(); const { el } = env;
  const container = el('p', { 'data-blog-visits': '', 'data-visits-enabled': String(enabled), 'data-blog-api': 'https://comments.example.test/', 'data-document-id': '1154', hidden: '' });
  const site = el('span', { 'data-site-visits': '' }, container);
  const wrapper = el('span', { 'data-document-visits-wrapper': '' }, container);
  const count = el('span', { 'data-document-visits': '' }, wrapper);
  const retry = el('button', { 'data-visits-retry': '', type: 'button', hidden: '' });
  return { ...env, container, site, count, retry };
}
async function main() {
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log('PASS', name); };
  await check('disabled comments never fetch, including a forced submit', async () => {
    const f = commentsFixture(false, ''); f.run('blog/interactions.js'); await flush();
    f.nickname.value = 'Name'; f.body.value = 'Draft'; await f.form.fire('submit');
    assert.equal(f.calls.length, 0); assert.equal(f.submit.disabled, true); assert.match(f.status.textContent, /评论暂未开放/); assert.equal(f.body.value, 'Draft'); assert.equal(f.section.querySelector('[data-comment-reply]'), null);
  });
  await check('approved GET preserves plain text, excludes pending and joins all replies', async () => {
    const f = commentsFixture();
    const xss = '<img src=x onerror="attack()">\n<script>attack()</script>';
    f.setFetch(async () => response({ comments: [
      parentComment,
      { id: 'approved-one', document: '1154', nickname: '<svg onload=attack()>', body: xss, parent_id: 'wp-12', created_at: '2026-10-25T00:00:00Z' },
      { id: 'pending-one', document: '1154', nickname: 'Pending', body: 'Must stay hidden', status: 'pending' },
      { id: 'wrong-doc', document: '2', nickname: 'Wrong', body: 'Must stay hidden' }
    ], next_cursor: null }));
    f.run('blog/interactions.js'); await flush();
    assert.equal(f.section.querySelectorAll('[data-comment-id]').length, 2);
    const node = f.section.querySelector('[data-comment-id="approved-one"]');
    assert.equal(node.querySelector('.comment-text').textContent, xss); assert.equal(node.querySelector('img'), null); assert.equal(node.querySelector('script'), null);
    assert.equal(node.querySelector('.comment-author').textContent, '<svg onload=attack()>'); assert.equal(node.parentNode.parentNode, f.old);
    assert.equal(f.calls[0].options.credentials, 'omit');
    assert.equal(f.count.textContent, '2'); assert.equal(f.empty.hidden, true);
    f.run('blog/interactions.js'); await flush(); assert.equal(f.count.textContent, '2'); assert.equal(f.calls.length, 1);
    const first = commentsFixture();
    first.setFetch(async () => response({ comments: [{ id: 'first-approved', document: '1154', nickname: 'First', body: 'Approved', parent_id: null }], next_cursor: null }));
    first.run('blog/interactions.js'); await flush(); assert.equal(first.count.textContent, '1'); assert.equal(first.empty.hidden, true);
  });
  await check('service failure or moderation never restores a static comment copy', async () => {
    const f = commentsFixture();
    f.el('li', { class: 'comment-item', 'data-comment-id': 'wp-12' }, f.list, 'Stale static copy');
    let failed = true;
    f.setFetch(async () => { if (failed) throw new Error('Offline'); return response({ comments: [], next_cursor: null }); });
    f.run('blog/interactions.js'); await flush();
    assert.equal(f.section.querySelectorAll('[data-comment-id]').length, 0); assert.equal(f.count.textContent, '');
    assert.match(f.loadStatus.textContent, /评论暂时无法加载/); assert.doesNotMatch(f.section.textContent, /Stale static copy|历史评论|旧站/);
    failed = false; await f.more.fire('click'); await flush();
    assert.equal(f.section.querySelectorAll('[data-comment-id]').length, 0); assert.equal(f.count.textContent, '0'); assert.equal(f.empty.hidden, false);
  });
  await check('HTML comments rebuild only safe DOM, preserve formatting and render math locally', async () => {
    const f = commentsFixture(); const mathCalls = [];
    f.win.katex = { render(tex, target, options) { mathCalls.push({ tex, options }); target.textContent = 'Rendered ' + tex; } };
    const html = '<p onclick="attack()">hello <strong>bold</strong> $x_i$<br>next</p><pre><code class="language-cpp">$literal$ &amp; code  </code></pre><a href="javascript:attack()">unsafe link</a><a href="https://example.test/path" onclick="attack()">safe link</a><script>attack()</script><img src="https://tracking.test/image" onerror="attack()"><svg><a href="https://evil.test/">inert</a></svg>';
    f.setFetch(async () => response({ comments: [{ ...parentComment, body_html: html, author_url: 'https://author.example.test/' }], next_cursor: null }));
    f.run('blog/interactions.js'); await flush();
    const body = f.old.querySelector('.comment-body');
    assert.ok(body.querySelector('strong')); assert.ok(body.querySelector('br')); assert.equal(body.querySelector('code').textContent, '$literal$ & code  ');
    assert.equal(body.querySelector('script'), null); assert.equal(body.querySelector('img'), null); assert.equal(body.querySelector('svg'), null);
    const links = body.querySelectorAll('a'); assert.equal(links.length, 2); assert.equal(links[0].getAttribute('href'), null); assert.equal(links[1].href, 'https://example.test/path');
    assert.equal(links[1].getAttribute('onclick'), null); assert.equal(links[1].getAttribute('rel'), 'ugc nofollow noopener noreferrer');
    assert.equal(f.old.querySelector('.comment-author').href, 'https://author.example.test/');
    assert.equal(f.old.id, 'comment-12'); assert.equal(f.old.querySelector('time').dateTime, parentComment.created_at);
    assert.match(f.old.querySelector('time').textContent, /08:00:00/);
    assert.equal(mathCalls.length, 1); assert.equal(mathCalls[0].tex, 'x_i'); assert.equal(mathCalls[0].options.trust, false);
    assert.equal(body.querySelector('[data-original-math]').getAttribute('data-original-math'), '$x_i$');
  });
  await check('nickname is trimmed, mandatory and length-limited; body is mandatory', async () => {
    const f = commentsFixture(); f.setFetch(async () => response({ comments: [], next_cursor: null })); f.run('blog/interactions.js'); await flush();
    for (const name of ['', '   ', 'x'.repeat(41)]) { f.nickname.value = name; f.body.value = 'Draft'; await f.form.fire('submit'); }
    f.nickname.value = 'Name'; f.body.value = ' \n '; await f.form.fire('submit');
    assert.equal(f.calls.filter((call) => call.options.method === 'POST').length, 0); assert.equal(f.body.getAttribute('aria-invalid'), 'true');
  });
  await check('network retry keeps the request id; 202 pending never enters public DOM', async () => {
    const f = commentsFixture(); let posts = 0;
    f.setFetch(async (_, options) => {
      if (options.method !== 'POST') return response({ comments: [], next_cursor: null });
      if (++posts === 1) throw new Error('Response lost after network send');
      return response({ id: 'pending-id', status: 'pending' }, 202);
    });
    f.run('blog/interactions.js'); await flush();
    f.nickname.value = '  Name  '; f.body.value = 'Draft'; await f.form.fire('submit');
    assert.equal(f.nickname.value, '  Name  '); assert.equal(f.body.value, 'Draft');
    await f.form.fire('submit');
    const requests = f.calls.filter((call) => call.options.method === 'POST');
    assert.equal(requests.length, 2); assert.equal(requests[0].payload.request_id, requests[1].payload.request_id); assert.equal(requests[0].payload.nickname, 'Name');
    assert.equal(f.section.querySelectorAll('[data-comment-id]').length, 0); assert.equal(f.count.textContent, '0'); assert.equal(f.empty.hidden, false); assert.equal(f.nickname.value, ''); assert.equal(f.body.value, ''); assert.match(f.status.textContent, /等待审核/);
  });
  await check('HTTP errors preserve the draft; every reply uses its stable service id', async () => {
    const f = commentsFixture(); f.setFetch(async (_, options) => options.method === 'POST' ? response({ error: 'rate_limited' }, 429) : response({ comments: [parentComment], next_cursor: null }));
    f.run('blog/interactions.js'); await flush();
    assert.equal(f.reply.hidden, false); assert.equal(f.reply.disabled, false); assert.equal(f.reply.hasAttribute('disabled'), false); assert.equal(f.old.id, 'comment-12');
    await f.reply.fire('click');
    f.nickname.value = 'Name'; f.body.value = 'Reply draft'; await f.form.fire('submit');
    assert.equal(f.calls.at(-1).payload.parent_id, 'wp-12'); assert.equal(f.body.value, 'Reply draft'); assert.match(f.status.textContent, /稍后重试/);
    await f.form.querySelector('[data-cancel-reply]').fire('click');
    await f.form.fire('submit'); assert.equal(f.calls.at(-1).payload.parent_id, null);
  });
  await check('pagination cursor is respected and a later parent reparents its loaded reply', async () => {
    const f = commentsFixture(); let page = 0;
    f.setFetch(async () => response([
      { comments: [], next_cursor: 100 },
      { comments: [{ id: 'child', document: '1154', nickname: 'Child', body: 'Text', parent_id: 'parent' }], next_cursor: 200 },
      { comments: [{ id: 'parent', document: '1154', nickname: 'Parent', body: 'Text', parent_id: null }, { id: 'child', document: '1154', nickname: 'Child', body: 'Text', parent_id: 'parent' }], next_cursor: null }
    ][page++]));
    f.run('blog/interactions.js'); await flush(); await f.more.fire('click'); await flush();
    assert.match(f.calls[1].url, /cursor=100/); assert.equal(f.section.querySelector('[data-comment-id="child"]').parentNode, f.list);
    await f.more.fire('click'); await flush();
    const parent = f.section.querySelector('[data-comment-id="parent"]'); const child = f.section.querySelector('[data-comment-id="child"]');
    assert.match(f.calls[2].url, /cursor=200/); assert.equal(child.parentNode.parentNode, parent); assert.equal(child.querySelector('.comment-missing-parent'), null); assert.equal(f.more.hidden, true);
    assert.equal(f.count.textContent, '2'); assert.equal(f.section.querySelectorAll('[data-comment-id]').length, 2);
  });
  await check('visits disabled in DOM has zero network calls', async () => {
    const f = visitsFixture(false); f.run('blog/visits.js'); await flush(); assert.equal(f.calls.length, 0); assert.equal(f.container.hidden, true);
  });
  await check('server-disabled visits never POST or expose zero', async () => {
    const f = visitsFixture(); f.setFetch(async () => response({ enabled: false, seeded: false, site: null, document: null, document_id: null }));
    f.run('blog/visits.js'); await flush(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.method, undefined); assert.equal(f.site.textContent, ''); assert.equal(f.container.hidden, true);
  });
  await check('unseeded visits never POST or expose zero', async () => {
    const f = visitsFixture(); f.setFetch(async () => response({ enabled: true, seeded: false, site: null, document: null, document_id: '1154' }));
    f.run('blog/visits.js'); await flush(); assert.equal(f.calls.length, 1); assert.equal(f.container.dataset.visitsState, 'unseeded'); assert.equal(f.count.textContent, ''); assert.equal(f.container.hidden, true);
  });
  await check('visits retry reuses one load nonce and duplicate script initialization never recounts', async () => {
    const f = visitsFixture(); let posts = 0;
    const stats = { enabled: true, seeded: true, site: 101, document: 9, document_id: '1154' };
    f.setFetch(async (_, options) => {
      if (options.method !== 'POST') return response(stats);
      if (++posts === 1) throw new Error('POST response lost');
      return response({ ...stats, counted: false });
    });
    f.run('blog/visits.js'); await flush(); assert.equal(f.container.hidden, true); assert.equal(f.retry.hidden, false);
    await f.retry.fire('click'); await flush();
    const requests = f.calls.filter((call) => call.options.method === 'POST');
    assert.equal(requests.length, 2); assert.equal(requests[0].payload.nonce, requests[1].payload.nonce); assert.equal(requests[0].payload.document, '1154');
    assert.equal(f.container.hidden, false); assert.equal(f.site.textContent, '101'); assert.equal(f.count.textContent, '9');
    assert.ok(f.calls.every((call) => call.options.credentials === 'omit'));
    f.run('blog/visits.js'); await f.win.fire('online'); await flush(); assert.equal(f.calls.length, 4);
  });
  await check('tag URL restore, text intersection, clear, history and modified links', async () => {
    const f = environment('http://127.0.0.1:8791/blog/?tag=104'); const { el } = f;
    const cloud = el('ul', { class: 'tag-cloud' });
    const tag104 = el('a', { href: '/blog/tags/104/', 'data-tag-id': '104', 'data-tag-name': '2-SAT' }, cloud, '2-SAT');
    const tag105 = el('a', { href: '/blog/tags/105/', 'data-tag-id': '105', 'data-tag-name': 'AC' }, cloud, 'AC');
    const form = el('form', { class: 'search-form', hidden: '' });
    const input = el('input', { id: 'blog-search', type: 'search' }, form);
    el('button', { id: 'clear-search', type: 'button' }, form);
    const active = el('p', { class: 'active-tag-filter', hidden: '' }); el('span', { 'data-active-tag': '' }, active);
    const clearTag = el('button', { 'data-clear-tag': '', type: 'button' }, active);
    const count = el('p', { id: 'search-count' }); const list = el('div', { class: 'post-list', 'data-tag-filter': 'all' });
    const cards = [['first Mo', '104'], ['second tree', '104 105'], ['third Mo', '105']].map(([text, tags]) => el('article', { class: 'post-card', 'data-search': text, 'data-tags': tags }, list));
    el('p', { id: 'no-results', hidden: '' }); f.run('blog/blog.js');
    assert.deepEqual(cards.map((node) => node.hidden), [false, false, true]); assert.equal(form.hidden, false);
    input.value = 'Mo'; await input.fire('input'); assert.deepEqual(cards.map((node) => node.hidden), [false, true, true]);
    await tag105.fire('click'); assert.match(f.win.location.href, /tag=105/); assert.deepEqual(cards.map((node) => node.hidden), [true, true, false]);
    await clearTag.fire('click'); assert.equal(input.value, 'Mo'); assert.deepEqual(cards.map((node) => node.hidden), [false, true, false]); assert.equal(active.hidden, true);
    f.win.location.href = 'http://127.0.0.1:8791/blog/?tag=104'; await f.win.fire('popstate'); assert.deepEqual(cards.map((node) => node.hidden), [false, true, true]);
    const modified = await tag104.fire('click', { ctrlKey: true }); assert.equal(modified.defaultPrevented, false); assert.equal(tag104.href, '/blog/tags/104/'); assert.match(count.textContent, /1/);
  });
  console.log(JSON.stringify({ passed, failed: 0, environment: 'Node VM with isolated DOM and mocked HTTP; no network' }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
