import { staticArticleEditorAssets } from '../services/blog-api/src/article-editor.mjs';

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1048576) throw new Error('Public editor configuration too large');
}
const value = JSON.parse(input);
if (!value || Object.keys(value).sort().join(',') !== 'api_base,documents') throw new Error('Only public editor configuration is accepted');
process.stdout.write(JSON.stringify(staticArticleEditorAssets(value.api_base, value.documents)));
