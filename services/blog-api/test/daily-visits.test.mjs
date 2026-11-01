import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import worker from '../src/worker.mjs';
import { testDatabase } from './d1-sqlite.mjs';

const token='test-admin-token-123456789012345678901234567890';
const capture='2026-10-25T16:30:00.000Z';
const manifest={timezone:'Asia/Shanghai',captured_at:capture,site_base:1000,first_date:'2026-10-24',cutover_date:'2026-10-26',items:[{date:'2026-10-24',visits:726,partial:false},{date:'2026-10-25',visits:null,partial:false},{date:'2026-10-26',visits:274,partial:true}]};
function fixture(t,enabled=true) {
  const DB=testDatabase(); t.after(()=>DB.close());
  const env={DB,ADMIN_TOKEN:token,VISITS_ENABLED:enabled?'true':'false'};
  const request=async (path,method='GET',value,admin=false) => {
    const response=await worker.fetch(new Request('https://api.example'+path,{method,headers:{'Content-Type':'application/json',Origin:'https://pku-xht.github.io',...(admin?{Authorization:'Bearer '+token}:{})},...(value?{body:JSON.stringify(value)}:{})}),env);
    const data=response.status===204?null:await response.json();
    assert.notEqual(response.status,500,JSON.stringify({data,error:DB.lastError?.error?.message,sql:DB.lastError?.sql}));
    return {status:response.status,data,headers:response.headers};
  };
  const seed=()=>DB.sqlite.prepare('INSERT INTO visit_baselines VALUES (1,?,?,?,?,?)').run('base','hash',1000,capture,capture);
  const upload=(value=manifest,batch='batch')=>request('/v1/admin/visits/history','POST',{confirm_import:true,batch_id:batch,...value},true);
  return {DB,env,request,seed,upload};
}
test('disabled and unseeded daily requests avoid writes and enforce parameters and methods',async t=>{
  const f=fixture(t,false); f.env.DB=undefined;
  const disabled=await f.request('/v1/visits/daily'); assert.equal(disabled.data.enabled,false); assert.deepEqual(disabled.data.items,[]);
  f.env.DB=f.DB; f.env.VISITS_ENABLED='true'; const before=f.DB.writes;
  assert.equal((await f.request('/v1/visits/daily')).data.seeded,false);
  for(const query of ['?range=7&range=30','?range=','?range=31','?unknown=1']) assert.equal((await f.request('/v1/visits/daily'+query)).status,400);
  assert.equal((await f.request('/v1/visits/daily','POST')).status,405);
  assert.equal((await f.request('/v1/visits/daily','OPTIONS')).status,204);
  assert.equal(f.DB.writes,before);
});
test('history import is atomic, baseline-bound, idempotent across batches, and refuses replacement',async t=>{
  const f=fixture(t); assert.equal((await f.upload()).data.error,'baseline_mismatch');
  f.seed(); assert.equal((await f.upload({...manifest,site_base:999})).status,400);
  assert.equal((await f.upload({...manifest,captured_at:'2026-10-25T16:31:00.000Z'})).data.error,'baseline_mismatch');
  assert.equal((await f.upload({...manifest,items:manifest.items.slice(1)})).status,400);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM visit_history').get().n,0);
  assert.equal((await f.upload()).data.imported,true);
  const writes=f.DB.writes; assert.equal((await f.upload(manifest,'another')).data.imported,false); assert.equal(f.DB.writes,writes);
  const changed={...manifest,items:manifest.items.map((v,i)=>i===0?{...v,partial:true}:v)};
  assert.equal((await f.upload(changed)).data.error,'history_exists');
  assert.equal(f.DB.sqlite.prepare('SELECT payload FROM visit_history_import').get().payload,null);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM visit_history').get().n,3);
});
test('daily reads count each event once in Shanghai, retain null gaps and exclude future events',async t=>{
  const f=fixture(t); f.seed();
  const insert=f.DB.sqlite.prepare('INSERT INTO visit_events VALUES (?,?,?)');
  insert.run('a',null,'2026-10-25T16:45:00.000Z');
  insert.run('b','11','2026-10-25T17:00:00.000Z');
  insert.run('c','215','2026-10-26T16:00:00.000Z');
  insert.run('future',null,'2099-01-01T00:00:00.000Z');
  const pre=await f.request('/v1/visits/daily?range=all'); assert.equal(pre.data.seeded,true); assert.equal(pre.data.history_seeded,false); assert.equal(pre.data.first_date,null); assert.deepEqual(pre.data.items,[]);
  await f.upload();
  const before=f.DB.writes, totals=f.DB.sqlite.prepare('SELECT sum(count) n FROM visit_deltas').get().n;
  const result=await f.request('/v1/visits/daily?range=all');
  assert.equal(result.headers.get('Cache-Control'),'no-store');
  assert.equal(result.data.timezone,'Asia/Shanghai'); assert.equal(result.data.history_seeded,true);
  assert.deepEqual(result.data.items.slice(0,4),[{date:'2026-10-24',visits:726,partial:true},{date:'2026-10-25',visits:null,partial:false},{date:'2026-10-26',visits:276,partial:true},{date:'2026-10-27',visits:1,partial:false}]);
  assert.equal(result.data.items.at(-1).partial,true);
  assert.equal(f.DB.writes,before); assert.equal(f.DB.sqlite.prepare('SELECT sum(count) n FROM visit_deltas').get().n,totals);
  assert.ok((await f.request('/v1/visits/daily?range=7')).data.items.length<=7);
});
test('a database failure rolls back both import metadata and history rows',async t=>{
  const f=fixture(t); f.seed();
  f.DB.sqlite.exec("CREATE TRIGGER history_failure BEFORE INSERT ON visit_history WHEN NEW.date='2026-10-25' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  const response=await worker.fetch(new Request('https://api.example/v1/admin/visits/history',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({confirm_import:true,batch_id:'batch',...manifest})}),f.env);
  assert.equal(response.status,500);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM visit_history').get().n,0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM visit_history_import').get().n,0);
  assert.equal(f.DB.sqlite.prepare('SELECT count(*) n FROM visit_baselines').get().n,1);
});

test('daily counts fail closed if a valid historical count plus events overflows a safe integer',async t=>{
  const f=fixture(t); f.seed();
  const base=Number.MAX_SAFE_INTEGER-1;
  f.DB.sqlite.prepare('UPDATE visit_baselines SET site_base=?').run(base);
  const value={...manifest,site_base:base,first_date:manifest.cutover_date,items:[{date:manifest.cutover_date,visits:base,partial:true}]};
  assert.equal((await f.upload(value)).status,200);
  const insert=f.DB.sqlite.prepare('INSERT INTO visit_events VALUES (?,?,?)');
  insert.run('safe',null,'2026-10-25T16:45:00.000Z');
  assert.equal((await f.request('/v1/visits/daily?range=all')).data.items[0].visits,Number.MAX_SAFE_INTEGER);
  insert.run('overflow',null,'2026-10-25T16:46:00.000Z');
  const before=f.DB.writes, result=await f.request('/v1/visits/daily?range=all');
  assert.equal(result.status,503); assert.equal(result.data.error,'daily_count_overflow');
  assert.equal(f.DB.writes,before);
});
test('CLI dry-run is offline and apply requires explicit confirmation',t=>{
  const dir=mkdtempSync(resolve(tmpdir(),'daily-history-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=resolve(dir,'history.json'); writeFileSync(input,JSON.stringify({version:1,...manifest}));
  const script=new URL('../scripts/import-history.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
  const args=[script,'--input',input,'--batch','test'];
  const dry=spawnSync(process.execPath,args,{encoding:'utf8'}); assert.equal(dry.status,0,dry.stderr); assert.equal(JSON.parse(dry.stdout).network_requests,0);
  const apply=spawnSync(process.execPath,[...args,'--apply'],{encoding:'utf8'}); assert.notEqual(apply.status,0); assert.match(apply.stderr,/confirm-history/);
  for(const extra of [['--input',input],['--unknown'],['--api']]) assert.notEqual(spawnSync(process.execPath,[...args,...extra],{encoding:'utf8'}).status,0);
});
