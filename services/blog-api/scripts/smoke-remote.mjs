import { randomUUID } from 'node:crypto';

const usage = 'Use --api <Worker origin> --confirm-test-writes with BLOG_ADMIN_TOKEN in the environment. Creates and removes fictional comments; never enables or seeds Visits.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_ORIGIN = 'https://pku-xht.github.io';
const report = { ok: false, checks: [], requests: 0, created: 0, cleaned: 0, remaining_test_ids: [] };
const specifications = [];
const returnedIDs = new Set();
let api, token;

class SmokeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireCheck(condition, code) {
  if (!condition) throw new SmokeError(code);
}
function passed(name) { report.checks.push(name); }

function configure() {
  const args = process.argv.slice(2);
  let confirmed = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help' || args[index] === '-h') {
      console.log(usage);
      return false;
    }
    if (args[index] === '--confirm-test-writes' && !confirmed) confirmed = true;
    else if (args[index] === '--api' && !api && args[index + 1] && !args[index + 1].startsWith('--')) api = args[++index];
    else throw new SmokeError('invalid_arguments');
  }
  requireCheck(confirmed, 'test_write_confirmation_required');
  requireCheck(api, 'api_origin_required');
  let parsed;
  try { parsed = new URL(api); } catch { throw new SmokeError('invalid_api_origin'); }
  requireCheck(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)), 'https_required');
  requireCheck(!parsed.username && !parsed.password && !parsed.search && !parsed.hash && ['/', ''].includes(parsed.pathname), 'api_must_be_origin_only');
  api = parsed.origin;
  token = process.env.BLOG_ADMIN_TOKEN;
  requireCheck(typeof token === 'string' && token.length >= 32 && !/\s/.test(token), 'admin_token_environment_required');
  return true;
}

async function request(path, { method = 'GET', value, admin = false, origin = PUBLIC_ORIGIN, text = false } = {}) {
  report.requests++;
  const headers = {};
  if (origin !== null) headers.Origin = origin;
  if (value !== undefined) headers['Content-Type'] = 'application/json';
  if (admin) headers.Authorization = 'Bearer ' + token;
  let response;
  try {
    response = await fetch(new URL(path, api), {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(20000),
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  } catch { throw new SmokeError('network_request_failed'); }
  let data = null;
  try {
    const body = await response.text();
    if (body) data = text ? body : JSON.parse(body);
  } catch { throw new SmokeError('unexpected_response_format'); }
  return { status: response.status, headers: response.headers, data };
}

function expect(response, status, code) {
  requireCheck(response.status === status, code + '_http_' + response.status);
}

async function list(path, admin = false) {
  const rows = [];
  let cursor = 0;
  for (let page = 0; page < 200; page++) {
    const result = await request(path + (path.includes('?') ? '&' : '?') + 'cursor=' + cursor, { admin, ...(admin ? { origin: null } : {}) });
    expect(result, 200, admin ? 'admin_list' : 'public_list');
    requireCheck(Array.isArray(result.data?.comments), 'invalid_comments_page');
    rows.push(...result.data.comments);
    const next = result.data.next_cursor;
    if (next === null) return rows;
    requireCheck(Number.isSafeInteger(next) && next > cursor, 'invalid_comments_cursor');
    cursor = next;
  }
  throw new SmokeError('comment_pagination_limit');
}

function matches(row, specification) {
  return row.document === specification.document && row.nickname === specification.nickname.trim()
    && row.body === specification.body.trim() && row.parent_id === specification.parent_id;
}

function fixture(label, extra = {}) {
  const value = {
    document: '46', nickname: '部署验收虚构读者',
    body: 'Fictional deployment smoke test ' + label + ' ' + randomUUID() + '. Safe to remove.',
    parent_id: null, request_id: randomUUID(), website: '', ...extra,
  };
  specifications.push(value);
  return value;
}

async function submit(value) {
  const result = await request('/v1/comments', { method: 'POST', value });
  if (UUID.test(result.data?.id || '')) returnedIDs.add(result.data.id);
  return result;
}

async function allAdminRows() {
  const rows = [];
  for (const status of ['pending', 'approved', 'rejected']) {
    rows.push(...await list('/v1/admin/comments?status=' + status, true));
  }
  return rows;
}

async function cleanup() {
  if (!specifications.length) return;
  let rows;
  try { rows = await allAdminRows(); }
  catch {
    report.remaining_test_ids = [...returnedIDs];
    report.unconfirmed_test_request_ids = specifications.map(value => value.request_id);
    throw new SmokeError('cleanup_inventory_failed');
  }
  const owned = new Map(rows.filter(row => UUID.test(row.id) && specifications.some(value => matches(row, value))).map(row => [row.id, row]));
  report.created = owned.size;
  report.remaining_test_ids = [...owned.keys()];
  for (const id of returnedIDs) {
    if (rows.some(row => row.id === id) && !owned.has(id)) throw new SmokeError('cleanup_ownership_mismatch');
  }
  const remaining = new Set(owned.keys());
  let progress = true;
  while (progress && remaining.size) {
    progress = false;
    for (const id of [...remaining]) {
      try {
        // Never use recursive DELETE for fixtures. The server checks for replies
        // atomically, including a real reply submitted after our inventory read.
        const deleted = await request('/v1/admin/comments/' + id + '?only_if_no_replies=true', { method: 'DELETE', admin: true, origin: null });
        if (deleted.status !== 200 || deleted.data?.id !== id || deleted.data?.deleted !== 1) continue;
        remaining.delete(id);
        report.cleaned++;
        progress = true;
      } catch { /* Only safe fixture IDs are reported below; response content stays in memory. */ }
    }
  }
  // Verify absence instead of trusting DELETE's success response alone.
  try {
    const after = await allAdminRows();
    for (const row of after) {
      if (UUID.test(row.id) && specifications.some(value => matches(row, value))) remaining.add(row.id);
    }
    for (const id of [...remaining]) if (!after.some(row => row.id === id)) remaining.delete(id);
  } catch {
    for (const id of owned.keys()) remaining.add(id);
  }
  report.remaining_test_ids = [...remaining];
  requireCheck(remaining.size === 0, 'test_comment_cleanup_incomplete');
  passed('fictional_comments_removed');
}

async function run() {
  const preflight = await request('/v1/comments', { method: 'OPTIONS' });
  expect(preflight, 204, 'cors_preflight');
  requireCheck(preflight.headers.get('Access-Control-Allow-Origin') === PUBLIC_ORIGIN, 'cors_exact_origin');
  requireCheck(preflight.headers.get('Access-Control-Allow-Credentials') === null, 'cors_no_credentials');
  const denied = await request('/v1/comments', { method: 'OPTIONS', origin: 'https://pku-xht.github.io.evil.example' });
  expect(denied, 403, 'cors_denied_origin');
  requireCheck(denied.headers.get('Access-Control-Allow-Origin') === null, 'cors_denied_no_allow_header');
  passed('cors_exact_allowlist');

  const unauthenticated = await request('/v1/admin/comments?status=pending', { origin: null });
  expect(unauthenticated, 401, 'admin_without_token');
  const pendingBefore = await request('/v1/admin/comments?status=pending', { admin: true, origin: null });
  expect(pendingBefore, 200, 'admin_token_validation');
  requireCheck(Array.isArray(pendingBefore.data?.comments), 'admin_page_shape');
  passed('admin_authorization');

  const adminPage = await request('/admin', { origin: null, text: true });
  expect(adminPage, 200, 'admin_page');
  requireCheck(adminPage.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'none'"), 'admin_page_csp');
  passed('admin_page_csp');

  const visits = await request('/v1/visits?document=46');
  expect(visits, 200, 'visits_status');
  requireCheck(visits.data?.enabled === false && visits.data.seeded === false && visits.data.site === null && visits.data.document === null && visits.data.document_id === '46', 'visits_must_remain_disabled_unseeded');
  const refusedVisit = await request('/v1/visits', { method: 'POST', value: { nonce: randomUUID(), document: '46' } });
  expect(refusedVisit, 404, 'disabled_visit_post');
  requireCheck(refusedVisit.data?.error === 'visits_disabled', 'disabled_visit_error');
  passed('visits_disabled_unseeded');

  const blank = await submit(fixture('blank-nickname', { nickname: '   ' }));
  expect(blank, 400, 'blank_nickname');
  requireCheck(blank.data?.error === 'invalid_nickname', 'blank_nickname_error');
  passed('nickname_required');

  const value = fixture('moderation');
  const submitted = await submit(value);
  expect(submitted, 202, 'comment_submission');
  const id = submitted.data?.id;
  requireCheck(UUID.test(id || '') && submitted.data.status === 'pending', 'submission_pending_shape');
  const publicPending = await list('/v1/comments?document=46');
  requireCheck(!publicPending.some(row => row.id === id || row.body === value.body), 'pending_comment_leaked');
  const privatePending = await list('/v1/admin/comments?status=pending', true);
  requireCheck(privatePending.some(row => row.id === id && row.status === 'pending' && matches(row, value)), 'pending_missing_from_moderation');
  passed('pending_private_until_moderated');

  const approved = await request('/v1/admin/comments/' + id + '/approve', { method: 'POST', admin: true, origin: null });
  expect(approved, 200, 'comment_approval');
  requireCheck(approved.data?.id === id && approved.data.status === 'approved', 'approval_shape');
  const publicApproved = await list('/v1/comments?document=46');
  const visible = publicApproved.find(row => row.id === id);
  requireCheck(visible && matches(visible, value), 'approved_comment_not_visible');
  requireCheck(Object.keys(visible).sort().join(',') === 'body,created_at,document,id,nickname,parent_id', 'public_comment_private_fields');
  passed('approved_comment_public');

  const legacyValue = fixture('legacy-reply', { parent_id: 'wp-2' });
  const legacy = await submit(legacyValue);
  expect(legacy, 202, 'legacy_reply');
  requireCheck(UUID.test(legacy.data?.id || '') && legacy.data.status === 'pending', 'legacy_reply_pending_shape');
  const legacyPending = await list('/v1/admin/comments?status=pending', true);
  requireCheck(legacyPending.some(row => row.id === legacy.data.id && matches(row, legacyValue)), 'legacy_reply_parent_not_preserved');
  requireCheck(!(await list('/v1/comments?document=46')).some(row => row.id === legacy.data.id), 'legacy_pending_comment_leaked');
  passed('legacy_wp2_reply_pending');

  const wrongDocument = await submit(fixture('cross-document-reply', { document: '1154', parent_id: 'wp-2' }));
  expect(wrongDocument, 409, 'cross_document_reply');
  requireCheck(wrongDocument.data?.error === 'invalid_parent', 'cross_document_reply_error');
  passed('cross_document_reply_rejected');
}

try {
  if (configure()) {
    let failure;
    try { await run(); }
    catch (error) { failure = error; }
    finally {
      try { await cleanup(); }
      catch (error) { report.cleanup_error = error instanceof SmokeError ? error.code : 'cleanup_failed'; failure ||= error; }
    }
    if (failure) throw failure;
    report.ok = true;
    console.log(JSON.stringify(report));
  }
} catch (error) {
  report.error = error instanceof SmokeError ? error.code : 'unexpected_failure';
  console.error(JSON.stringify(report));
  process.exitCode = 1;
}
