import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import worker from '../src/worker.mjs';
import { sqliteD1 } from '../test/d1-sqlite.mjs';

// A local-only bridge for UI acceptance without an npm installation or account.
// It is not a Cloudflare compatibility emulator or a production server.
const args=process.argv.slice(2), at=args.indexOf('--database');
const databasePath=at<0?resolve(tmpdir(),'xht37-blog-api-local.sqlite'):resolve(args[at+1]);
const portAt=args.indexOf('--port'), port=portAt<0?8787:Number(args[portAt+1]);
if (!Number.isInteger(port)||port<1024||port>65535) throw new Error('Use a local port from 1024 to 65535.');
for (const key of ['ADMIN_TOKEN','RATE_LIMIT_SALT']) if (!process.env[key] || process.env[key].length<32) throw new Error(`Set ${key} in the process environment (minimum 32 characters); never save it in this public repository.`);
const project=resolve(import.meta.dirname,'../../..');
const withinProject=relative(project,databasePath);
if (!withinProject || (!withinProject.startsWith('..'+sep) && withinProject!=='..' && !isAbsolute(withinProject))) throw new Error('Keep the local database outside the public repository.');
const DB=sqliteD1(databasePath);
DB.sqlite.exec(readFileSync(new URL('../data/register-public.sql',import.meta.url),'utf8'));
const env={DB,ADMIN_TOKEN:process.env.ADMIN_TOKEN,RATE_LIMIT_SALT:process.env.RATE_LIMIT_SALT,ALLOWED_ORIGINS:'https://pku-xht.github.io,http://127.0.0.1:8791,http://localhost:8791',VISITS_ENABLED:'false'};
const server=createServer(async (incoming,outgoing)=>{
  try {
    const chunks=[]; let length=0;
    for await (const chunk of incoming) { length+=chunk.length; if (length>65536) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(chunk); }
    const headers=new Headers();
    for (const [key,value] of Object.entries(incoming.headers)) if (value!==undefined) headers.set(key,Array.isArray(value)?value.join(','):value);
    headers.set('CF-Connecting-IP',incoming.socket.remoteAddress||'127.0.0.1');
    const request=new Request(`http://127.0.0.1:${port}${incoming.url}`,{method:incoming.method,headers,...(['GET','HEAD'].includes(incoming.method)?{}:{body:Buffer.concat(chunks)})});
    const response=await worker.fetch(request,env);
    outgoing.writeHead(response.status,Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500,{'Content-Type':'application/json'}); outgoing.end('{"error":"local_bridge_error"}'); }
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,admin:`http://127.0.0.1:${port}/admin`,database:databasePath,documents:DB.sqlite.prepare('SELECT count(*) AS n FROM public_documents').get().n,visits_enabled:false})));
function close() { server.close(()=>{DB.close();process.exit(0);}); }
process.on('SIGINT',close); process.on('SIGTERM',close);
