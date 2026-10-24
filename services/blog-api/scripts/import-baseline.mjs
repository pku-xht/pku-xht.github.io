import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const args=process.argv.slice(2);
function option(name) { const at=args.indexOf(name); return at<0?null:args[at+1]; }
const input=option('--input'), batch=option('--batch');
if (!input || !batch || !/^[A-Za-z0-9._-]{1,80}$/.test(batch)) throw new Error('Use --input <verified-public-baseline.json> --batch <cutover-batch>. Default is dry-run; no network request.');
const value=JSON.parse(await readFile(input,'utf8'));
if (!value || Object.keys(value).some(key=>!['site_base','document_bases','captured_at'].includes(key))) throw new Error('Input accepts only site_base, document_bases, captured_at.');
if (!Number.isSafeInteger(value.site_base) || value.site_base<0 || !Array.isArray(value.document_bases) || !value.document_bases.length || !Number.isFinite(Date.parse(value.captured_at))) throw new Error('A complete, verified cutover baseline is required.');
const seen=new Set();
for (const row of value.document_bases) {
  if (!row || Object.keys(row).sort().join(',')!=='base,document' || !/^[1-9][0-9]*$/.test(row.document) || !Number.isSafeInteger(row.base) || row.base<0 || seen.has(row.document)) throw new Error('Invalid document baseline.');
  seen.add(row.document);
}
const payload={confirm_cutover:true,batch_id:batch,...value};
if (!args.includes('--apply')) {
  console.log(JSON.stringify({dry_run:true,batch_id:batch,documents:seen.size,site_base:value.site_base,sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),network_requests:0}));
} else {
  if (!args.includes('--confirm-cutover')) throw new Error('--apply also requires --confirm-cutover.');
  const api=option('--api'), token=process.env.BLOG_ADMIN_TOKEN;
  if (!api || !token || token.length<32) throw new Error('Set --api and the BLOG_ADMIN_TOKEN environment secret.');
  const url=new URL(api);
  if (url.protocol!=='https:' && !(['localhost','127.0.0.1'].includes(url.hostname) && url.protocol==='http:')) throw new Error('Use HTTPS for the deployed service.');
  if (url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('--api must be a service origin only.');
  const response=await fetch(new URL('/v1/admin/visits/baseline',url),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
  const result=await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}: ${result.message}`);
  console.log(JSON.stringify(result));
}
