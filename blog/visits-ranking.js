(() => {
  "use strict";

  function initialize() {
    const section = document.querySelector("[data-visits-ranking]");
    if (!section || section.dataset.rankingInitialized === "true") return;
    section.dataset.rankingInitialized = "true";
    if (section.dataset.rankingEnabled !== "true" || !section.dataset.blogApi) return;
    const list = section.querySelector("[data-ranking-list]");
    const status = section.querySelector("[data-ranking-status]");
    const retry = section.querySelector("[data-ranking-retry]");
    if (!list || !status || !retry) return;

    let api;
    try {
      const base = new URL(section.dataset.blogApi, window.location.href);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) return;
      base.pathname = base.pathname.replace(/\/+$/u, "") + "/";
      api = new URL("v1/visits/ranking", base);
    } catch { return; }

    // Use maintained titles and routes from this page, including online edits.
    const articles = new Map();
    for (const link of document.querySelectorAll(".post-card h2 a")) {
      const match = /^\/blog\/posts\/([1-9][0-9]*)\/$/u.exec(link.getAttribute("href") || "");
      const title = link.textContent.trim();
      if (match && title) articles.set(match[1], { title, path: match[0] });
    }
    let loading = false;
    let complete = false;

    function rows(data) {
      if (!data || data.enabled !== true || data.seeded !== true || !Array.isArray(data.items) || data.items.length > 10) throw new Error("Ranking unavailable");
      const seen = new Set();
      let previous = null;
      return data.items.map((item, index) => {
        if (!item || typeof item.document !== "string" || !articles.has(item.document) || seen.has(item.document) || !Number.isSafeInteger(item.visits) || item.visits < 0) throw new Error("Invalid ranking");
        if (previous && (item.visits > previous.visits || (item.visits === previous.visits && Number(item.document) < Number(previous.document)))) throw new Error("Invalid ranking order");
        previous = item;
        seen.add(item.document);
        const article = articles.get(item.document);
        const row = document.createElement("li");
        const link = document.createElement("a");
        link.className = "ranking-link";
        link.href = article.path;
        const rank = document.createElement("span");
        rank.className = "ranking-position";
        rank.setAttribute("aria-hidden", "true");
        rank.textContent = String(index + 1).padStart(2, "0");
        const title = document.createElement("span");
        title.className = "ranking-title";
        title.textContent = article.title;
        const count = document.createElement("span");
        count.className = "ranking-views";
        count.textContent = item.visits.toLocaleString("zh-CN");
        count.setAttribute("aria-label", count.textContent + " 次访问");
        link.appendChild(rank);
        link.appendChild(title);
        link.appendChild(count);
        row.appendChild(link);
        return row;
      });
    }

    async function load() {
      if (loading || complete) return;
      loading = true;
      retry.disabled = true;
      retry.hidden = true;
      status.hidden = false;
      status.textContent = "正在加载排行…";
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(api, { credentials: "omit", cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
        if (!response.ok) throw new Error("Ranking request failed");
        const entries = rows(await response.json());
        list.replaceChildren(...entries);
        list.hidden = entries.length === 0;
        status.hidden = entries.length > 0;
        status.textContent = entries.length ? "" : "暂无可排行的文章。";
        section.dataset.rankingState = "ready";
        complete = true;
      } catch {
        list.replaceChildren();
        list.hidden = true;
        status.textContent = "暂时无法加载访问量排行。";
        retry.hidden = false;
        section.dataset.rankingState = "error";
      } finally {
        window.clearTimeout(timeout);
        retry.disabled = false;
        loading = false;
      }
    }

    retry.addEventListener("click", load);
    load();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
