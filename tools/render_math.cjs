// Build-time renderer. No KaTeX JavaScript is loaded by blog readers.
'use strict';
const fs = require('node:fs');
const katex = require('./vendor/katex/katex.cjs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = input.map(item => {
  try {
    return {html: katex.renderToString(item.tex, {
      displayMode: item.display,
      output: 'htmlAndMathml',
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      maxExpand: 1000
    })};
  } catch (error) {
    return {error: error.message};
  }
});
process.stdout.write(JSON.stringify(results));
