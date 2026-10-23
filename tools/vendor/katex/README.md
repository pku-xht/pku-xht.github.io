# KaTeX build renderer

`katex.cjs` is the unmodified `dist/katex.min.js` from the official npm package. Version, tarball URL and verified npm SHA-512 integrity are recorded in `assets/vendor/katex/version.json`; its MIT license is in `assets/vendor/katex/LICENSE`.

Only the build tool loads this CommonJS file. Blog readers receive pre-rendered HTML/MathML and the package's local CSS and fonts.
