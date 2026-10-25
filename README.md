# 徐皓天 · Personal homepage

Bilingual personal homepage and Chinese blog for [pku-xht.github.io](https://pku-xht.github.io/).

## Local preview

Run a static server from this directory, for example:

```sh
python -S -X utf8 -m http.server 8791 --bind 127.0.0.1
```

Open `http://127.0.0.1:8791/` or `/blog/`. The checked-in static pages need no package installation or build step to preview.

## Editing content

Edit `content.js`. Each text field can contain `{ zh: "中文", en: "English" }`.
Keep the matching Chinese content in `index.html` synchronized so the no-JavaScript fallback stays current.

- `profile`: name, introduction, biography and advisor.
- `records`: education, internships, publications, teaching and awards.
- Publications may include `authors`, `highlightAuthor`, and `links` (each link has a bilingual `label` and a `url`).
- Other records may include a `report` with a bilingual `title`, `url`, `authors`, and `highlightAuthor`; it follows the record links inline and wraps naturally on narrow screens.
- `contacts`: public contact destinations.
- Empty record groups are automatically hidden along with their navigation links.
- Add only facts approved for public display. Do not commit CV drafts or private review notes.

The initial language follows the browser's supported language preference. An explicit selection is remembered locally. Direct language links use `?lang=zh` and `?lang=en`.

### Content conventions

- Preserve confirmed facts while removing repetition. State the current PhD identity once in the profile introduction, without repeating it in the biography.
- Keep Chinese and English equivalent in meaning, and synchronize the Chinese fallback in `index.html` whenever content changes.
- List teaching semesters without “正在担任” or “current”. Keep the semester or year attached to duties that applied only then.
- Preserve the precision of known dates: keep the internship's exact days and do not invent a PhD start month. Use an en dash without surrounding spaces in Chinese (`2026.07.06–2026.09.09`) and with spaces in English (`Jul 6 – Sep 9, 2026`).
- Write `GitHub` consistently. Use short, accurate resource labels without repeating dates already shown in the record.
- Keep `已录用` / `Accepted` until publication is confirmed; do not silently change it to `已发表` / `Published`.
- Keep the DeepSeek report under the internship. Abbreviate its author list as `authors: ["…", "Haotian Xu", "…"]` and set `highlightAuthor: "Haotian Xu"` to bold the owner's name.

## GitHub Pages

Publish the repository's `main` branch from `/ (root)` in **Settings → Pages**.
The `.nojekyll` file tells GitHub to serve the static files directly.

## Files

- `index.html`: semantic page structure and readable Chinese fallback.
- `styles.css`: responsive layout and reduced-motion support.
- `content.js`: bilingual public content.
- `site.js`: content rendering and language selection.
- `assets/`: local site artwork and icons.
- `DESIGN.md`: implementation direction.

The website uses no analytics, remote fonts or third-party runtime scripts. Blog formulas are rendered during generation with a vendored KaTeX build; its CSS and fonts are served locally.

## Blog migration

The public-content inventory and batch status for the migration from `www.xht37.com` are maintained in [migration/README.md](migration/README.md). Non-public WordPress content remains on the old site and must stay outside this public repository.

The owner selected **C · personal blog**: warm paper, serif headings, excerpt lists and single-column articles with collapsible contents. The first batch contained 29 public notes; the full local migration covers all 211 public posts and the old About page. Four original categories and original tags help readers find articles. [design/README.md](design/README.md) retains the earlier alternatives as design history; they are not linked from the homepage.

### Blog sources and generation

- `content/blog/posts/<WordPress-ID>.md`: the 211 maintained article sources, each with YAML front matter.
- `content/blog/pages/<WordPress-ID>.md`: maintained historical pages; currently `215.md`, the old About page.
- `content/blog/collection.yaml`: the registered source-file set. Missing, duplicate or unregistered Markdown files fail the build.
- `content/blog/resources.yaml`: the maintained image and attachment map, with original URLs, local paths, byte sizes and hashes. Files remain in `blog/media/`.
- `content/blog/comments/index.yaml` and `<post-ID>.yaml`: the registered historical public-comment archives, preserving original HTML, names, full dates and reply IDs. They contain no private author metadata or new pending comments.
- `content/blog/friends.yaml`: the maintained 25 original friend links, in their original order.
- `content/blog/features.yaml`: explicit comment/Visits switches and public API URLs. Comments are enabled against the verified Cloudflare backend; Visits stays disabled. All new comments require moderation.
- `/blog/comment/`: the owner's comment-management page, generated with its local JavaScript/CSS from the shared UI in `services/blog-api/src/admin*.mjs`. It uses the existing administrator password and is omitted from public navigation and search indexing.
- `tools/blog_sources.py`: safe YAML loading and CommonMark rendering with raw TeX and complex HTML preservation. Pure Python dependencies are pinned in `tools/vendor/python/`.
- `tools/build_blog.py` and `tools/render_math.cjs`: offline generation of the blog, archive, article/history routes, category lists, static tag pages and friend links, including archived discussions.
- `blog/blog.css` and `blog/blog.js`: the selected layout, title/excerpt/category/tag search and code-copy enhancement. Articles, category lists and archive remain readable without JavaScript.
- `migration/public-batch.json`: generated URL mapping, counts, maintained source filenames and SHA-256 values. Its legacy `publication: local-only` field identifies a locally generated build report; it does not track the live site. Current deployment state and verification are recorded in [migration/deployment-2026-10-25.md](migration/deployment-2026-10-25.md).

The interaction batch is recorded in [migration/interactive-2026-10-25.md](migration/interactive-2026-10-25.md). Its Cloudflare backend and updated GitHub Pages site are deployed and verified; the publication includes archived comments, friend links, tag navigation and moderated new comments.

The original `migration/sources/public-2026-10-23.json` and its embedded original HTML, image map, legacy-anchor evidence, earlier notes snapshot and summary overrides remain unchanged as migration evidence. Normal builds do not read these snapshots or restore their content over maintained Markdown. `notes-batch1.json` records the earlier batch.

### Editing an article

Edit the existing Markdown source, for example [1154.md](content/blog/posts/1154.md). Its YAML front matter contains `id`, `type`, `title`, `date`, `modified`, `slug`, `original_url`, `categories`, `tags`, and an optional `summary`. Keep the original ID, type and URL stable to retain the current route. Dates include the original `+08:00` timezone; categories and tags are lists of `{id, name}` mappings. The summary controls the list excerpt, or may be omitted for automatic extraction.

Use normal Markdown headings, paragraphs, links, lists, block quotes and fenced code. `$...$` and `$$...$$` preserve original TeX, including backslashes, underscores and multiline display formulas. Complex HTML blocks are supported where conversion would change structure or content. Preserve intentional Markdown hard breaks and original code trailing spaces.

An optional `legacy_anchors` mapping records old fragments that cannot be inferred from unique heading names; `129.md` contains the verified `lwptoc45` target. Adding or deliberately removing an article or historical page requires updating both its Markdown file and `collection.yaml`; changing its anchors does not. Review the corresponding generated path when removing a document, since the checker rejects stale pages outside the collection. New images and attachments also need a `resources.yaml` entry. Do not hand-edit generated blog HTML.

### Original-site import tools

`tools/sync_public_blog.py` refreshes a public snapshot and its directly referenced images and old-site attachments. It uses anonymous requests without browser cookies, verifies `publish` and password-protection flags before saving, checks pagination totals and unique IDs, and downloads at most four assets at a time. It does not collect comments or sign in. Use it only for a confirmed migration scope; a normal rebuild is offline and does not need this network step:

```sh
python -S -u -X utf8 tools/sync_public_blog.py --checked-on 2026-10-23
```

If the source snapshot is complete, add `--assets-only` to resume asset downloads. Existing hashed assets are reused; partial unrecorded downloads are compared with fresh downloads before reuse. This network tool does not update maintained Markdown.

`tools/import_blog_markdown.py` is the one-time snapshot-to-Markdown converter. It validates each block and whole document before writing, and refuses to overwrite existing Markdown, `collection.yaml` or `resources.yaml`:

```sh
python -S -X utf8 tools/import_blog_markdown.py
```

The current collection is already imported. For a later batch, use a separate `--output-root` for review and merge approved sources and manifests deliberately. Do not import over maintained files.

The separately authorized public comments and sidebar friends use their own one-time importers:

```sh
python -S -X utf8 tools/sync_public_comments.py --checked-on 2026-10-25
python -S -X utf8 tools/sync_blog_friends.py --checked-on 2026-10-25
```

These commands refuse to overwrite the existing maintained archives. The comment importer restricts requests to registered public document IDs and approved public comments, and never logs into WordPress. The preserved source and front-end audit cover 117 comments, including 43 replies, across the 212 registered documents; no additional visible comment IDs were found. Friend evidence contains only the public sidebar container, not a full-page or authenticated export.

### Build and check

Regenerate from maintained Markdown/YAML using Python 3.9+ and Node.js (verified with Python 3.9.13 and Node 24.6.0):

```sh
python -S -X utf8 tools/build_blog.py
python -S -X utf8 tools/check_blog.py
node --check blog/blog.js
```

No network or package installation is used. The default checker compares maintained sources with generated pages, indexes and resources, allowing intentional future edits. To additionally check fidelity against the preserved original JSON/HTML, run:

```sh
python -S -X utf8 tools/check_blog.py --original-snapshot
python -S -X utf8 tools/test_blog_sources.py
python -S -X utf8 tools/test_blog_comments.py
node tools/test_blog_frontend.cjs
```

The original-snapshot mode checks complete text, original TeX, exact code bytes, metadata, ordered HTML structure, resource provenance and old anchor evidence. Intentional later edits may fail this archival comparison while passing the normal source check. Isolated tests use temporary files to verify that edits affect real builds, missing or corrupt sources fail, and builds work without original snapshots.

The generator normalizes heading levels, creates contents links, and redirects links between migrated articles to local pages. Each contents entry links only to its local heading. TeX rendering adapts only old WordPress en dashes and the old literal XOR caret spelling; unmodified TeX remains in `data-original-math` for comparison.

Markdown sources and generated post HTML retain intentional trailing spaces. Their scoped Git whitespace attributes permit those bytes; independent code comparison still checks them exactly.

The homepage's Blog navigation label is bilingual; the migrated Chinese articles are not automatically translated. The old About page is presented as a historical archive and does not replace current homepage facts. Historical public comments are maintained separately from article Markdown and included in the published interaction batch. Old-site redirects and private content are outside this migration.

### Writable comments and future Visits

The selected backend is Cloudflare Workers + D1, implemented in `services/blog-api/`. Readers do not need an account: they must enter a nickname and comment body, and every new submission waits for owner approval before becoming public. New comment bodies are plain text; the browser renders them without interpreting HTML. Historical comments already approved on the old site remain static, while only their public IDs/document assignments are registered as reply targets in the backend.

Only enable `features.yaml` comments after the real service is configured and verified; this has been completed for the current published build. Pending comments, review tokens, real credentials and database exports belong in the backend or a separate private location, never in this public repository, including ignored directories. Backend setup, encrypted administrator-token retrieval, the moderation page, local SQLite tests and remote smoke checks have one maintained entry in [services/blog-api/README.md](services/blog-api/README.md).

Visits stays disabled in both the static configuration and Worker environment. The default pages contain neither its counter UI nor its script, and make no Visits requests. At the later cutover, collect fresh per-document counts and the old site's independent total, review the cutover window, and import the complete baseline atomically before explicitly enabling counting. The old site's total must not be inferred by summing article counts, and the current archival snapshot must not be reused as a fresh cutover baseline.
