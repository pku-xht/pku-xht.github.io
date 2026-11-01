const DAY = 86400000;
const count = value => Number.isSafeInteger(value) && value >= 0;
export function chinaDate(instant) { return new Date(Date.parse(instant) + 8 * 3600000).toISOString().slice(0, 10); }
export function dateNumber(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const n = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === date ? n : NaN;
}
export function validateHistory(value) {
  const keys = ['captured_at','cutover_date','first_date','items','site_base','timezone'];
  if (!value || Object.keys(value).sort().join(',') !== keys.join(',')) throw new Error('Invalid history fields.');
  if (value.timezone !== 'Asia/Shanghai' || !count(value.site_base) || typeof value.captured_at !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value.captured_at) || !Number.isFinite(Date.parse(value.captured_at))) throw new Error('Invalid history metadata.');
  const first = dateNumber(value.first_date), end = dateNumber(value.cutover_date);
  if (!Number.isFinite(first) || !Number.isFinite(end) || first > end || (end-first)/DAY >= 20000 || chinaDate(value.captured_at) !== value.cutover_date || !Array.isArray(value.items) || value.items.length !== (end-first)/DAY+1) throw new Error('Invalid history dates.');
  let sum = 0;
  const items = value.items.map((row, i) => {
    if (!row || Object.keys(row).sort().join(',') !== 'date,partial,visits' || dateNumber(row.date) !== first+i*DAY || !(row.visits === null || count(row.visits)) || typeof row.partial !== 'boolean') throw new Error('Invalid history item.');
    sum += row.visits ?? 0;
    if (!Number.isSafeInteger(sum)) throw new Error('History sum is too large.');
    return {date:row.date,visits:row.visits,partial:row.partial};
  });
  if (sum !== value.site_base || !items.at(-1).partial) throw new Error('History total or cutover partial flag is invalid.');
  return {timezone:value.timezone,captured_at:value.captured_at,site_base:value.site_base,first_date:value.first_date,cutover_date:value.cutover_date,items};
}
