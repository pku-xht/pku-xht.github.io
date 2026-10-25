import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import worker from '../src/worker.mjs';
import { testDatabase, sqliteD1 } from './d1-sqlite.mjs';

const origin='https://pku-xht.github.io', token='test-admin-token-123456789012345678901234567890';
function fixture(context, overrides={}) {
  const DB=testDatabase(); context.after(()=>DB.close());
  const env={DB,ADMIN_TOKEN:token,RATE_LIMIT_SALT:'test-address-salt-123456789012345678901234567890',VISITS_ENABLED:'false',ALLOWED_ORIGINS:'http://127.0.0.1:8791,http://localhost:8791',...overrides};
  async function request(path, {method='GET',value,admin=false,requestOrigin=origin,ip='203.0.113.1',...headers}={}) {
    const sent={'Content-Type':'application/json','CF-Connecting-IP':ip,...headers};
    if (requestOrigin!==null) sent.Origin=requestOrigin;
    if (admin) sent.Authorization='Bearer '+token;
    const response=await worker.fetch(new Request('https://api.example.test'+path,{method,headers:sent,...(value===undefined?{}:{body:JSON.stringify(value)})}),env);
    const text=await response.text(); let data;
    try { data=JSON.parse(text); } catch { data=text; }
    assert.notEqual(response.status,500,JSON.stringify({data,lastError:DB.lastError?.error?.message,sql:DB.lastError?.sql}));
    return {status:response.status,headers:response.headers,data};
  }
  const comment=(extra={})=>({document:'11',nickname:'读者',body:'一条评论',request_id:randomUUID(),...extra});
  const post=(value,options={})=>request('/v1/comments',{method:'POST',value,...options});
  const approve=id=>request('/v1/admin/comments/'+id+'/approve',{method:'POST',admin:true,requestOrigin:null});
  const baseline=(extra={})=>({confirm_cutover:true,batch_id:'cutover-test',site_base:1000,captured_at:'2026-10-25T01:00:00Z',document_bases:[{document:'11',base:10},{document:'12',base:20},{document:'215',base:3}],...extra});
  const seed=value=>request('/v1/admin/visits/baseline',{method:'POST',admin:true,requestOrigin:null,value:value||baseline()});
  return {DB,env,request,comment,post,approve,baseline,seed};
}

test('nickname must be manually supplied, trimmed, nonempty, <=40 and free of control characters',async context=>{
  const f=fixture(context);
  for (const nickname of ['', ' \t\n ', '\u3000\u2000', 'x'.repeat(41), 'a\u0000b', null, {name:'x'}]) {
    const result=await f.post(f.comment({nickname})); assert.equal(result.status,400); assert.equal(result.data.error,'invalid_nickname');
  }
  const ok=await f.post(f.comment({nickname:'  张三  '})); assert.equal(ok.status,202);
  assert.equal(f.DB.sqlite.prepare('SELECT nickname FROM comments').get().nickname,'张三');
});

test('body bounds, malformed fields, malicious moderation fields and unknown public documents fail',async context=>{
  const f=fixture(context);
  for (const body of ['', ' \n ', 'x'.repeat(10001), 'bad\u0001', [], null]) assert.equal((await f.post(f.comment({body}))).status,400);
  for (const extra of [{status:'approved'},{ip:'192.0.2.1'},{admin:true},{body_html:'<b>forged</b>'},{author_url:'https://example.test/'},{nickname:['a']},{request_id:'short'},{website:{url:'bot'}}]) assert.equal((await f.post(f.comment(extra))).status,400);
  assert.equal((await f.post(f.comment({document:'999'}))).status,404);
  assert.equal((await f.post(f.comment({document:11}))).status,400);
  assert.equal((await f.post(f.comment({website:'https://spam.example'}))).status,202);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,0);
});

test('chunked requests without Content-Length are cancelled as soon as the 64KiB limit is exceeded',async context=>{
  const f=fixture(context); let cancelled=false, pulls=0;
  const stream=new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(32768).fill(65)); },
    cancel() { cancelled=true; },
  });
  const response=await worker.fetch(new Request('https://api.example.test/v1/comments',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:stream,duplex:'half'}),f.env);
  assert.equal(response.status,413); assert.equal((await response.json()).error,'body_too_large'); assert.equal(cancelled,true); assert.ok(pulls<=4);
  assert.equal(f.DB.writes,0);
});

test('pending stays private, admin authorization gates moderation, approved XSS remains plain text',async context=>{
  const f=fixture(context), body='<img src=x onerror=alert(1)>\n<script>alert(2)</script>';
  const submitted=await f.post(f.comment({body})); assert.equal(submitted.status,202); assert.equal(submitted.data.status,'pending');
  assert.deepEqual((await f.request('/v1/comments?document=11')).data.comments,[]);
  assert.equal((await f.request('/v1/admin/comments',{requestOrigin:null})).status,401);
  assert.equal((await f.request('/v1/admin/comments',{requestOrigin:null,Authorization:'Bearer wrong'})).status,401);
  assert.equal((await f.request('/v1/admin/comments/'+submitted.data.id+'/approve',{method:'POST',requestOrigin:null})).status,401);
  const pending=await f.request('/v1/admin/comments',{admin:true,requestOrigin:null}); assert.equal(pending.data.comments.length,1);
  assert.equal((await f.approve(submitted.data.id)).status,200);
  const approved=(await f.request('/v1/comments?document=11')).data.comments[0]; assert.equal(approved.body,body);
  assert.deepEqual(Object.keys(approved).sort(),['author_url','body','body_html','created_at','document','id','nickname','parent_id']);
  assert.equal(approved.body_html,null); assert.equal(approved.author_url,'');
  assert.equal(approved.nickname,'读者'); assert.match(approved.id,/^[0-9a-f-]{36}$/);
});

test('comment retries and racing duplicate requests are idempotent, conflicting payloads reject',async context=>{
  const f=fixture(context), payload=f.comment();
  const results=await Promise.all(Array.from({length:20},()=>f.post(payload)));
  assert.ok(results.every(result=>result.status===202)); assert.equal(new Set(results.map(result=>result.data.id)).size,1);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,1);
  assert.equal(f.DB.sqlite.prepare('SELECT count FROM rate_buckets').get().count,1);
  assert.equal((await f.post({...payload,body:'changed'})).status,409);
});

test('replies accept only an approved parent on the same registered document, including public legacy IDs',async context=>{
  const f=fixture(context);
  // A registration-only projection is never sufficient after unified moderation.
  assert.equal((await f.post(f.comment({parent_id:'wp-1'}))).status,409);
  f.DB.sqlite.exec("INSERT INTO comments(id,document,nickname,body,status,request_id,request_hash,created_at) VALUES ('wp-1','11','原作者','正文','approved','import:wp-1','hash','2020-01-01T00:00:00.000Z'),('wp-2','12','另一作者','正文','approved','import:wp-2','hash','2020-01-01T00:00:00.000Z');");
  assert.equal((await f.post(f.comment({parent_id:'wp-1'}))).status,202);
  assert.equal((await f.post(f.comment({parent_id:'wp-2'}))).status,409);
  const parent=await f.post(f.comment());
  assert.equal((await f.post(f.comment({parent_id:parent.data.id}))).status,409);
  await f.approve(parent.data.id);
  assert.equal((await f.post(f.comment({parent_id:parent.data.id}))).status,202);
  assert.equal((await f.post(f.comment({document:'12',parent_id:parent.data.id}))).status,409);
});

test('rejection hides a subtree and deletion removes only that document subtree',async context=>{
  const f=fixture(context);
  const parent=(await f.post(f.comment())).data.id; await f.approve(parent);
  const child=(await f.post(f.comment({parent_id:parent}))).data.id; await f.approve(child);
  const grandchild=(await f.post(f.comment({parent_id:child}))).data.id; await f.approve(grandchild);
  const unrelated=(await f.post(f.comment({document:'12'}))).data.id; await f.approve(unrelated);
  const rejected=await f.request('/v1/admin/comments/'+parent+'/reject',{method:'POST',admin:true,requestOrigin:null}); assert.equal(rejected.data.affected,3);
  assert.deepEqual((await f.request('/v1/comments?document=11')).data.comments,[]);
  assert.equal((await f.approve(child)).status,409);
  assert.equal((await f.request('/v1/comments?document=12')).data.comments.length,1);
  const deleted=await f.request('/v1/admin/comments/'+parent,{method:'DELETE',admin:true,requestOrigin:null}); assert.equal(deleted.data.deleted,3);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,1);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM legacy_parents').get().n,2);
});

test('conditional cleanup requires admin, preserves replies and deletes only a leaf',async context=>{
  const f=fixture(context);
  const parent=(await f.post(f.comment())).data.id; await f.approve(parent);
  const child=(await f.post(f.comment({parent_id:parent}))).data.id;
  const path=id=>'/v1/admin/comments/'+id+'?only_if_no_replies=true';
  assert.equal((await f.request(path(child),{method:'DELETE',requestOrigin:null})).status,401);
  const blocked=await f.request(path(parent),{method:'DELETE',admin:true,requestOrigin:null});
  assert.equal(blocked.status,409); assert.equal(blocked.data.error,'comment_has_replies');
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,2);
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM comments WHERE id = ?').get(child).status,'pending');
  for (const condition of ['false', '', 'true&only_if_no_replies=true', 'true&only_if_no_replies=false']) {
    const invalid=await f.request('/v1/admin/comments/'+parent+'?only_if_no_replies='+condition,{method:'DELETE',admin:true,requestOrigin:null});
    assert.equal(invalid.status,400); assert.equal(invalid.data.error,'invalid_delete_condition');
    assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,2);
  }
  const leaf=await f.request(path(child),{method:'DELETE',admin:true,requestOrigin:null});
  assert.equal(leaf.status,200); assert.deepEqual(leaf.data,{id:child,deleted:1});
  assert.equal(f.DB.sqlite.prepare('SELECT id FROM comments').get().id,parent);
  const final=await f.request(path(parent),{method:'DELETE',admin:true,requestOrigin:null});
  assert.equal(final.status,200); assert.equal(final.data.deleted,1);
  assert.equal((await f.request(path(parent),{method:'DELETE',admin:true,requestOrigin:null})).status,404);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,0);
});

test('conditional cleanup and a racing reply cannot delete or orphan the reply',async context=>{
  const f=fixture(context);
  const parent=(await f.post(f.comment())).data.id; await f.approve(parent);
  const originalPrepare=f.DB.prepare;
  let reply;
  f.DB.prepare=function(sql) {
    const statement=originalPrepare.call(this,sql);
    if (!/^DELETE FROM comments WHERE id = \?/i.test(sql)) return statement;
    const wrap=prepared=>({
      ...prepared,
      bind(...values) { return wrap(prepared.bind(...values)); },
      async all() {
        // Force a valid reply to commit immediately before the conditional DELETE.
        if (!reply) reply=await f.post(f.comment({parent_id:parent}));
        return prepared.all();
      },
    });
    return wrap(statement);
  };
  const deleted=await f.request('/v1/admin/comments/'+parent+'?only_if_no_replies=true',{method:'DELETE',admin:true,requestOrigin:null});
  assert.equal(reply.status,202);
  assert.equal(deleted.status,409); assert.equal(deleted.data.error,'comment_has_replies');
  assert.equal(f.DB.sqlite.prepare('SELECT parent_id FROM comments WHERE id = ?').get(reply.data.id).parent_id,parent);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,2);

  const g=fixture(context);
  const otherParent=(await g.post(g.comment())).data.id; await g.approve(otherParent);
  const otherPrepare=g.DB.prepare;
  let cleanup;
  g.DB.prepare=function(sql) {
    const statement=otherPrepare.call(this,sql);
    if (!/^SELECT 1 AS found WHERE/i.test(sql)) return statement;
    const wrap=prepared=>({
      ...prepared,
      bind(...values) { return wrap(prepared.bind(...values)); },
      async first() {
        const found=await prepared.first();
        // Force cleanup after submit's early parent read but before its INSERT batch.
        cleanup=await g.request('/v1/admin/comments/'+otherParent+'?only_if_no_replies=true',{method:'DELETE',admin:true,requestOrigin:null});
        return found;
      },
    });
    return wrap(statement);
  };
  const lateReply=await g.post(g.comment({parent_id:otherParent}));
  assert.equal(cleanup.status,200); assert.equal(cleanup.data.deleted,1);
  assert.equal(lateReply.status,409); assert.equal(lateReply.data.error,'invalid_parent');
  assert.equal(g.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,0);
});

test('CORS permits only exact origins, requires public POST Origin and accepts same-origin admin',async context=>{
  const f=fixture(context);
  for (const requestOrigin of ['https://evil.example','https://pku-xht.github.io.evil.example','null',null]) {
    const result=await f.post(f.comment(),{requestOrigin}); assert.equal(result.status,403); assert.equal(result.headers.get('Access-Control-Allow-Origin'),null);
  }
  const allowed=await f.request('/v1/comments?document=11',{requestOrigin:'http://127.0.0.1:8791'}); assert.equal(allowed.status,200); assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),'http://127.0.0.1:8791');
  assert.equal((await f.request('/v1/comments?document=11',{requestOrigin:'http://127.0.0.1:8792'})).status,403);
  const options=await f.request('/v1/comments',{method:'OPTIONS'}); assert.equal(options.status,204); assert.equal(options.headers.get('Access-Control-Allow-Credentials'),null);
  assert.equal((await f.request('/v1/admin/comments',{admin:true,requestOrigin:'https://api.example.test'})).status,200);
});

test('atomic rate buckets limit submissions without storing raw IP and salt is required',async context=>{
  const f=fixture(context), ip='198.51.100.27';
  for (let index=0;index<5;index++) assert.equal((await f.post(f.comment(),{ip})).status,202);
  assert.equal((await f.post(f.comment(),{ip})).status,429);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,5);
  assert.ok(f.DB.sqlite.prepare('SELECT key FROM rate_buckets').all().every(row=>!row.key.includes(ip)&&/[a-f0-9]{64}$/.test(row.key)));
  const g=fixture(context,{RATE_LIMIT_SALT:''}); assert.equal((await g.post(g.comment())).status,503); assert.equal(g.DB.writes,0);
});

test('public comment pagination returns approved records in stable order only',async context=>{
  const f=fixture(context), insert=f.DB.sqlite.prepare("INSERT INTO comments(id,document,nickname,body,status,request_id,request_hash,created_at) VALUES (?,'11','reader','text',?,?,?,?)");
  for (let index=0;index<102;index++) insert.run(randomUUID(),index===101?'pending':'approved',randomUUID(),'hash','2026-10-25T00:00:00Z');
  const page=(await f.request('/v1/comments?document=11')).data; assert.equal(page.comments.length,100); assert.equal(page.next_cursor,100);
  const last=(await f.request('/v1/comments?document=11&cursor='+page.next_cursor)).data; assert.equal(last.comments.length,1); assert.equal(last.next_cursor,null);
});

test('Visits disabled by default returns null and POST does not touch SQLite',async context=>{
  const f=fixture(context); delete f.env.VISITS_ENABLED;
  const before=f.DB.writes;
  const stats=await f.request('/v1/visits?document=11'); assert.deepEqual(stats.data,{enabled:false,seeded:false,site:null,document:null,document_id:'11'});
  assert.equal((await f.request('/v1/visits',{method:'POST',value:{nonce:randomUUID(),document:'11'}})).status,404);
  assert.equal(f.DB.writes,before); assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM visit_events').get().n,0);
});

test('enabled but unseeded Visits stay null and refuse increments',async context=>{
  const f=fixture(context,{VISITS_ENABLED:'true'});
  const stats=await f.request('/v1/visits?document=11'); assert.equal(stats.data.seeded,false); assert.equal(stats.data.site,null); assert.equal(stats.data.document,null);
  const response=await f.request('/v1/visits',{method:'POST',value:{nonce:randomUUID(),document:'11'}}); assert.equal(response.status,409); assert.equal(response.data.error,'visits_not_seeded');
  assert.equal(f.DB.writes,0);
});

test('baseline import requires admin and explicit cutover with exact complete public-document scope',async context=>{
  const f=fixture(context);
  assert.equal((await f.request('/v1/admin/visits/baseline',{method:'POST',requestOrigin:null,value:f.baseline()})).status,401);
  assert.equal((await f.seed(f.baseline({confirm_cutover:false}))).status,400);
  assert.equal((await f.seed(f.baseline({document_bases:[{document:'11',base:10}]}))).status,400);
  assert.equal((await f.seed(f.baseline({site_base:null}))).status,400);
  assert.equal((await f.seed(f.baseline({document_bases:[{document:'11',base:1},{document:'11',base:2},{document:'12',base:3}]}))).status,400);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM visit_baselines').get().n,0);
});

test('baseline is atomic, independent site base is preserved, same batch retries are harmless and overwrite rejects',async context=>{
  const f=fixture(context,{VISITS_ENABLED:'true'});
  const first=await f.seed(); assert.equal(first.status,200); assert.equal(first.data.imported,true);
  const stats=(await f.request('/v1/visits?document=11')).data; assert.equal(stats.site,1000); assert.equal(stats.document,10);
  assert.equal((await f.seed()).data.imported,false);
  assert.equal((await f.seed(f.baseline({batch_id:'different'}))).status,409);
  assert.equal((await f.seed(f.baseline({site_base:2000}))).status,409);
  assert.equal((await f.request('/v1/visits?document=11')).data.site,1000);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM document_baselines').get().n,3);
});

test('concurrent unique visits increment article and site atomically; racing nonce retries count once',async context=>{
  const f=fixture(context,{VISITS_ENABLED:'true'}); await f.seed();
  const results=await Promise.all(Array.from({length:40},()=>f.request('/v1/visits',{method:'POST',value:{nonce:randomUUID(),document:'11'}})));
  assert.ok(results.every(result=>result.status===200));
  assert.ok(results.every(result=>result.data.site-1000===result.data.document-10),'Every stats response must read site and document from the same SQLite snapshot.');
  const nonce=randomUUID(); const repeated=await Promise.all(Array.from({length:10},()=>f.request('/v1/visits',{method:'POST',value:{nonce,document:'11'}})));
  assert.equal(repeated.filter(result=>result.data.counted).length,1);
  const stats=(await f.request('/v1/visits?document=11')).data; assert.equal(stats.site,1041); assert.equal(stats.document,51);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM visit_events').get().n,41);
  const replay=(await f.request('/v1/visits',{method:'POST',value:{nonce,document:'11'}})); assert.equal(replay.data.counted,false);
  assert.equal((await f.request('/v1/visits',{method:'POST',value:{nonce,document:'12'}})).status,409);
  assert.equal((await f.seed()).data.imported,false); assert.equal((await f.request('/v1/visits?document=11')).data.site,1041);
});

test('index visits increment site alone and unknown documents cannot enter the counters',async context=>{
  const f=fixture(context,{VISITS_ENABLED:'true'}); await f.seed();
  const result=await f.request('/v1/visits',{method:'POST',value:{nonce:randomUUID()}}); assert.equal(result.data.site,1001); assert.equal(result.data.document,null);
  const article=(await f.request('/v1/visits?document=11')).data; assert.equal(article.document,10);
  assert.equal((await f.request('/v1/visits',{method:'POST',value:{nonce:randomUUID(),document:'999'}})).status,404);
  assert.equal((await f.request('/v1/visits?document=999')).status,404);
});

test('Worker admin page keeps tokens in memory and renders user content via textContent',async context=>{
  const f=fixture(context), response=await f.request('/admin',{requestOrigin:null});
  assert.equal(response.status,200); assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  assert.ok(response.data.includes('body.textContent = comment.body')); assert.ok(!response.data.includes('localStorage')); assert.ok(!response.data.includes('innerHTML'));
  assert.ok(!response.data.includes(token));
});

test('offline public importer registers the real 212 documents and rejects private/extra legacy fields',context=>{
  const manifest=JSON.parse(readFileSync(new URL('../data/public-documents.json',import.meta.url),'utf8')); assert.equal(manifest.documents.length,212);
  assert.equal(new Set(manifest.documents.map(row=>row.id)).size,212); assert.equal(manifest.documents.filter(row=>row.kind==='page').length,1);
  const actual=sqliteD1(); context.after(()=>actual.close());
  actual.sqlite.exec(readFileSync(new URL('../data/register-public.sql',import.meta.url),'utf8'));
  assert.equal(actual.sqlite.prepare('SELECT count(*) AS n FROM public_documents').get().n,212);
  assert.equal(actual.sqlite.prepare('SELECT count(*) AS n FROM legacy_parents').get().n,117);
  assert.deepEqual(actual.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  const temporary=mkdtempSync(resolve(tmpdir(),'blog-api-import-')); context.after(()=>rmSync(temporary,{recursive:true,force:true}));
  mkdirSync(resolve(temporary,'posts')); writeFileSync(resolve(temporary,'posts/11.md'),'---\nid: 11\n---\npublic'); writeFileSync(resolve(temporary,'collection.yaml'),'version: 1\nposts:\n- posts/11.md\npages: []\n');
  writeFileSync(resolve(temporary,'legacy.json'),JSON.stringify({version:1,parents:[{id:'wp-1',document:'11',email:'private@example.test'}]}));
  const result=spawnSync(process.execPath,[new URL('../scripts/import-public.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),'--collection',resolve(temporary,'collection.yaml'),'--legacy',resolve(temporary,'legacy.json'),'--out',resolve(temporary,'out')],{encoding:'utf8'}); assert.notEqual(result.status,0);
});

test('all 117 public comments import atomically with original IDs, HTML, authors, UTC dates and reply links',async context=>{
  const f=fixture(context);
  f.DB.sqlite.exec(readFileSync(new URL('../data/register-public.sql',import.meta.url),'utf8'));
  const manifest=JSON.parse(readFileSync(new URL('../data/unified-comments.json',import.meta.url),'utf8'));
  const sql=readFileSync(new URL('../data/unified-comments.sql',import.meta.url),'utf8');
  f.DB.sqlite.exec(sql);
  assert.equal(manifest.comments.length,117);
  assert.equal(manifest.comments.filter(row=>row.parent_id).length,43);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,117);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comment_import_ids').get().n,117);
  assert.equal(f.DB.sqlite.prepare('SELECT payload FROM comment_import_batches').get().payload,null);
  assert.deepEqual(f.DB.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  for (const expected of manifest.comments) {
    const actual=f.DB.sqlite.prepare('SELECT id,document,nickname,author_url,body,body_html,parent_id,created_at FROM comments WHERE id=?').get(expected.id);
    const {content_hash,...publicFields}=expected;
    assert.deepEqual({...actual},publicFields);
    assert.match(actual.created_at,/\.000Z$/);
  }
  const page=(await f.request('/v1/comments?document=116')).data;
  assert.deepEqual(page.comments.map(row=>row.id),manifest.comments.filter(row=>row.document==='116').map(row=>row.id));
  assert.ok(page.comments.every(row=>!('status' in row)&&!('request_hash' in row)&&!('content_hash' in row)));
  const approved=(await f.request('/v1/admin/comments?status=approved',{admin:true,requestOrigin:null})).data;
  assert.equal(approved.comments.length,100); assert.ok(approved.comments.every(row=>row.status==='approved'));
  assert.equal((await f.request('/v1/admin/comments?status=approved&cursor='+approved.next_cursor,{admin:true,requestOrigin:null})).data.comments.length,17);
});

test('unified imported parents and mixed replies reject/delete together and repeated import never revives them',async context=>{
  const f=fixture(context);
  f.DB.sqlite.exec(readFileSync(new URL('../data/register-public.sql',import.meta.url),'utf8'));
  const sql=readFileSync(new URL('../data/unified-comments.sql',import.meta.url),'utf8');
  f.DB.sqlite.exec(sql);
  const reply=(await f.post(f.comment({document:'116',parent_id:'wp-4389'}))).data.id;
  await f.approve(reply);
  const reject=await f.request('/v1/admin/comments/wp-4379/reject',{method:'POST',admin:true,requestOrigin:null});
  assert.equal(reject.status,200); assert.equal(reject.data.affected,3);
  f.DB.sqlite.exec(sql);
  assert.equal(f.DB.sqlite.prepare("SELECT count(*) AS n FROM comments WHERE status='rejected'").get().n,3);
  assert.equal((await f.post(f.comment({document:'116',parent_id:'wp-4379'}))).status,409);
  assert.equal((await f.approve('wp-4389')).status,409);
  const deleted=await f.request('/v1/admin/comments/wp-4379',{method:'DELETE',admin:true,requestOrigin:null});
  assert.equal(deleted.status,200); assert.equal(deleted.data.deleted,3);
  f.DB.sqlite.exec(sql);
  assert.equal(f.DB.sqlite.prepare("SELECT count(*) AS n FROM comments WHERE id IN ('wp-4379','wp-4389',?)").get(reply).n,0);
  assert.equal((await f.post(f.comment({document:'116',parent_id:'wp-4379'}))).status,409);
  // Even a subsequent batch cannot reinsert a previously imported/deleted ID.
  f.DB.sqlite.exec(sql.replaceAll('public-comments-2026-10-25','second-public-batch'));
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,115);
  const batches=f.DB.sqlite.prepare('SELECT count(*) AS n FROM comment_import_batches').get().n;
  assert.throws(()=>f.DB.sqlite.exec(sql.replace(/'([a-f0-9]{64})'/,"'"+'0'.repeat(64)+"'")),/NOT NULL/);
  const manifest=JSON.parse(readFileSync(new URL('../data/unified-comments.json',import.meta.url),'utf8'));
  const conflicting=sql.replaceAll('public-comments-2026-10-25','conflicting-content-batch').replace(manifest.comments[0].content_hash,'0'.repeat(64));
  assert.throws(()=>f.DB.sqlite.exec(conflicting),/NOT NULL/);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comment_import_batches').get().n,batches);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM comments').get().n,115);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM visit_baselines').get().n,0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) AS n FROM visit_events').get().n,0);
});

test('chronological public pagination handles older imports inserted after newer comments',async context=>{
  const f=fixture(context), insert=f.DB.sqlite.prepare("INSERT INTO comments(id,document,nickname,body,status,request_id,request_hash,created_at) VALUES (?,'11','reader','text','approved',?,'hash',?)");
  const newer=randomUUID(); insert.run(newer,randomUUID(),'2026-10-25T00:00:00.000Z');
  for (let index=0;index<101;index++) insert.run('wp-'+(index+10),'import:'+(index+10),'2020-01-01T00:00:00.000Z');
  const first=(await f.request('/v1/comments?document=11')).data;
  assert.equal(first.comments.length,100); assert.equal(first.comments[0].id,'wp-10'); assert.equal(first.next_cursor,101);
  const last=(await f.request('/v1/comments?document=11&cursor='+first.next_cursor)).data;
  assert.deepEqual(last.comments.map(row=>row.id),['wp-110',newer]); assert.equal(last.next_cursor,null);
  assert.equal((await f.request('/v1/comments?document=12&cursor='+first.next_cursor)).status,400);
  assert.equal((await f.request('/v1/comments?document=11&cursor=999999')).status,400);
});

test('baseline CLI defaults to an offline dry-run and --apply needs an explicit cutover flag',context=>{
  const temporary=mkdtempSync(resolve(tmpdir(),'blog-baseline-')); context.after(()=>rmSync(temporary,{recursive:true,force:true}));
  const input=resolve(temporary,'baseline.json'); writeFileSync(input,JSON.stringify({site_base:1000,captured_at:'2026-10-25T00:00:00Z',document_bases:[{document:'11',base:10}]}));
  const script=new URL('../scripts/import-baseline.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
  const result=spawnSync(process.execPath,[script,'--input',input,'--batch','test-cutover'],{encoding:'utf8'}); assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).network_requests,0);
  const refused=spawnSync(process.execPath,[script,'--input',input,'--batch','test-cutover','--apply'],{encoding:'utf8'}); assert.notEqual(refused.status,0); assert.match(refused.stderr,/confirm-cutover/);
});
