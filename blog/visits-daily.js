(() => {
  "use strict";
  function initialize() {
    const section = document.querySelector("[data-daily-visits]");
    if (!section || section.dataset.dailyInitialized === "true") return;
    section.dataset.dailyInitialized = "true";
    if (section.dataset.dailyEnabled !== "true" || !section.dataset.blogApi) return;
    const find = (name) => section.querySelector("[data-daily-" + name + "]");
    const summary = find("summary"), chart = find("chart"), detail = find("detail"), control = find("date-control"), slider = find("date"), caption = find("caption"), status = find("status"), retry = find("retry");
    const buttons = section.querySelectorAll("[data-daily-range]");
    if (!summary || !chart || !detail || !control || !slider || !caption || !status || !retry || buttons.length !== 3) return;
    let api;
    try {
      const base = new URL(section.dataset.blogApi, window.location.href);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
      base.pathname = base.pathname.replace(/\/+$/u, "") + "/";
      api = new URL("v1/visits/daily", base);
    } catch { status.textContent = "每日访问量暂时无法加载。"; return; }
    let range = "30", serial = 0, loading = false, current = null;
    const day = 86400000;
    function parseDate(value) {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error("Invalid date");
      const timestamp = Date.parse(value + "T00:00:00Z");
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error("Invalid date");
      return timestamp;
    }
    function validate(data) {
      if (!data || data.enabled !== true || data.seeded !== true || data.history_seeded !== true || data.timezone !== "Asia/Shanghai" || typeof data.as_of !== "string" || !Number.isFinite(Date.parse(data.as_of)) || !Array.isArray(data.items) || data.items.length > 20000) throw new Error("Unavailable");
      if (data.first_date !== null) parseDate(data.first_date);
      let previous = null;
      for (const item of data.items) {
        if (!item || typeof item.partial !== "boolean" || (item.visits !== null && (!Number.isSafeInteger(item.visits) || item.visits < 0))) throw new Error("Invalid count");
        const date = parseDate(item.date);
        if (previous !== null && date !== previous + day) throw new Error("Invalid sequence");
        previous = date;
      }
      if (data.items.length) {
        const today = new Date(Date.parse(data.as_of) + 8 * 3600000).toISOString().slice(0, 10);
        const first = parseDate(data.first_date), end = parseDate(today);
        const length = range === "all" ? 20000 : Number(range);
        const start = Math.max(first, end - (length - 1) * day);
        if (data.from !== data.items[0].date || data.to !== today || data.to !== data.items[data.items.length - 1].date || parseDate(data.from) !== start || data.items.length !== (end - start) / day + 1) throw new Error("Invalid bounds");
      } else if (data.from !== null || data.to !== null) throw new Error("Invalid empty bounds");
      return data;
    }
    function svgNode(tag, attrs, text) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function showDetail(index) {
      if (!current || !current.items.length) return;
      index = Math.max(0, Math.min(current.items.length - 1, index));
      const item = current.items[index];
      slider.value = String(index);
      const count = item.visits === null ? "暂无记录" : item.visits.toLocaleString("zh-CN") + " 次访问";
      const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(current.as_of));
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(current.as_of));
      const note = item.partial ? (item.date === today ? "（当日数据截至北京时间 " + time + "）" : "（当日数据不完整）") : "";
      detail.textContent = item.date + "：" + count + note;
      slider.setAttribute("aria-valuetext", detail.textContent);
    }
    function render(data) {
      current = data;
      const items = data.items, known = items.filter((item) => item.visits !== null);
      chart.replaceChildren();
      summary.hidden = true; chart.hidden = true; detail.hidden = true; control.hidden = true; caption.hidden = true;
      if (!items.length) {
        status.hidden = false; status.textContent = "该时间范围暂无每日访问记录。";
        return;
      }
      let total = 0n, max = 0;
      for (const item of known) { total += BigInt(item.visits); max = Math.max(max, item.visits); }
      const missing = items.length - known.length;
      summary.textContent = known.length ? "区间访问量 " + total.toLocaleString("zh-CN") + " · 最高日 " + max.toLocaleString("zh-CN") + " 次" + (missing ? " · " + missing + " 天暂无记录，未计入总量" : "") : "该时间范围暂无每日访问记录。";
      summary.hidden = false;
      caption.textContent = "按北京时间统计。" + (missing ? "记录缺失的日期显示为断线，并非零访问。" : "") + (known.length && max === 0 ? "该区间已记录的访问量均为零。" : "");
      caption.hidden = false;
      const svg = svgNode("svg", { viewBox: "0 0 760 260", role: "img", "aria-label": "每日访问量折线图；使用下方滑块查看每日详情" });
      const rough = (max || 1) / 4, unit = 10 ** Math.floor(Math.log10(rough));
      const step = [1, 2, 5, 10].map((value) => value * unit).find((value) => value >= rough);
      const left = 70, right = 742, top = 16, bottom = 220, scale = Math.max(4, step * 4);
      for (let i = 0; i <= 4; i++) {
        const y = bottom - (bottom - top) * i / 4;
        svg.appendChild(svgNode("line", { x1: left, y1: y, x2: right, y2: y, class: "daily-grid" }));
        svg.appendChild(svgNode("text", { x: left - 10, y: y + 4, "text-anchor": "end", class: "daily-axis-label" }, (scale * i / 4).toLocaleString("zh-CN", { notation: "compact", maximumFractionDigits: 1 })));
      }
      const xAt = (i) => items.length === 1 ? (left + right) / 2 : left + (right - left) * i / (items.length - 1);
      let path = "", segment = 0;
      const finishSegment = () => { if (segment === 1) path += " m-2,0 a2,2 0 1,0 4,0 a2,2 0 1,0 -4,0"; segment = 0; };
      items.forEach((item, i) => {
        if (item.visits === null) { finishSegment(); return; }
        const x = xAt(i), y = bottom - (bottom - top) * item.visits / scale;
        path += (segment ? " L" : " M") + x.toFixed(2) + "," + y.toFixed(2);
        segment++;
      });
      finishSegment();
      svg.appendChild(svgNode("path", { d: path, class: "daily-line" }));
      const ticks = Math.min(items.length, 5);
      for (let i = 0; i < ticks; i++) {
        const index = ticks === 1 ? 0 : Math.round(i * (items.length - 1) / (ticks - 1));
        const label = items.length <= 366 ? items[index].date.slice(5) : items[index].date.slice(0, 7);
        svg.appendChild(svgNode("text", { x: xAt(index), y: 245, "text-anchor": ticks === 1 ? "middle" : i === 0 ? "start" : i === ticks - 1 ? "end" : "middle", class: "daily-axis-label" }, label));
      }
      svg.addEventListener("pointermove", (event) => {
        const bounds = svg.getBoundingClientRect();
        if (!bounds.width) return;
        const x = (event.clientX - bounds.left) * 760 / bounds.width;
        showDetail(items.length === 1 ? 0 : Math.round((x - left) / (right - left) * (items.length - 1)));
      });
      chart.appendChild(svg); chart.hidden = false;
      slider.max = String(items.length - 1); slider.value = String(items.length - 1);
      control.hidden = false; detail.hidden = false; showDetail(items.length - 1);
      status.hidden = true; status.textContent = "";
    }
    async function load() {
      const request = ++serial;
      loading = true; retry.disabled = true; retry.hidden = true;
      status.hidden = false; status.textContent = "正在加载每日访问量…";
      for (const node of [summary, chart, detail, control, caption]) node.hidden = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      try {
        const url = new URL(api); url.searchParams.set("range", range);
        const response = await fetch(url, { credentials: "omit", cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error("Request failed");
        const data = validate(await response.json());
        if (request !== serial) return;
        render(data); section.dataset.dailyState = "ready";
      } catch {
        if (request !== serial) return;
        current = null; chart.replaceChildren();
        status.textContent = "每日访问量暂时无法加载。"; retry.hidden = false;
        section.dataset.dailyState = "error";
      } finally {
        window.clearTimeout(timeout);
        if (request === serial) { loading = false; retry.disabled = false; }
      }
    }
    for (const button of buttons) button.addEventListener("click", () => {
      const next = button.dataset.dailyRange;
      if (!["7", "30", "all"].includes(next) || next === range) return;
      range = next;
      for (const candidate of buttons) candidate.setAttribute("aria-pressed", String(candidate === button));
      load();
    });
    slider.addEventListener("input", () => showDetail(Number(slider.value)));
    retry.addEventListener("click", () => { if (!loading) load(); });
    load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
