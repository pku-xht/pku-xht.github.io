# Personal homepage direction

## Visual thesis
The approved A direction is a compact academic page: white paper, dark blue-gray text, restrained blue links, a 30px name, and a single 960px text column. Its typography draws on al-folio, and its publication-first hierarchy draws on Jon Barron's homepage.

The approved personal mark is a calligraphic capital X in the site's blue (`#2b5f9e`), with a broad curved downstroke, a fine crossing stroke, and looping terminals. `assets/x-script-mark.svg` is the transparent master; `assets/x-script-icon.svg` strengthens the fine stroke for small sizes. The favicon uses that approved icon, with a versioned URL for browser cache refresh. Earlier geometric designs remain as archived candidates.

## Content plan
1. A small name heading with its alternate-language name alongside, followed by identity, advisor, and a brief biography.
2. Publications, then education, internships, teaching, and awards. Each heading sits above its records. Desktop dates align on the right; mobile dates follow the record text.
3. Each publication shows its title, authors, and an inline row for venue, acceptance status, paper, and code. Typography uses 15px body text, 17px section headings, 13px secondary text, and 12px dates. Sections use 14px vertical padding and records use 10px total separation. At mobile widths the name is 28px and record details stack naturally.
4. A simple Contact heading followed directly by email and GitHub links on one compact line. The personal GitHub link appears only here, at the end of the page.

The first release uses personal information confirmed by the owner. Optional sections with no real content are omitted from the public page. Author-facing instructions and draft fields stay in the documentation.

## Interaction thesis
- Six compact navigation anchors provide direct access to the page sections.
- Gentle section reveals help the reader follow the page while scrolling.
- Link underlines and the language selector respond clearly to focus and hover.
- All animation respects reduced-motion preferences.

## Implementation
- Dependency-free HTML, CSS, and JavaScript, published from the repository root with GitHub Pages.
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
