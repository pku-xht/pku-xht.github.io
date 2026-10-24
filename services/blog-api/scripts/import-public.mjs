import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const args = process.argv.slice(2);
function option(name, fallback) { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; }
const project = resolve(import.meta.dirname, '../../..');
const collection = resolve(option('--collection', resolve(project, 'content/blog/collection.yaml')));
const output = resolve(option('--out', resolve(import.meta.dirname, '../data')));
const explicitLegacyFile = option('--legacy');
const legacyFile = explicitLegacyFile || resolve(output, 'legacy-parents.json');
const content = await readFile(collection, 'utf8');
const documents = [];
const ids = new Set();
for (const line of content.split(/\r?\n/)) {
  const match = /^\s*-\s*(posts|pages)\/([1-9][0-9]*)\.md\s*$/.exec(line);
  if (!match) {
    if (/^\s*-/.test(line)) throw new Error('Invalid collection member: '+line);
    continue;
  }
  if (ids.has(match[2])) throw new Error('Duplicate document ID: '+match[2]);
  const source = await readFile(resolve(dirname(collection), `${match[1]}/${match[2]}.md`), 'utf8');
  if (!new RegExp(`^id: ${match[2]}$`, 'm').test(source)) throw new Error('Source ID does not match collection: '+match[2]);
  ids.add(match[2]); documents.push({ id: match[2], kind: match[1] === 'posts' ? 'post' : 'page' });
}
if (!documents.length) throw new Error('No public documents in collection.');
const parents = [];
let legacyText = null;
try { legacyText = await readFile(resolve(legacyFile), 'utf8'); }
catch (error) { if (explicitLegacyFile || error.code !== 'ENOENT') throw error; }
if (legacyText !== null) {
  const manifest = JSON.parse(legacyText);
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.parents) || Object.keys(manifest).some(key => !['version','parents'].includes(key))) throw new Error('Expected {version:1, parents:[{id:"wp-...",document:"..."}]}.');
  const seen = new Set();
  for (const row of manifest.parents) {
    if (!row || Object.keys(row).sort().join(',') !== 'document,id' || !/^wp-[1-9][0-9]*$/.test(row.id) || !ids.has(row.document) || seen.has(row.id)) throw new Error('Invalid, duplicate, or non-public legacy parent.');
    seen.add(row.id); parents.push({ id: row.id, document: row.document });
  }
}
documents.sort((a,b) => Number(a.id)-Number(b.id));
parents.sort((a,b) => Number(a.id.slice(3))-Number(b.id.slice(3)));
const quote = value => "'"+value.replaceAll("'","''")+"'";
const statements = ['-- Generated only from the maintained public collection and explicit public legacy-parent manifest.', '-- No comment text, user profiles, credentials, IP addresses, or Visits baselines are imported.', '-- D1 executes statements through its own transaction handling; do not add SQL BEGIN/COMMIT.'];
statements.push('INSERT INTO public_documents(id,kind) VALUES\n'+documents.map(row=>`(${quote(row.id)},${quote(row.kind)})`).join(',\n')+'\nON CONFLICT(id) DO NOTHING;');
if (parents.length) statements.push('INSERT INTO legacy_parents(id,document) VALUES\n'+parents.map(row=>`(${quote(row.id)},${quote(row.document)})`).join(',\n')+'\nON CONFLICT(id) DO NOTHING;');
await mkdir(output, {recursive:true});
await writeFile(resolve(output,'public-documents.json'), JSON.stringify({version:1,documents},null,2)+'\n');
await writeFile(resolve(output,'legacy-parents.json'), JSON.stringify({version:1,parents},null,2)+'\n');
await writeFile(resolve(output,'register-public.sql'), statements.join('\n')+'\n');
console.log(JSON.stringify({documents:documents.length,legacy_parents:parents.length,output,visits_seeded:false}));
