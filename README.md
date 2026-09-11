# 徐皓天 · Personal homepage

Single-page, bilingual personal website for [pku-xht.github.io](https://pku-xht.github.io/).

## Local preview

Run a static server from this directory, for example:

```sh
python -m http.server 8789 --bind 127.0.0.1
```

Open `http://127.0.0.1:8789/`. No package installation or build step is required.

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

The website uses no analytics, external font requests or third-party JavaScript.
