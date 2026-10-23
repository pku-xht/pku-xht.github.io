# Offline Markdown and YAML dependencies

These pure Python sources are vendored from official PyPI wheels so the blog can build with Python 3.9+ and `-S`, without a global install or network request.

| Package | Version | Purpose |
|---|---|---|
| markdown-it-py | 3.0.0 | CommonMark parsing with the site's math preservation rules |
| mdurl | 0.1.2 | markdown-it-py URL handling |
| PyYAML | 6.0.2 | Safe YAML front matter and collection loading |

`packages.json` records the upstream wheel URLs and SHA-256 values, all verified before extraction. Only package `.py` sources were copied; optional compiled PyYAML extensions are omitted. Original MIT licenses are retained in `licenses/`.

Upstream source bytes are preserved, including PyYAML's original trailing whitespace and final blank lines; a scoped `.gitattributes` rule permits those bytes.

The blog loader adds this directory to its own import path. Do not edit vendored package behavior for site-specific formatting; keep that in `tools/blog_sources.py`.
