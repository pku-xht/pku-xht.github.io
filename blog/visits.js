(() => {
  "use strict";

  function randomNonce() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    if (window.crypto && typeof window.crypto.getRandomValues === "function") return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return null;
  }

  function initialize() {
    const container = document.querySelector("[data-blog-visits]");
    if (!container || container.dataset.visitsInitialized === "true") return;
    container.dataset.visitsInitialized = "true";
    container.hidden = true;
    const config = window.SITE_VISITS_CONFIG || {};
    const enabled = container.dataset.visitsEnabled === undefined ? config.enabled === true : container.dataset.visitsEnabled === "true";
    const apiBase = container.dataset.visitsEnabled === undefined ? config.api_base : container.dataset.blogApi;
    if (!enabled || !apiBase) return;
    const documentId = container.dataset.documentId || "";
    if (documentId && !/^[1-9]\d*$/u.test(documentId)) return;
    const nonce = randomNonce();
    if (!nonce) return;
    let api;
    try {
      const base = new URL(apiBase, window.location.href);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) return;
      base.pathname = base.pathname.replace(/\/+$/u, "") + "/";
      api = new URL("v1/visits", base);
    } catch { return; }
    const siteCount = container.querySelector("[data-site-visits]");
    const documentCount = container.querySelector("[data-document-visits]");
    const documentWrapper = container.querySelector("[data-document-visits-wrapper]");
    const retry = document.querySelector("[data-visits-retry]");
    let loading = false;
    let complete = false;

    async function request(url, options = {}) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { credentials: "omit", cache: "no-store", ...options, signal: controller.signal });
        if (!response.ok) throw new Error("Visits request failed");
        return await response.json();
      } finally { window.clearTimeout(timeout); }
    }

    function usable(data) {
      return data && data.enabled === true && data.seeded === true && Number.isSafeInteger(data.site) && data.site >= 0 && (!documentId || (String(data.document_id) === documentId && Number.isSafeInteger(data.document) && data.document >= 0));
    }

    async function update() {
      if (loading || complete) return;
      loading = true;
      if (retry) retry.disabled = true;
      try {
        const url = new URL(api);
        if (documentId) url.searchParams.set("document", documentId);
        const available = await request(url, { headers: { Accept: "application/json" } });
        if (!usable(available)) {
          container.dataset.visitsState = available && available.enabled === true ? "unseeded" : "disabled";
          container.hidden = true;
          if (retry) retry.hidden = true;
          return;
        }
        const payload = { nonce };
        if (documentId) payload.document = documentId;
        const data = await request(api, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
        if (!usable(data)) throw new Error("Unexpected visits response");
        if (siteCount) siteCount.textContent = data.site.toLocaleString("zh-CN");
        if (documentCount && documentId) documentCount.textContent = data.document.toLocaleString("zh-CN");
        if (documentWrapper) documentWrapper.hidden = !documentId;
        container.dataset.visitsState = "ready";
        container.hidden = false;
        complete = true;
        if (retry) retry.hidden = true;
      } catch {
        container.dataset.visitsState = "error";
        container.hidden = true;
        if (retry) retry.hidden = false;
      } finally {
        loading = false;
        if (retry) retry.disabled = false;
      }
    }

    if (retry) retry.addEventListener("click", update);
    window.addEventListener("online", () => {
      if (container.dataset.visitsState === "error") update();
    });
    update();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
