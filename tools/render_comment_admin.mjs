/** Render the shared comment administrator UI without networking or credentials. */
import { staticAdminAssets } from '../services/blog-api/src/admin.mjs';

try {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65536) throw new TypeError('Renderer input is too large');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'api_base')) throw new TypeError('Expected only api_base');
  process.stdout.write(JSON.stringify(staticAdminAssets(value.api_base)) + '\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
