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

The owner selected **C · personal blog**: warm paper, serif headings, excerpt lists and single-column articles with collapsible contents. The first batch contains all 29 public notes. [design/README.md](design/README.md) retains the earlier alternatives as design history; they are not linked from the homepage.

### Blog sources and generation

- `migration/sources/notes-2026-10-23.json`: checked anonymous public source snapshot, with original HTML, dates and content hashes. It contains no authenticated exports.
- `migration/sources/media.json`: original image URLs and hashes; files live in `blog/media/`.
- `migration/sources/note-summaries.json`: explicit list-excerpt overrides; these do not modify article bodies.
- `tools/build_blog.py` and `tools/render_math.cjs`: offline generation of `blog/index.html`, `blog/archive/index.html`, and `blog/posts/<WordPress-ID>/index.html`.
- `blog/blog.css` and `blog/blog.js`: the selected layout, title/excerpt search and code-copy enhancement. Articles and archive remain readable without JavaScript.
- `migration/notes-batch1.json`: generated URL mapping and per-article counts; publication state is local-only until deployment is explicitly performed and checked.

Regenerate from the approved snapshot using Python 3.9+ and Node.js (verified with Python 3.9.13 and Node 24.6.0):

```sh
python -S -X utf8 tools/build_blog.py
python -S -X utf8 tools/check_blog.py
node --check blog/blog.js
```

No network or package installation is used by these commands. Edit the source snapshot or summary metadata, then regenerate; direct edits to generated article HTML will be overwritten. A new migration batch must first retain the source site's public/private boundary and the confirmed batch scope.

The generator preserves body text, code, images and original dates, removes the injected old visit counter, normalizes heading levels, creates contents links, and redirects links between migrated articles to their new local pages. Contents entries always link to local headings, including headings whose body text contains an external link. TeX rendering only adapts WordPress en dashes to minus signs and the old literal XOR caret spelling; the unmodified TeX remains in `data-original-math` for comparison. `check_blog.py` independently restores that TeX and compares all article text, code, tables, images, dates, local links and font paths with the snapshot, and checks every contents label and heading target.

Generated post HTML retains the original code's trailing spaces. Its scoped Git whitespace attribute permits those bytes; the independent code comparison still checks them exactly.

The homepage's Blog navigation label is bilingual; the migrated Chinese articles are not automatically translated. Old-site redirects, comments and private content are outside this batch.
