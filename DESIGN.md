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

The index presents date-ordered article excerpts with publication dates, category, and modification date when its day differs. Search filters titles, excerpts, categories and tags. The archive groups all articles by year. The four categories are 笔记, 题解, 游记 and 记录. Compact category links lead to static excerpt lists using the same design; the unselected B prototype's inferred topic groups are not used. The site treats its 211 articles and page `215` as one public collection, with no migration badges, old/new labels or separate historical-page section. The navigation's single `旧站 ↗` link is the only source-site entrance.

Articles retain the complete Chinese body. A collapsible contents block uses the heading hierarchy normalized to start at level two; it starts closed for more than ten headings. Article formula HTML and MathML are rendered in advance, with local font files. Images, including the animated GIF, are local copies. Code blocks, long formulas and tables scroll within their own width. Copy buttons and search enhance the static HTML; article reading needs no JavaScript. Discussion is loaded separately from the API and requires JavaScript.

Each article links to its newer/older neighbors and retains clickable tags. There is no per-article source note. URLs remain `/blog/posts/<ID>/` and `/blog/pages/<ID>/`; page `215` uses ordinary reading and editing controls. Public dates, complete body, code, formulas and resources remain intact. The homepage includes a bilingual `navBlog` label and a Chinese HTML fallback and remains the separately maintained source of current academic information.

The blog navigation also links to a tag cloud and friend-link list. The 91 used tags have static excerpt pages at `/blog/tags/<tag-ID>/`; their sizes reflect actual article counts. The blog index offers the cloud in a compact collapsed disclosure, while `/blog/tags/` shows it in full. `/blog/friends/` retains the 25 names, URLs and order in a restrained list, with no source labels, sidebar, popularity ranking or random recommendations.

All comments appear below the article as one API-backed thread, retaining nicknames, timestamps, links, code and formulas; reply indentation stops growing after three visual levels. D1 is the single runtime source for both imported and subsequently submitted comments, with one set of public, pending and rejected states and one moderation interface. Preserved public YAML/JSON serves only import verification and cannot restore a deleted or rejected comment. There is no static discussion fallback that could reveal a record after moderation. The UI has no old/new comment labels. Dynamic safe HTML is reconstructed through a DOM allowlist; comment TeX uses local KaTeX with `trust:false`.

Readers enter a nickname and body, and new submissions become public only after owner approval. A pending submission shows its state without appearing in the public thread or increasing its count. Loading, unavailable, retry and empty states refer to the entire discussion. Visits has a separate disabled switch: no count or tracking request appears until a future cutover is explicitly enabled and fresh per-document and independent site-wide baselines are verified.

The owner's moderation page lives at `/blog/comment/`. It shares `admin-style.mjs` with the article editor: the blog's paper background, blue links and primary actions, Chinese serif headings, restrained dividers and compact navigation. The list defaults to all comments, with pending/public/rejected filters, status counts, article-title links, per-article selection and database-wide nickname/body search. Rows show the nickname, full time, parent reference and status; moderation refreshes the view including affected descendants. Pagination loads at most 100 more comments at a time. It stays outside public navigation, declares `noindex`, and shares its source and client with the Worker page.

Appending `exit` to any registered article or page URL opens its editor, for example `/blog/posts/1154/exit/`. Its shared paper background, blue primary action, restrained typography and narrow-screen layout continue C; the editing area uses a readable monospace font and preserves whitespace. A full Markdown/YAML editor offers save, reload, logout and return-to-article controls. Unsaved changes remain on a failed save or expired session, and reload/logout checks before discarding them. Save, candidate accepted, building, failure and verified publication are distinct visible states.

Both administrative surfaces use the fixed account `admin` and unchanged administrator password, through ordinary username/password fields with browser autocomplete hints. Successful login can ask Chrome to store the password; browser settings decide whether to offer saving/autofill. The website stores only a revocable session and its 30-day absolute expiry in same-origin localStorage, shared by all management/editor pages. The original password and draft text remain outside website storage. Reopening validates the session, leaving clears page memory, and explicit logout revokes the session and updates other open pages. An editor retains unsaved text after expiry or a peer logout, then reauthenticates without silently rebasing its source SHA. Administrative documents contain only empty interfaces and fixed backend configuration, never actual passwords or private data. The online editor preserves Markdown/YAML as the single formal article source; its trusted workflow publishes source and generated pages together, then verifies the matching Pages build. This implementation's release and verification state is maintained in the migration records, not inferred from this design contract.
