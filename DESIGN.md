# Personal homepage direction

## Visual thesis
The approved A direction is a compact academic page: white paper, dark blue-gray text, restrained blue links, a 30px name, and a single 960px text column. Its typography draws on al-folio, and its publication-first hierarchy draws on Jon Barron's homepage.

The approved personal mark is a calligraphic capital X in the site's blue (`#2b5f9e`), with a broad curved downstroke, a fine crossing stroke, and looping terminals. `assets/x-script-mark.svg` is the transparent master; `assets/x-script-icon.svg` strengthens the fine stroke for small sizes. The favicon uses that approved icon, with a versioned URL for browser cache refresh. Earlier geometric designs remain as archived candidates.

## Content plan
1. A small name heading with its alternate-language name alongside, followed by identity, advisor, and a brief biography.
2. Publications, then education, internships, teaching, and awards. Each heading sits above its records. Desktop dates align on the right; mobile dates follow the record text.
3. Each publication shows its title, authors, and an inline row for venue, acceptance status, paper, and code. Typography uses 15px body text, 17px section headings, 13px secondary text, and 12px dates. Sections use 14px vertical padding and records use 10px total separation. At mobile widths the name is 28px and record details stack naturally.
4. A simple Contact heading followed directly by email and GitHub links on one compact line. The personal GitHub link appears only here, at the end of the page.

Within ordinary records, keep the leading institution or course name at 15px / 600. All following descriptions, separators, resource links, report text, and author excerpts use 13px / 400, with the owner's name emphasized at 600 without changing its size. Resource links inherit their row's type size: 13px in ordinary records and 12px in publication metadata. Dates remain a separate 12px auxiliary layer. All content shares the global font stack.

The first release uses personal information confirmed by the owner. Optional sections with no real content are omitted from the public page. Author-facing instructions and draft fields stay in the documentation.

## Interaction thesis
- The compact header groups the six in-page section links. A separate Blog link with a ↗ icon sits at the far right, on the same row as those links. On narrow screens the name and language selector form the top row; section links and Blog share the row below, with Blog aligned to the first line if the section links wrap.
- Gentle section reveals help the reader follow the page while scrolling.
- Link underlines and the language selector respond clearly to focus and hover.
- All animation respects reduced-motion preferences.

## Implementation
- Static HTML, CSS, and JavaScript, published from the repository root with GitHub Pages. The homepage is hand-maintained; the blog builds from maintained Markdown/YAML as documented in `README.md`, retaining the existing C layout and ID-based URLs.
- `content.js` contains bilingual personal content. Optional empty arrays remain hidden.
- `site.js` renders content safely as text, handles navigation and language selection, and updates the document language and metadata.
- On first visit, use the browser's preferred supported language; remember an explicit language choice. Support `?lang=zh` and `?lang=en` links.
- Chinese works without JavaScript as a basic readable fallback.
- No invented education, jobs, personal projects, contact methods, or biographical claims.

## DOM contract
- `data-i18n` keys correspond to `SITE_CONTENT.ui[language]` strings; optional HTML is not accepted.
- `[data-lang]` buttons select `zh` or `en` and expose `aria-pressed` state.
- `[data-profile-name]`, `[data-profile-intro]`, `[data-profile-about]` show profile strings from `SITE_CONTENT.profile`, falling back to `pku-xht` and a factual greeting.
- `[data-profile-alternate]` shows the other name with its matching `lang` attribute. `#top`, `#about`, and `#main` remain valid navigation targets.
- Generic `.record-item` elements contain `.record-copy` followed by `.record-period`. CSS places dates on the right on desktop and after the text on mobile.
- Each ordinary record uses one `.record-line` paragraph with a bold title, inline detail spans, and real text separators, so selecting and copying a visually continuous line preserves its text and separators. Education details and teaching descriptions remain inline at all widths and wrap naturally.
- Publication metadata lives in `.publication-meta`, retaining `.record-period`, `.record-description`, and `.record-links` selectors.
- `[data-work-list]` renders verified `SITE_CONTENT.work` entries; hide `[data-work-section]` and `[data-work-nav]` when empty.
- `[data-interest-list]` renders verified `SITE_CONTENT.interests`; hide `[data-interest-section]` and `[data-interest-nav]` when empty.
- `[data-contact-list]` renders `SITE_CONTENT.contacts`; only allow safe `https:`, `http:`, and `mailto:` URLs.
- `[data-year]` shows the current year.
- `.reveal` marks below-the-fold elements for an optional, accessible entrance animation.

## Design references
- [al-folio](https://alshedivat.github.io/al-folio/): restrained academic typography and clear section hierarchy.
- [Jon Barron](https://jonbarron.info/): compact publication entries and readable author/resource lines.

The final layout uses its own HTML and CSS. The reference sites inform the hierarchy rather than supplying copied code or personal content. GitHub Pages serves this static site from the root of the `main` branch.

## Blog: selected C direction

The owner selected C · personal blog on 2026-10-23. The homepage retains the academic layout above. The blog has its own warm paper (`#fcfbf8`), dark gray-green text, the existing blue links, serif Chinese titles, a maximum 800px page width and 760px article width. Body text is 16px with 1.9 line height. Index and article headings are 34px and 32px; phone layouts reduce them while retaining readable body text.

The index presents date-ordered article excerpts with original publication dates, category, and original modification date when its day differs. Search filters titles, excerpts, original categories and original tags. The archive groups all migrated articles by original year. The full migration has four nonempty original categories: 笔记, 题解, 游记 and 记录. Compact category links lead to static excerpt lists using the same design; the unselected B prototype's inferred topic groups are not used.

Articles retain the complete Chinese body. A collapsible contents block uses the original heading hierarchy normalized to start at level two; it starts closed for more than ten headings. Formula HTML and MathML are rendered in advance, with local font files. Images, including the animated GIF, are local copies. Code blocks, long formulas and tables scroll within their own width. Copy buttons and search enhance the static HTML; basic reading needs no JavaScript.

Each article links to its old source and its newer/older migrated neighbors, and retains clickable original tags near its source note. URLs use `/blog/posts/<original WordPress ID>/`. Independent old-site pages use `/blog/pages/<original WordPress ID>/`, with a visible historical-content note and a link to the current personal homepage. The blog index and archive provide a separate historical-page entrance. The homepage includes a bilingual `navBlog` label and a Chinese HTML fallback.

The blog navigation also links to a tag cloud and the original friend-link list. The 91 used tags have static excerpt pages at `/blog/tags/<tag-ID>/`; their sizes reflect actual article counts. The homepage offers the cloud in a compact collapsed disclosure, while `/blog/tags/` shows it in full. `/blog/friends/` retains the original 25 names, URLs and order in a restrained list, with no sidebar, popularity ranking or random recommendations.

Historical public discussions appear below each article as readable static threads, retaining nicknames, timestamps, code and formulas; reply indentation stops growing after three visual levels. New comments use the same restrained typography, require an explicitly entered nickname and body, and become public only after the owner approves them. A pending submission shows its state without appearing in the public thread. The writable service is separate from the static site. Visits has a separate disabled switch: no count or tracking request appears until the future cutover is explicitly enabled and its original per-document and independent site-wide baselines are verified.

The owner's moderation page lives at `/blog/comment/`, with the same paper background, compact form and readable narrow-screen layout. It stays outside public navigation, declares `noindex`, and uses the existing administrator password. Its source and client are shared with the Worker management page. Passwords and review data stay in page memory and are cleared when leaving; the static document contains an empty interface and a fixed backend address.
