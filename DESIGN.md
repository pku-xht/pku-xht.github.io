# Personal homepage direction

## Visual thesis
A compact, contemporary personal introduction: paper-white space, a modest name heading, readable text, one clear blue accent, and closely spaced academic records.

## Content plan
1. A compact personal greeting and a short, factual identity line, followed by the primary link; leave room for actual records within the first screen.
2. A concise introduction that gives the name context.
3. Education, internships, publications, teaching, and awards, displayed as compact records with dates.
4. Direct email and GitHub contact links.

The first release uses personal information confirmed by the owner. Optional sections with no real content are omitted from the public page. Author-facing instructions and draft fields stay in the documentation.

## Interaction thesis
- A short staggered entrance establishes the name and introduction.
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
- `[data-work-list]` renders verified `SITE_CONTENT.work` entries; hide `[data-work-section]` and `[data-work-nav]` when empty.
- `[data-interest-list]` renders verified `SITE_CONTENT.interests`; hide `[data-interest-section]` and `[data-interest-nav]` when empty.
- `[data-contact-list]` renders `SITE_CONTENT.contacts`; only allow safe `https:`, `http:`, and `mailto:` URLs.
- `[data-year]` shows the current year.
- `.reveal` marks below-the-fold elements for an optional, accessible entrance animation.

## Release status
The initial public content is confirmed, including English terminology and contact links. The compact bilingual layout has been checked at desktop, tablet, and mobile widths. GitHub Pages serves this static site from the root of the `main` branch.
