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
  getBoundingClientRect() { return { left: 0, width: 760 }; }
  focus() { this.ownerDocument.activeElement = this; }
  setCustomValidity(text) { this.validationMessage = text; }
  reportValidity() { return !this.validationMessage; }
}
function environment(href = 'http://127.0.0.1:8791/blog/posts/1154/') {
  const doc = new Element('document'); doc.ownerDocument = doc; doc.readyState = 'complete';
  doc.createElement = (tag) => new Element(tag, doc);
  doc.createElementNS = (_, tag) => new Element(tag, doc);
  doc.createTextNode = (value) => { const node = new Element('#text', doc); node.nodeType = 3; node.nodeValue = String(value); node.textContent = value; return node; };
  doc.getElementById = (id) => doc.querySelector('#' + id);
  const windowEvents = new Map(); let random = 0;
  const win = { location: { href }, setTimeout, clearTimeout, isSecureContext: true, crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++random).padStart(12, '0') },
    addEventListener(type, fn) { if (!windowEvents.has(type)) windowEvents.set(type, []); windowEvents.get(type).push(fn); },
    history: {
      pushState(_, __, url) { win.location.href = String(url); },
      replaceState(_, __, url) { win.location.href = String(url); },
    },
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
function rankingFixture(enabled = true, api = 'https://ranking.example.test/') {
  const env = environment('http://127.0.0.1:8791/blog/ranking/'); const { el } = env;
  const section = el('section', { 'data-visits-ranking': '', 'data-ranking-enabled': String(enabled), 'data-blog-api': api });
  el('h2', {}, section, '累计 · TOP 10');
  const list = el('ol', { 'data-ranking-list': '', hidden: '' }, section);
  const status = el('p', { 'data-ranking-status': '', role: 'status' }, section, '正在加载排行…');
  const retry = el('button', { type: 'button', 'data-ranking-retry': '', hidden: '' }, section, '重试');
  const form = el('form', { class: 'search-form', action: '/blog/', method: 'get', hidden: '' });
  const input = el('input', { id: 'blog-search', name: 'q', type: 'search' }, form);
  el('button', { id: 'clear-search', type: 'button' }, form);
  const registry = el('ul', { 'data-ranking-source': '', hidden: '' });
  const titles = [];
  for (let index = 1; index <= 12; index++) {
    const row = el('li', {}, registry);
    titles.push(el('a', { href: '/blog/posts/' + index + '/' }, row, 'Article ' + index));
  }
  return { ...env, section, list, status, retry, registry, titles, form, input };
}

function dailyFixture(enabled = true) {
  const env = rankingFixture(), { el } = env;
  const daily = el('section', { 'data-daily-visits': '', 'data-daily-enabled': String(enabled), 'data-blog-api': 'https://ranking.example.test/' });
  const buttons = ['7', '30', 'year', 'all'].map((value) => el('button', { 'data-daily-range': value, 'aria-pressed': String(value === '30') }, daily));
  const summary = el('div', { 'data-daily-summary': '', hidden: '' }, daily), chart = el('div', { 'data-daily-chart': '', hidden: '' }, daily);
  const detail = el('p', { 'data-daily-detail': '', hidden: '' }, daily), control = el('label', { 'data-daily-date-control': '', hidden: '' }, daily);
  const slider = el('input', { 'data-daily-date': '', type: 'range' }, control), caption = el('p', { 'data-daily-caption': '', hidden: '' }, daily);
  const status = el('p', { 'data-daily-status': '' }, daily), retry = el('button', { 'data-daily-retry': '', hidden: '' }, daily);
  return { ...env, daily, buttons, summary, chart, detail, control, slider, caption, dailyStatus: status, dailyRetry: retry };
}
function dailyData(items = [{ date: '2026-11-01', visits: 12, partial: false }, { date: '2026-11-02', visits: 3, partial: true }]) {
  return { enabled: true, seeded: true, history_seeded: true, timezone: 'Asia/Shanghai', as_of: '2026-11-02T04:00:00Z', first_date: items[0]?.date ?? null, from: items[0]?.date ?? null, to: items.at(-1)?.date ?? null, items };
}
function searchFixture(href = 'http://127.0.0.1:8791/blog/', withCards = true) {
  const env = environment(href); const { el } = env;
  const form = el('form', { class: 'search-form', action: '/blog/', method: 'get', hidden: '' });
  const input = el('input', { id: 'blog-search', name: 'q', type: 'search' }, form);
  const clear = el('button', { id: 'clear-search', type: 'button' }, form);
  if (!withCards) return { ...env, form, input, clear };
  const count = el('p', { id: 'search-count' });
  const noResults = el('p', { id: 'no-results', hidden: '' });
  const list = el('div', { class: 'post-list' });
  const cards = ['first Mo', 'second tree', 'third Mo'].map((text) => el('article', { class: 'post-card', 'data-search': text }, list));
  return { ...env, form, input, clear, count, noResults, list, cards };
}
const rankingData = (items = Array.from({ length: 10 }, (_, index) => ({ document: String(index + 1), visits: 1000 - index }))) => ({ enabled: true, seeded: true, items });
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
  await check('a personal homepage without a Visits widget has zero network calls', async () => {
    const f = environment('http://127.0.0.1:8791/');
    f.run('blog/visits.js'); await flush(); assert.equal(f.calls.length, 0);
  });
  await check('blog homepage retries site-only POST with the same nonce', async () => {
    const f = environment('http://127.0.0.1:8791/blog/');
    const container = f.el('p', { 'data-blog-visits': '', 'data-visits-enabled': 'true', 'data-blog-api': 'https://example.test/', 'data-document-id': '', hidden: '' });
    const site = f.el('span', { 'data-site-visits': '' }, container);
    const stats = { enabled: true, seeded: true, site: 101, document: null, document_id: null };
    let posts = 0;
    f.setFetch(async (_, options) => { if (options.method !== 'POST') return response(stats); if (++posts === 1) throw new Error('lost response'); return response(stats); });
    f.run('blog/visits.js'); await flush(); assert.equal(container.hidden, true); assert.equal(container.dataset.visitsState, 'error');
    await f.win.fire('online'); await flush(); const requests = f.calls.filter((call) => call.options.method === 'POST');
    assert.equal(requests.length, 2); assert.equal(requests[0].payload.nonce, requests[1].payload.nonce);
    assert.equal('document' in requests[0].payload, false); assert.ok(f.calls.every((call) => !call.url.includes('?document=')));
    assert.equal(container.hidden, false); assert.equal(site.textContent, '101');
    f.run('blog/visits.js'); await flush(); assert.equal(f.calls.length, 4);
  });
  await check('blog homepage unseeded site stays hidden without POST', async () => {
    const f = environment('http://127.0.0.1:8791/blog/');
    const container = f.el('p', { 'data-blog-visits': '', 'data-visits-enabled': 'true', 'data-blog-api': 'https://example.test/', 'data-document-id': '', hidden: '' });
    f.el('span', { 'data-site-visits': '' }, container);
    f.setFetch(async () => response({ enabled: true, seeded: false, site: null }));
    f.run('blog/visits.js'); await flush(); assert.equal(f.calls.length, 1); assert.equal(container.hidden, true); assert.equal(container.dataset.visitsState, 'unseeded');
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
  await check('standalone ranking renders ten safe links from its maintained registry, independently of search', async () => {
    const f = rankingFixture();
    const title = '<img src=x onerror="attack()"> & maintained title';
    f.titles[0].textContent = title;
    f.setFetch(async () => response(rankingData()));
    f.run('blog/visits-ranking.js'); await flush();
    assert.equal(f.list.querySelectorAll('li').length, 10);
    assert.equal(f.list.querySelector('.ranking-title').textContent, title);
    assert.equal(f.list.querySelector('img'), null);
    assert.deepEqual(f.list.querySelectorAll('a').map((link) => link.href), Array.from({ length: 10 }, (_, index) => '/blog/posts/' + (index + 1) + '/'));
    assert.equal(f.list.querySelector('.ranking-views').textContent, '1,000');
    const entries = f.list.textContent;
    f.run('blog/blog.js'); f.input.value = 'absent term'; await f.input.fire('input');
    assert.equal(f.doc.querySelectorAll('.post-card').length, 0);
    assert.equal(f.form.hidden, false); assert.equal((await f.form.fire('submit')).defaultPrevented, false);
    assert.equal(f.list.hidden, false); assert.equal(f.list.textContent, entries);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://ranking.example.test/v1/visits/ranking');
    assert.equal(f.calls[0].options.method, undefined); assert.equal(f.calls[0].options.credentials, 'omit'); assert.equal(f.calls[0].options.cache, 'no-store');
  });
  await check('malformed rankings fail as a whole without links or partial rows', async () => {
    const badItems = [
      [{ document: '1', visits: 100 }, { document: '999', visits: 99 }],
      [{ document: '1', visits: 100 }, { document: '1', visits: 99 }],
      [{ document: 'javascript:attack()', visits: 100 }],
      [{ document: '1', visits: -1 }], [{ document: '1', visits: 1.25 }],
      [{ document: '1', visits: NaN }], [{ document: '1', visits: Number.MAX_SAFE_INTEGER + 1 }],
      [{ document: '1', visits: '100' }], [{ document: 1, visits: 100 }],
      [{ document: '1', visits: 9 }, { document: '2', visits: 10 }],
      [{ document: '2', visits: 10 }, { document: '1', visits: 10 }],
      Array.from({ length: 11 }, (_, index) => ({ document: String(index + 1), visits: 100 - index })),
    ];
    for (const items of badItems) {
      const f = rankingFixture(); f.setFetch(async () => response(rankingData(items)));
      f.run('blog/visits-ranking.js'); await flush();
      assert.equal(f.section.dataset.rankingState, 'error'); assert.equal(f.list.querySelectorAll('li').length, 0);
      assert.equal(f.list.hidden, true); assert.equal(f.retry.hidden, false);
    }
  });
  await check('ranking failures retry once at a time with GET only and no duplicate initialization', async () => {
    const f = rankingFixture(); let finish;
    f.setFetch(async () => f.calls.length === 1 ? new Promise((resolve) => { finish = resolve; }) : response(rankingData()));
    f.run('blog/visits-ranking.js'); await flush();
    await Promise.all([f.retry.fire('click'), f.retry.fire('click')]); f.run('blog/visits-ranking.js'); await flush();
    assert.equal(f.calls.length, 1);
    finish(response({}, 503)); await flush();
    assert.equal(f.retry.hidden, false); assert.equal(f.list.hidden, true);
    await Promise.all([f.retry.fire('click'), f.retry.fire('click')]); await flush();
    assert.equal(f.calls.length, 2); assert.equal(f.list.querySelectorAll('li').length, 10);
    f.run('blog/visits-ranking.js'); await f.retry.fire('click'); await flush();
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every((call) => !call.options.method || call.options.method === 'GET'));
  });
  await check('absent, disabled or unconfigured rankings make no requests', async () => {
    const absent = environment(); absent.run('blog/visits-ranking.js'); await flush(); assert.equal(absent.calls.length, 0);
    for (const f of [rankingFixture(false), rankingFixture(true, '')]) {
      f.run('blog/visits-ranking.js'); await flush(); assert.equal(f.calls.length, 0);
    }
    const missing = rankingFixture(); missing.section.removeAttribute('data-blog-api');
    missing.run('blog/visits-ranking.js'); await flush(); assert.equal(missing.calls.length, 0);
  });
  await check('disabled or unseeded ranking responses never display a fabricated list, while an empty seeded list is ready', async () => {
    for (const data of [{ enabled: false, seeded: false, items: [] }, { enabled: true, seeded: false, items: [] }]) {
      const f = rankingFixture(); f.setFetch(async () => response(data)); f.run('blog/visits-ranking.js'); await flush();
      assert.equal(f.section.dataset.rankingState, 'error'); assert.equal(f.list.hidden, true); assert.equal(f.list.children.length, 0);
    }
    const f = rankingFixture(); f.setFetch(async () => response(rankingData([]))); f.run('blog/visits-ranking.js'); await flush();
    assert.equal(f.section.dataset.rankingState, 'ready'); assert.equal(f.list.hidden, true); assert.equal(f.retry.hidden, true); assert.match(f.status.textContent, /暂无/);
  });

  await check('daily ranges, duplicate initialization and GET only', async () => {
    const f = dailyFixture(); f.setFetch(async () => response(dailyData())); f.run('blog/visits-daily.js'); await flush();
    assert.equal(f.daily.dataset.dailyState, 'ready'); assert.match(f.summary.textContent, /15/); assert.match(f.detail.textContent, /截至北京时间/);
    await f.buttons[0].fire('click'); await flush(); await f.buttons[3].fire('click'); await flush(); f.run('blog/visits-daily.js');
    assert.deepEqual(f.calls.map((x) => new URL(x.url).searchParams.get('range')), ['30', '7', 'all']);
    assert.equal(f.buttons[3].getAttribute('aria-pressed'), 'true'); assert.ok(f.calls.every((x) => !x.options.method && x.options.credentials === 'omit'));
  });
  await check('year range aggregates twelve calendar months and preserves missing days', async () => {
    const f = dailyFixture();
    const items = [];
    for (let d = Date.parse('2025-12-01T00:00:00Z'); d <= Date.parse('2026-11-02T00:00:00Z'); d += 86400000) {
      const date = new Date(d).toISOString().slice(0, 10);
      items.push({ date, visits: date.startsWith('2026-02') || date === '2026-01-02' ? null : 1, partial: date === '2026-11-02' });
    }
    f.setFetch(async (url) => response(new URL(url).searchParams.get('range') === 'year' ? { ...dailyData(items), first_date: '2024-02-01' } : dailyData()));
    f.run('blog/visits-daily.js'); await flush(); await f.buttons[2].fire('click'); await flush();
    assert.equal(f.daily.dataset.dailyState, 'ready'); assert.equal(f.slider.max, '11');
    assert.match(f.summary.textContent, /区间已记录访问量 308 · 最高月 31 次 · 29 天暂无记录/);
    assert.match(f.caption.textContent, /按月统计（北京时间）/); assert.match(f.chart.querySelector('svg').getAttribute('aria-label'), /每月/);
    f.slider.value = '1'; await f.slider.fire('input'); assert.match(f.slider.getAttribute('aria-valuetext'), /2026年1月：30 次访问.*2026-01-02/);
    f.slider.value = '2'; await f.slider.fire('input'); assert.match(f.detail.textContent, /2026年2月：暂无记录.*2026-02-01/);
    f.slider.value = '11'; await f.slider.fire('input'); assert.match(f.detail.textContent, /2026年11月：2 次访问.*截至北京时间/);
    const clipped = dailyFixture(); const shortItems = items.filter((item) => item.date >= '2026-10-15');
    clipped.setFetch(async (url) => response(new URL(url).searchParams.get('range') === 'year' ? dailyData(shortItems) : dailyData()));
    clipped.run('blog/visits-daily.js'); await flush(); await clipped.buttons[2].fire('click'); await flush();
    assert.equal(clipped.daily.dataset.dailyState, 'ready'); assert.equal(clipped.slider.max, '1');
    clipped.slider.value = '0'; await clipped.slider.fire('input'); assert.match(clipped.detail.textContent, /记录不完整.*记录始于 2026-10-15/);
  });
  await check('all history aggregates years with exact totals and rejects bucket overflow', async () => {
    const f = dailyFixture(); const items = [];
    for (let d = Date.parse('2024-12-30T00:00:00Z'); d <= Date.parse('2026-11-02T00:00:00Z'); d += 86400000) {
      const date = new Date(d).toISOString().slice(0, 10);
      items.push({ date, visits: date === '2025-01-01' ? null : 2, partial: date === '2026-11-02' });
    }
    f.setFetch(async (url) => response(new URL(url).searchParams.get('range') === 'all' ? dailyData(items) : dailyData()));
    f.run('blog/visits-daily.js'); await flush(); await f.buttons[3].fire('click'); await flush();
    assert.equal(f.daily.dataset.dailyState, 'ready'); assert.equal(f.slider.max, '2'); assert.match(f.caption.textContent, /按年统计/);
    assert.match(f.summary.textContent, /区间已记录访问量 1,344 · 最高年 728 次 · 1 天暂无记录/);
    f.slider.value = '1'; await f.slider.fire('input'); assert.match(f.slider.getAttribute('aria-valuetext'), /2025年：728 次访问.*记录不完整.*2025-01-01/);
    const overflow = dailyFixture();
    const dangerous = items.map((item, i) => ({ ...item, visits: i === 0 ? Number.MAX_SAFE_INTEGER : 1 }));
    overflow.setFetch(async (url) => response(new URL(url).searchParams.get('range') === 'all' ? dailyData(dangerous) : dailyData()));
    overflow.run('blog/visits-daily.js'); await flush(); await overflow.buttons[3].fire('click'); await flush();
    assert.equal(overflow.daily.dataset.dailyState, 'error'); assert.equal(overflow.chart.hidden, true);
    const clipped = dailyFixture(); const end = Date.parse('2026-11-02T00:00:00Z');
    const longItems = Array.from({ length: 20000 }, (_, i) => ({ date: new Date(end - (19999 - i) * 86400000).toISOString().slice(0, 10), visits: 1, partial: false }));
    clipped.setFetch(async (url) => response(new URL(url).searchParams.get('range') === 'all' ? { ...dailyData(longItems), first_date: '1960-01-01' } : dailyData()));
    clipped.run('blog/visits-daily.js'); await flush(); await clipped.buttons[3].fire('click'); await flush();
    assert.equal(clipped.daily.dataset.dailyState, 'ready'); assert.match(clipped.caption.textContent, /最多展示最近 20,000 天/);
    clipped.slider.value = '0'; await clipped.slider.fire('input');
    assert.match(clipped.detail.textContent, /记录不完整.*本段统计始于/);
  });
  await check('daily missing values break lines and slider and pointer select dates', async () => {
    const f = dailyFixture(), items = [{ date: '2026-10-31', visits: 4, partial: false }, { date: '2026-11-01', visits: null, partial: false }, { date: '2026-11-02', visits: 8, partial: true }];
    f.setFetch(async () => response(dailyData(items))); f.run('blog/visits-daily.js'); await flush();
    assert.equal((f.chart.querySelector('path').getAttribute('d').match(/ M/g) || []).length, 2); assert.match(f.summary.textContent, /未计入总量/);
    f.slider.value = '1'; await f.slider.fire('input'); assert.match(f.detail.textContent, /2026-11-01：暂无记录/);
    await f.chart.querySelector('svg').fire('pointermove', { clientX: 742 }); assert.match(f.detail.textContent, /2026-11-02：8/);
  });
  await check('daily single zero and all-missing days remain inspectable', async () => {
    for (const visits of [0, null]) { const f = dailyFixture(); f.setFetch(async () => response(dailyData([{ date: '2026-11-02', visits, partial: true }]))); f.run('blog/visits-daily.js'); await flush(); assert.equal(f.chart.hidden, false); assert.equal(f.control.hidden, false); assert.match(f.detail.textContent, visits === null ? /暂无记录/ : /0 次访问/); }
  });
  await check('daily invalid data fails atomically', async () => {
    const bad = [[{ date: '2026-02-30', visits: 1, partial: false }], [{ date: '2026-11-01', visits: -1, partial: false }], [{ date: '2026-11-01', visits: Number.MAX_SAFE_INTEGER + 1, partial: false }], [{ date: '2026-11-01', visits: 1, partial: false }, { date: '2026-11-01', visits: 1, partial: false }], [{ date: '2026-11-01', visits: 1, partial: false }, { date: '2026-11-03', visits: 1, partial: false }], Array.from({ length: 20001 }, () => ({ date: '2026-11-01', visits: 1, partial: false }))];
    for (const items of bad) { const f = dailyFixture(); f.setFetch(async () => response(dailyData(items))); f.run('blog/visits-daily.js'); await flush(); assert.equal(f.daily.dataset.dailyState, 'error'); assert.equal(f.chart.hidden, true); assert.equal(f.chart.children.length, 0); assert.equal(f.dailyRetry.hidden, false); }
    for (const extra of [{first_date:null},{first_date:'2026-11-03'},{to:'2026-11-03'},{as_of:'2026-10-31T04:00:00Z'}]) {
      const f=dailyFixture(); f.setFetch(async()=>response({...dailyData(),...extra})); f.run('blog/visits-daily.js'); await flush(); assert.equal(f.daily.dataset.dailyState,'error'); assert.equal(f.chart.hidden,true);
    }
  });
  await check('daily retry recovers and stale responses are ignored', async () => {
    const f = dailyFixture(); let finish; f.setFetch(async () => f.calls.length === 1 ? new Promise((resolve) => { finish = resolve; }) : f.calls.length === 2 ? response({}, 503) : response(dailyData()));
    f.run('blog/visits-daily.js'); await flush(); await f.buttons[0].fire('click'); await flush(); assert.equal(f.daily.dataset.dailyState, 'error');
    finish(response(dailyData([{ date: '2026-11-01', visits: 999, partial: false }]))); await flush(); assert.equal(f.daily.dataset.dailyState, 'error');
    await f.dailyRetry.fire('click'); await flush(); assert.equal(f.daily.dataset.dailyState, 'ready'); assert.doesNotMatch(f.summary.textContent, /999/);
  });
  await check('disabled daily makes no request and ranking stays independent', async () => {
    const disabled = dailyFixture(false); disabled.run('blog/visits-daily.js'); await flush(); assert.equal(disabled.calls.length, 0);
    const f = dailyFixture(); f.setFetch(async (url) => response(url.includes('/ranking') ? rankingData() : dailyData())); f.run('blog/visits-ranking.js'); await flush(); const ranking = f.list.textContent; f.run('blog/visits-daily.js'); await flush(); assert.equal(f.list.textContent, ranking); assert.equal(f.list.querySelectorAll('li').length, 10); assert.equal(f.calls.length, 2);
  });
  await check('search restores q, filters locally, updates the address and clears without losing unrelated parameters', async () => {
    const f = searchFixture('http://127.0.0.1:8791/blog/?q=Mo&view=all');
    f.run('blog/blog.js');
    assert.equal(f.input.value, 'Mo'); assert.equal(f.form.hidden, false);
    assert.deepEqual(f.cards.map((node) => node.hidden), [false, true, false]);
    assert.match(f.count.textContent, /2/); assert.equal(f.clear.disabled, false);
    f.input.value = 'tree'; await f.input.fire('input');
    assert.deepEqual(f.cards.map((node) => node.hidden), [true, false, true]);
    assert.equal(new URL(f.win.location.href).searchParams.get('q'), 'tree');
    assert.equal(new URL(f.win.location.href).searchParams.get('view'), 'all');
    assert.equal((await f.form.fire('submit')).defaultPrevented, true);
    f.input.value = 'absent'; await f.input.fire('input'); assert.equal(f.noResults.hidden, false);
    await f.clear.fire('click');
    assert.equal(f.input.value, ''); assert.equal(f.doc.activeElement, f.input); assert.equal(f.clear.disabled, true);
    assert.equal(new URL(f.win.location.href).searchParams.has('q'), false);
    assert.equal(new URL(f.win.location.href).searchParams.get('view'), 'all');
    assert.deepEqual(f.cards.map((node) => node.hidden), [false, false, false]); assert.equal(f.noResults.hidden, true);
    assert.equal(f.calls.length, 0);
  });
  await check('search history restores both q and an empty query on list pages', async () => {
    const f = searchFixture('http://127.0.0.1:8791/blog/?q=Mo'); f.run('blog/blog.js');
    f.win.location.href = 'http://127.0.0.1:8791/blog/?q=tree'; await f.win.fire('popstate');
    assert.equal(f.input.value, 'tree'); assert.deepEqual(f.cards.map((node) => node.hidden), [true, false, true]);
    f.win.location.href = 'http://127.0.0.1:8791/blog/'; await f.win.fire('popstate');
    assert.equal(f.input.value, ''); assert.deepEqual(f.cards.map((node) => node.hidden), [false, false, false]);
  });
  await check('pages without an article list expose native GET search rather than filtering unrelated content', async () => {
    const f = searchFixture('http://127.0.0.1:8791/blog/tags/', false); f.run('blog/blog.js');
    assert.equal(f.form.hidden, false); assert.equal(f.form.getAttribute('action'), '/blog/');
    assert.equal(f.form.getAttribute('method'), 'get'); assert.equal(f.input.getAttribute('name'), 'q');
    f.input.value = '网络流'; await f.input.fire('input');
    assert.equal((await f.form.fire('submit')).defaultPrevented, false);
    assert.equal(f.win.location.href, 'http://127.0.0.1:8791/blog/tags/'); assert.equal(f.calls.length, 0);
  });
  await check('legacy tag URLs retain readable names without a visible homepage tag cloud', async () => {
    const f = searchFixture('http://127.0.0.1:8791/blog/?tag=104'); const { el } = f;
    f.list.setAttribute('data-tag-filter', 'all');
    f.list.setAttribute('data-tag-names', JSON.stringify({ '104': '2-SAT', '105': '网络流' }));
    f.cards[0].setAttribute('data-tags', '104'); f.cards[1].setAttribute('data-tags', '105'); f.cards[2].setAttribute('data-tags', '104 105');
    const active = el('p', { class: 'active-tag-filter', hidden: '' });
    const label = el('span', { 'data-active-tag': '' }, active);
    const clearTag = el('button', { 'data-clear-tag': '', type: 'button' }, active);
    f.run('blog/blog.js');
    assert.equal(f.doc.querySelector('.tag-cloud'), null);
    assert.deepEqual(f.cards.map((node) => node.hidden), [false, true, false]);
    assert.equal(active.hidden, false); assert.equal(label.textContent, '标签：2-SAT');
    assert.match(f.count.textContent, /标签「2-SAT」/);
    f.win.location.href = 'http://127.0.0.1:8791/blog/?tag=105&q=tree'; await f.win.fire('popstate');
    assert.equal(label.textContent, '标签：网络流'); assert.deepEqual(f.cards.map((node) => node.hidden), [true, false, true]);
    await clearTag.fire('click'); assert.equal(active.hidden, true); assert.equal(f.input.value, 'tree');
    assert.equal(new URL(f.win.location.href).searchParams.has('tag'), false);
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
    f.win.location.href = 'http://127.0.0.1:8791/blog/?tag=104&q=Mo'; await f.win.fire('popstate'); assert.equal(input.value, 'Mo'); assert.deepEqual(cards.map((node) => node.hidden), [false, true, true]);
    const modified = await tag104.fire('click', { ctrlKey: true }); assert.equal(modified.defaultPrevented, false); assert.equal(tag104.href, '/blog/tags/104/'); assert.match(count.textContent, /1/);
  });
  console.log(JSON.stringify({ passed, failed: 0, environment: 'Node VM with isolated DOM and mocked HTTP; no network' }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
