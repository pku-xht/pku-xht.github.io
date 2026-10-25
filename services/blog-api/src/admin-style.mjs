/** Shared visual language for the blog's comment and article workspaces. */
export const ADMIN_STYLE = `
:root {
  color-scheme: light;
  --paper: #fcfbf8;
  --ink: #323735;
  --muted: #626c67;
  --blue: #2b5f9e;
  --line: #dfe2da;
  --soft: #f0f1eb;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --serif: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "STSong", "SimSun", serif;
  --mono: Consolas, "SFMono-Regular", "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
html { background: var(--paper); }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.85 var(--sans); }
[hidden] { display: none !important; }
a { color: var(--blue); text-decoration: none; text-underline-offset: .2em; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--blue); outline-offset: 4px; }
button, input, select, textarea { font: inherit; color: inherit; max-width: 100%; }
button { cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button, .button-link { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 8px 16px; border: 1px solid #cbd1c8; border-radius: 4px; background: transparent; color: var(--ink); font-size: 13px; line-height: 1.7; text-decoration: none; }
button:hover:not(:disabled), .button-link:hover { border-color: #9ea99b; background: var(--soft); text-decoration: none; }
button.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
button.primary:hover:not(:disabled) { background: #224f86; border-color: #224f86; }
button.quiet { border-color: transparent; color: var(--muted); }
button.danger, .comment-actions button:last-child { color: #93483d; }
input, select { min-height: 44px; padding: 9px 12px; border: 1px solid #cbd1c8; border-radius: 4px; background: transparent; font-size: 14px; line-height: 1.65; }
input::placeholder { color: var(--muted); opacity: .9; }
input[readonly] { color: var(--muted); background: #f4f4ee; }
label { display: block; min-width: 0; color: var(--muted); font-size: 13px; }
label > input, label > select { display: block; width: 100%; margin-top: 7px; }
.admin-width { width: min(900px, calc(100% - 48px)); margin-inline: auto; }
.admin-header > .admin-width { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 78px; border-bottom: 1px solid var(--line); }
.identity { display: inline-flex; flex-shrink: 0; align-items: baseline; gap: 7px; color: var(--ink); font-size: 16px; font-weight: 600; line-height: 1.5; }
.identity-note { color: var(--muted); font-weight: 400; }
.admin-nav { display: flex; align-items: center; gap: 22px; font-size: 13px; line-height: 1.6; }
.admin-nav a { display: inline-flex; align-items: center; min-height: 44px; color: var(--muted); white-space: nowrap; }
.admin-nav a[aria-current="page"] { color: var(--ink); text-decoration: underline; text-decoration-color: var(--blue); text-underline-offset: 6px; }
main.admin-width { min-width: 0; min-height: calc(100vh - 170px); padding-bottom: 48px; }
.page-intro { padding: 39px 0 25px; }
.eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .14em; line-height: 1.8; }
h1 { margin: 0; font: 600 32px/1.5 var(--serif); letter-spacing: -.02em; overflow-wrap: anywhere; }
.page-intro > p:last-child { margin: 10px 0 0; color: var(--muted); font-size: 14px; }
.login-panel { width: min(100%, 450px); margin: 5px 0 28px; padding: 25px 0 29px; border-block: 1px solid var(--line); }
.login-heading { margin: 0 0 18px; font: 600 21px/1.6 var(--serif); }
.login-panel label { margin: 0 0 17px; }
.login-panel button { min-width: 116px; margin-top: 4px; }
.form-note { margin: 14px 0 0; color: var(--muted); font-size: 12px; line-height: 1.85; }
.management-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px 20px; padding: 0 0 17px; }
#management { margin-top: 24px; }
#summary { margin: 0; color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.management-actions, .comment-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.management-actions button { min-height: 36px; padding: 5px 12px; }
.comment-filters { display: grid; grid-template-columns: 148px minmax(170px, 1fr) minmax(180px, 1.1fr); align-items: end; gap: 16px; padding: 19px 0 22px; border-block: 1px solid var(--line); }
#loaded-count { margin: 15px 0; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
#comments { min-width: 0; }
#comments > article, .comment-card { padding: 23px 0 24px; border-bottom: 1px solid var(--line); }
#comments > article:first-child { border-top: 1px solid var(--line); }
.comment-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
#comments h2 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.7; overflow-wrap: anywhere; }
.comment-meta, #comments small { display: block; margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.9; overflow-wrap: anywhere; }
.comment-meta a { color: var(--muted); text-decoration: underline; text-decoration-color: #c8d2df; }
.comment-meta { display: flex; flex-wrap: wrap; gap: 3px 12px; }
#comments pre, .comment-body { margin: 15px 0 18px; color: var(--ink); font: 14px/1.95 var(--sans); white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-actions button { min-height: 34px; padding: 5px 11px; font-size: 12px; }
.status-badge { display: inline-flex; flex: none; align-items: center; padding: 2px 8px; border: 1px solid var(--line); border-radius: 3px; color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1.8; white-space: nowrap; }
.status-badge[data-state="pending"], .status-pending { color: #856017; border-color: #ded3ac; background: #f7f2e5; }
.status-badge[data-state="approved"], .status-approved { color: #4e6952; border-color: #ced8ca; background: #edf2e9; }
.status-badge[data-state="rejected"], .status-rejected { color: #786960; border-color: #ddd3ca; background: #f3eee9; }
#empty-state { margin: 23px 0; padding: 32px 20px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); font-size: 14px; text-align: center; }
.pagination { margin-top: 24px; text-align: center; }
#more { min-width: 150px; }
#message { min-height: 1.85em; margin: 16px 0 0; color: var(--muted); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.admin-footer { padding: 18px 0 26px; color: var(--muted); font-size: 11px; }
.admin-footer > .admin-width { padding-top: 15px; border-top: 1px solid var(--line); }
.editor-page .admin-width { width: min(1040px, calc(100% - 48px)); }
.editor-page .page-intro { padding-bottom: 18px; }
.editor-page h1 { max-width: 900px; font-size: 29px; }
.editor-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; margin: 13px 0 0; padding: 17px 0; border-block: 1px solid var(--line); }
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
.editor-toolbar .quiet { margin-left: auto; }
.editor-status { display: flex; align-items: baseline; flex-wrap: wrap; justify-content: space-between; gap: 4px 20px; min-height: 25px; margin: 15px 0 19px; color: var(--muted); font-size: 12px; }
#revision { overflow-wrap: anywhere; }
.editor-label { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 4px 20px; }
#source-label { color: var(--ink); font-size: 13px; font-weight: 500; }
.editor-label > span { color: var(--muted); font-size: 11px; }
.editor-hint { margin: 5px 0 10px; color: var(--muted); font-size: 12px; }
#source { display: block; width: 100%; min-height: 58vh; margin-top: 8px; padding: 19px 21px; border: 1px solid #cbd1c8; border-radius: 4px; background: #fffefa; color: var(--ink); font: 14px/1.85 var(--mono); white-space: pre; overflow: auto; resize: vertical; tab-size: 2; }
#source[readonly] { background: #f5f5ef; }
.muted { color: var(--muted); font-size: 13px; }
@media (max-width: 680px) {
  .comment-filters { grid-template-columns: minmax(100px, .8fr) minmax(0, 1.2fr); gap: 14px; }
  .filter-search { grid-column: 1 / -1; }
  .management-heading { align-items: flex-start; }
}
@media (max-width: 480px) {
  .admin-width, .editor-page .admin-width { width: calc(100% - 36px); }
  .admin-header > .admin-width { min-height: 70px; gap: 12px; }
  .identity { gap: 5px; font-size: 14px; }
  .admin-nav { gap: 15px; font-size: 12px; }
  .page-intro { padding: 29px 0 21px; }
  h1, .editor-page h1 { font-size: 25px; }
  .login-panel { padding-top: 22px; }
  .comment-filters { gap: 13px; padding-top: 16px; }
  .management-heading { display: block; }
  .management-actions { justify-content: flex-end; margin-top: 12px; }
  .comment-header { align-items: flex-start; }
  .comment-actions button { min-height: 42px; }
  #comments h2 { font-size: 15px; }
  .editor-toolbar { align-items: flex-start; }
  .editor-toolbar .actions { width: 100%; }
  .editor-toolbar .primary { flex: 1; }
  .editor-toolbar .quiet { margin-left: 0; }
  #source { min-height: 60vh; padding: 13px; font-size: 13px; }
}
`;
