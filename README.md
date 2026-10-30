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

Visits is currently disabled. The website loads no remote fonts or remote third-party scripts. Article formulas are rendered during generation with vendored KaTeX; dynamic comment formulas use its local runtime. Its scripts, CSS and fonts are served locally.

## Blog

The blog keeps the selected **C · personal blog** design, stable article URLs, four categories and 91 tag pages. Its 211 articles and page `215` form one public collection. Page `215` uses the same reading and editing interface as the articles; it does not replace the separately maintained homepage. Readers see one set of articles and comments. The navigation's single **旧站 ↗** link is the only source-site entrance; source notes, migration badges and separate historical sections are removed.

The unified interface, comment backend and online editor were **deployed on 2026-10-26**. A real save, automatic build/Pages publication, stale-version rejection and exact source restoration have been verified. Chrome now loads the live comments and Worker API after a local Windows proxy repair; administrator login with Chrome autofill and session restoration have also been verified in the following release. Current evidence is recorded in [migration/unified-blog-2026-10-25.md](migration/unified-blog-2026-10-25.md); earlier releases remain in [migration/README.md](migration/README.md). Hidden content remains outside this public repository and outside the current scope.

The comment workspace, shared blog styling and **30-day administrator sessions were deployed on 2026-10-26**, together with the approved friend-link maintenance. Production login, session restoration/revocation, all-comment management and Chrome access are verified in [migration/admin-workspace-2026-10-26.md](migration/admin-workspace-2026-10-26.md).

### Sources and generation

- `content/blog/posts/<ID>.md` and `content/blog/pages/<ID>.md`: the sole maintained article/page sources, one Markdown file with YAML metadata per document.
- `content/blog/collection.yaml`: the exact registered source set. Missing, duplicate or unregistered Markdown fails the build.
- `content/blog/resources.yaml`: maintained resource paths, source URLs, sizes and hashes; files live in `blog/media/`.
- `content/blog/comments/index.yaml` and `<ID>.yaml`: the preserved 117 previously public comments, including 43 replies. These are import and fidelity evidence, not a second runtime comment store. Do not overwrite them with moderated or new backend data.
- `content/blog/friends.yaml`: the 20 maintained friend links, preserving the remaining entries' relative order. Current updates and removals are recorded in [migration/friends-2026-10-26.md](migration/friends-2026-10-26.md).
- `content/blog/features.yaml`: public comment/API configuration and the separately disabled Visits switch, shared by the blog and personal homepage.
- `blog/visits-config.js`: generated homepage Visits configuration; do not edit it separately. The builder updates only its content-hashed script URL in `index.html` when the configuration changes.
- `tools/blog_sources.py`, `tools/build_blog.py`, `tools/render_math.cjs`: offline source loading, CommonMark/HTML/TeX preservation and static generation. Dependencies are vendored; ordinary builds need no network or installation.
- `blog/blog.css`, `blog/blog.js`, `blog/interactions.js`: the selected layout, search, code copying and unified API-backed discussion. Articles remain readable without JavaScript; comments need JavaScript and the backend. No static comment fallback can reveal a comment after it is rejected or deleted.
- `services/blog-api/src/admin*.mjs` and `article-editor.mjs`: shared session login, comment management, visual styles and editor assets. The builder generates `/blog/comment/`, shared `/blog/editor/` assets and an `exit/` page for every registered document.
- `services/blog-api/data/unified-comments.json` and `.sql`: deterministic, public-only import assets. Their persistent batch and ID hashes prevent reruns from restoring a deleted comment or undoing moderation.
- `migration/public-batch.json`: generated source hashes, URL mappings, counts and administrative-asset evidence. Its legacy `publication: local-only` describes a build report, not the live deployment state.

The immutable public-only capture `migration/sources/native-public-2026-10-29.json` records the WordPress editor Markdown, provenance, hashes and the approved patch to document 925. It is evidence, not the current editing source. The subsequently authorized standardization is recorded in [the standard Markdown batch](migration/standard-markdown-2026-10-30.md); [native-source verification](migration/native-markdown-2026-10-29.md) describes its historical baseline.

Earlier JSON/HTML snapshots in `migration/sources/`, batch evidence and public comment YAML remain available as evidence of their respective layers. An HTML round trip does not prove original Markdown fidelity. Normal builds do not restore snapshots over maintained articles. [design/README.md](design/README.md) retains the unselected design alternatives without linking them from the public homepage.

### Editing an article

Edit the existing Markdown, for example [1154.md](content/blog/posts/1154.md). YAML includes `id`, `type`, `title`, `date`, `modified`, `slug`, `original_url`, `categories`, `tags`, and optional `summary`. Keep document identity and routes stable. Dates retain `+08:00`; categories/tags are `{id, name}` lists. A supplied summary controls the excerpt; otherwise the builder derives one.

Use CommonMark with GFM tables and strikethrough, and standard TeX in `$...$` or `$$...$$`. Write intentional hard breaks explicitly, use standard list indentation and math commands, separate headings with blank lines, and end the file with a newline. Embed complex HTML when conversion would alter it; preserve code whitespace. `legacy_anchors` records verified compatibility fragments where unique heading names are insufficient. Intentional document additions/removals need both the source and `collection.yaml`; new resources also need `resources.yaml`. Do not hand-edit generated HTML.

For online editing, append `exit` to an article URL: `/blog/posts/1154/exit/`, or `/blog/pages/215/exit/`. The editor loads that document's complete Markdown and YAML after administrator login. All 212 registered documents use this entry point; arbitrary repository paths and new documents are not accepted.

**保存并更新网站** submits one candidate on `codex/article-edit/<UUID>`. The trusted workflow from `main` validates the edit, builds/checks the site and creates one main-branch commit containing the source and generated pages. It explicitly requests a Pages build and verifies that revision before reporting success. A pending submission is not publication; a failed build or a changed source version does not silently overwrite the published article. Reuse the save request ID on an uncertain retry. Public repository branches are public too, so the editor is only for material approved for public display.

### Build and check

Run from the repository root with Python 3.9+ and Node 24.6+:

```sh
python -S -X utf8 tools/build_blog.py
python -S -X utf8 tools/check_blog.py
node --check blog/blog.js
node --check blog/interactions.js
python -S -X utf8 tools/test_blog_sources.py
python -S -X utf8 tools/test_blog_comments.py
node tools/test_blog_frontend.cjs
node --test services/blog-api/test/*.test.mjs
python -S -X utf8 tools/test_publish_blog_edit.py
```

The backend suite uses real SQLite through `node:sqlite`; it does not prove a Cloudflare deployment. The management bundling regression requires esbuild, optionally located through `BLOG_ESBUILD_MODULE`. The Worker-runtime regression additionally requires Miniflare/workerd, located through `BLOG_MINIFLARE_MODULE` (the installed Wrangler dependency's `miniflare/dist/src/index.js`). It runs the real bundled Worker against a local fictional GitHub service and temporary D1, covering runtime-specific fetch options, redirect credential isolation and session creation/restoration/revocation. An explicitly skipped bundling or runtime check is not a pass. The publication tests are local and must not be described as a real GitHub/Pages edit.

To check the registered public sources against the standard format and independently compare the authorized conversion with its Git baseline:

```sh
python -B -S -X utf8 tools/format_blog_markdown.py
python -B -S -X utf8 tools/check_formatted_blog.py
python -B -S -X utf8 tools/check_native_blog.py --formal --formatted
python -B -S -X utf8 tools/test_format_blog_markdown.py
python -B -S -X utf8 tools/test_formatted_blog.py
```

The formatter is read-only by default; `--write` changes registered public sources. Review changes and run independent checks before adoption. The formatted native check verifies the recorded capture and deterministic conversion; intentional later content edits require a separately reviewed baseline rather than a claim of byte equality to the capture. `--formal --source-ref 9b13223` checks the historical native baseline, and `--capture-archive <external-capture-root>` can additionally compare provenance to the independent capture. This establishes correspondence with recorded evidence, not cryptographic attestation from WordPress. Private input remains outside this public repository.

`tools/adopt_native_blog.py --output <fresh-candidate-directory>` prepares a separately authorized reimport without overwriting maintained sources. `tools/check_native_blog.py --candidate <directory>` verifies it; adding `--apply` performs guarded local adoption with staged files, backups and a recovery journal. Review subsequent edits before reimport; never overwrite maintained sources blindly. This migration operation is not the normal editing or publishing path.

The earlier rendered-HTML comparison remains available with `python -S -X utf8 tools/check_blog.py --original-snapshot`. It checks a different display layer and does not establish native Markdown fidelity. The renderer uses CommonMark, GFM tables and strikethrough, and math; it no longer applies Editor.md soft-break, list indentation or TeX alias compatibility. Immutable captures retain the original spelling.

Formatting writes explicit Markdown hard breaks and standard nested lists into the maintained sources. Math uses ordinary punctuation, `\lor`, `\land` and `\mathbb{...}`; quote-contained display formulas use one physical `> $$...$$` line so quote markers stay outside TeX. It preserves code, link targets and YAML. `data-original-math` records the maintained formula spelling; the immutable capture retains the earlier WordPress spelling. Default KaTeX validation is distinct from a live GitHub/MathJax preview.

### Comment data and local API

D1 is the only runtime store for **all** comments. The 117 imported public comments enter `approved`; later submissions enter `pending`. The same public API, moderation queues, reply tree, rejection and deletion apply to every comment. Import IDs `wp-N` and existing `#comment-N` anchors remain stable without reader-facing source labels. Preserved YAML/JSON only verifies the public import and never overwrites backend state.

The management workspace defaults to **all comments**, newest first, with status counts, article-title links, per-article filtering and a nickname/body search across the full database. It loads up to 100 rows per page. Counts follow the selected article and search, while the status selector chooses which rows to show. Moderation reloads the current view so status changes and affected reply descendants do not leave stale rows.

Generate registered-document data and the deterministic public-comment import offline:

```sh
node services/blog-api/scripts/import-public.mjs
python -S -X utf8 services/blog-api/scripts/import-public-comments.py
python -S -X utf8 services/blog-api/scripts/import-public-comments.py --check
```

The document registry includes titles read with the canonical YAML loader, so comment management uses the maintained article names. The comment import is one SQL statement and its trigger transaction. Batch/ID hashes persist after moderation/deletion; repeated batches skip those records, and conflicting hashes fail closed. The temporary import payload is cleared when the trigger completes. The older minimal `legacy-parents.json` remains compatibility evidence and grants no reply permission; a reply's parent must exist and be approved in `comments` on the same document.

For a local API, supply fictional local `ADMIN_TOKEN` and `RATE_LIMIT_SALT` in the process environment, then run:

```sh
node services/blog-api/scripts/dev.mjs --port 8787
```

The bridge binds only `127.0.0.1`, applies schema/registered public comments and keeps SQLite outside this public repository, by default in the OS temporary directory. Use `--database <outside-repository-path>` to select another private location. Visits is forced off. Its administrator page is `http://127.0.0.1:8787/admin`; the static preview remains on port 8791. Without a configured GitHub editing secret the editor reports unavailable rather than pretending to save.

### Administrator password

Comment management stays at `/blog/comment/`; document editing uses its `exit/` address. Both use account `admin` and the **same existing password value** (`ADMIN_TOKEN`). Standard `username`/`current-password` form fields and a successful-login credential request let Chrome offer to save/autofill it. Browser settings and password-manager policy decide whether a prompt appears. The browser manages any saved password; this site never writes the password into cookies, localStorage, sessionStorage or URLs.

A successful password login exchanges it for a random, revocable session with a **30-day absolute expiry**. The same-origin comment and editor pages share only this session token and expiry in localStorage; reopening or refreshing a page validates the session before loading administrative data. The expiry does not slide on use. D1 stores only a token HMAC keyed by the current `ADMIN_TOKEN`, plus creation/expiry times. The raw password and raw session token do not enter D1.

Leaving a page clears its in-memory state while retaining the saved session. Explicit logout clears local access and requests server revocation, with other open pages responding to the storage change. A network failure is reported as a local logout with remote revocation unconfirmed. Expiry or a logout in another tab clears comment data but preserves an editor's unsaved text in memory; signing in again retains that draft and its original base SHA for conflict checking. Drafts are never persisted in browser storage. A browser that denies localStorage can still use the current page, but cannot keep the session across visits.

The encrypted Windows backup is outside the repository at `%USERPROFILE%\.config\xht37-blog-api\admin-token.dpapi`. To reveal it privately in your own terminal:

```powershell
pwsh -NoProfile -File services/blog-api/scripts/admin-token.ps1 -Reveal
```

The helper without `-Reveal` only explains retrieval. Do not copy a real password, pending comment, credential/session file or database export into this repository, including ignored directories. The shared admin/editor pages have fixed API configuration, restrictive CSP, no referrer, `noindex` and an external-frame login guard.

### Cloudflare and editor configuration

Service routes, validation, frequency limits and credential handling are described in [services/blog-api/README.md](services/blog-api/README.md). Runtime comments require Cloudflare Workers + D1 and the existing `ADMIN_TOKEN`/`RATE_LIMIT_SALT` secrets. `wrangler.local.toml` contains the local binding, while committed `wrangler.toml` has no real database ID or secret. Keep `VISITS_ENABLED = "false"`.

The online editor additionally needs a fine-grained GitHub token, restricted to `pku-xht/pku-xht.github.io`: **Contents: read and write**, **Commit statuses: read**, plus GitHub's default **Metadata: read**. Store it as the Worker secret `GITHUB_EDIT_TOKEN`; it is never sent to the browser. This is separate from the administrator password. The trusted GitHub publication workflow's own token has only `contents: write`, `statuses: write` and `pages: write`. The workflow and publisher are `.github/workflows/publish-blog-edit.yml` and `tools/publish_blog_edit.py`; candidate branches cannot supply their workflow/code for privileged execution.

Wrangler authentication uses the previously approved account/user read, Worker script write and D1 write scopes, plus offline refresh. Only when reconnecting is necessary:

```sh
wrangler login --device --use-keyring --scopes account:read user:read workers_scripts:write d1:write
```

Use the machine's actual HTTP/HTTPS proxy when its CLI cannot reach the OAuth endpoint; exclude localhost with `NO_PROXY`. A browser dashboard login alone does not establish CLI authorization. Keep encrypted CLI credentials outside this repository.

### Authorized deployment order

These commands are a deployment procedure, not evidence that this local change is deployed. Run only with authorization covering the release. Apply additive schema before deploying code that reads it. The 30-day-session upgrade requires `0003_admin_sessions.sql` before the new Worker, followed by the generated pages. Existing deployments retain their secrets and imported comments; they do not need a new GitHub secret or another import solely for this upgrade. The complete setup procedure is:

```sh
wrangler d1 migrations apply <database-name> --remote --config services/blog-api/wrangler.local.toml
wrangler d1 execute <database-name> --remote --config services/blog-api/wrangler.local.toml --file services/blog-api/data/register-public.sql
wrangler d1 execute <database-name> --remote --config services/blog-api/wrangler.local.toml --file services/blog-api/data/unified-comments.sql
wrangler secret put GITHUB_EDIT_TOKEN --config services/blog-api/wrangler.local.toml
wrangler deploy --config services/blog-api/wrangler.local.toml
```

Enter the GitHub secret interactively or through a private stdin pipe; never put its value in command arguments or repository files. Preserve the existing `ADMIN_TOKEN` and `RATE_LIMIT_SALT`. If setting up a new service, create those two Worker secrets separately through the same secret input mechanism.

Read back public-import counts, hashes and foreign-key checks without exporting pending data; verify the actual Worker, CORS and unified public/admin behavior. Then push the checked static site and trusted workflow to `main` under the same release authorization, verify the matching Pages revision and assets, and finally test the authorized online-save flow. Do not report local tests, a candidate commit, or a main commit as a successful Pages publication.

### Remote smoke check

Only in an authorized test-write window, the remote smoke script can create fictional comments, temporarily approve one and clean up its own exact records. It requires both an environment password and the explicit write flag:

```powershell
$env:BLOG_ADMIN_TOKEN = & services/blog-api/scripts/admin-token.ps1 -Reveal
try {
    node services/blog-api/scripts/smoke-remote.mjs --api https://xht37-blog-api.pku-xht-github-io.workers.dev --confirm-test-writes
} finally {
    Remove-Item Env:BLOG_ADMIN_TOKEN -ErrorAction SilentlyContinue
}
```

Cleanup deletes only a leaf through the server's atomic `only_if_no_replies=true` condition; a real reply blocks removal and the script reports its UUID. It does not export pending content or print the password. Exact CORS, approval isolation, same-document replies and disabled Visits need actual service verification, separate from SQLite tests.

### Future Visits cutover

Visits remains disabled in both frontend and Worker: no UI, requests, baseline import or counting is enabled by this work. At the later authorized cutover, collect fresh per-document counts and the old site's **independent total**, record the capture window and import an exact complete baseline. Never infer the total by adding article counts or reuse an old archive as the fresh baseline.

The personal homepage has a hidden bilingual **全站访问量 / Site views** footer widget. It shares the blog's Visits client and the configuration generated from `features.yaml`; ordinary article edits do not change the homepage. The generated configuration's content hash versions its homepage script URL, so switching configuration also refreshes that asset's cache. The article publisher still rejects changes to root `index.html`.

When enabled and seeded, one reading-page load adds one site PV; a document page also adds one document PV. The personal homepage sends no document ID. Refreshing counts as another view; language changes and retries within the same load do not. These are page views, not unique visitors. Disabled configuration sends no API requests; missing baselines or failed requests keep the counter hidden rather than showing a false zero. Management and editor pages do not count views.

The requested domain mapping is `xht37.com/` and `www.xht37.com/` to `https://pku-xht.github.io/blog/`, with public document links redirected to their corresponding routes and WordPress administration/private pages retained. The user accepts a small cutover counting discrepancy. DNS access, redirect readiness, fresh baseline capture/import and actual enablement remain separate steps; current preparation and the unresolved DNS approach are recorded in [the cutover preparation](migration/domain-visits-2026-10-31.md).

Validate a privately stored baseline offline first:

```sh
node services/blog-api/scripts/import-baseline.mjs --input <verified-private-baseline.json> --batch <cutover-batch>
```

The default is a zero-network dry run. Actual application additionally requires process `BLOG_ADMIN_TOKEN`, `--apply --confirm-cutover --api <Worker-origin>`, and a separately authorized enablement of both switches. The backend imports the independent site and complete document bases atomically, refuses a differing overwrite and counts each event nonce once.

### Original-site import tools

The initial, authorized imports are already complete. They are not daily build commands and must not overwrite maintained files:

```sh
python -S -u -X utf8 tools/sync_public_blog.py --checked-on 2026-10-23
python -S -X utf8 tools/import_blog_markdown.py
python -S -X utf8 tools/sync_public_comments.py --checked-on 2026-10-25
python -S -X utf8 tools/sync_blog_friends.py --checked-on 2026-10-25
```

The public source sync uses anonymous requests, registered document IDs and explicit public visibility checks. It does not log into WordPress. The Markdown importer refuses existing sources; use a separate output root to review any separately authorized future batch. Public comment importers accept only approved display fields, never backend exports or private author data. The 212-document audit found exactly the 117 preserved public comment IDs. Hidden content, old-site redirects and old-site shutdown remain outside this work.
