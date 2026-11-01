import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateHistory } from '../src/visit-history.mjs';

const args = process.argv.slice(2);
const values = new Map(), flags = new Set();
for (let i=0;i<args.length;i++) {
  const name=args[i];
  if (['--input','--batch','--api'].includes(name)) {
    if (values.has(name) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Invalid or duplicate option.');
    values.set(name,args[++i]);
  } else if (['--apply','--confirm-history'].includes(name)) {
    if (flags.has(name)) throw new Error('Duplicate flag.');
    flags.add(name);
  } else throw new Error('Unknown option.');
}
function option(name) { return values.get(name) ?? null; }
const input=option('--input'), batch=option('--batch');
if (!input || !batch || !/^[A-Za-z0-9._-]{1,80}$/.test(batch)) throw new Error('Use --input <private-history.json> --batch <id>; default is offline dry-run.');
const raw=JSON.parse(await readFile(input,'utf8'));
if (!raw || raw.version !== 1) throw new Error('Expected normalized history version 1.');
const {version,...rest}=raw, value=validateHistory(rest);
const payload={confirm_import:true,batch_id:batch,...value};
if (!args.includes('--apply')) {
  console.log(JSON.stringify({dry_run:true,batch_id:batch,days:value.items.length,sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'),network_requests:0}));
} else {
  if (!args.includes('--confirm-history')) throw new Error('--apply requires --confirm-history.');
  const api=option('--api'), token=process.env.BLOG_ADMIN_TOKEN;
  if (!api || !token || token.length<32) throw new Error('Set --api and the BLOG_ADMIN_TOKEN environment secret.');
  const url=new URL(api);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS for the deployed service.');
  if (url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('--api must be a service origin only.');
  const response=await fetch(new URL('/v1/admin/visits/history',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
  const result=await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}: ${result.message}`);
  console.log(JSON.stringify(result));
}
