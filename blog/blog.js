(() => {
  "use strict";

  function initializeSearch() {
    const form = document.querySelector(".search-form");
    const input = document.getElementById("blog-search");
    const cards = Array.from(document.querySelectorAll(".post-card[data-search]"));
    if (!form || !input || cards.length === 0) return;

    const count = document.getElementById("search-count");
    const noResults = document.getElementById("no-results");
    const clearButton = document.getElementById("clear-search");
    const normalize = (text) => text.normalize("NFKC").toLocaleLowerCase("zh-CN");
    const searchable = cards.map((card) => normalize(card.dataset.search || ""));
    const tagFilterEnabled = Boolean(document.querySelector('.post-list[data-tag-filter="all"]'));
    const tagLinks = Array.from(document.querySelectorAll(".tag-cloud a[data-tag-id]"));
    const tagNames = new Map(tagLinks.map((link) => [link.dataset.tagId, link.dataset.tagName || link.textContent.trim()]));
    const cardTags = cards.map((card) => new Set((card.dataset.tags || "").trim().split(/\s+/u).filter(Boolean)));
    const activeFilter = document.querySelector(".active-tag-filter");
    const activeLabel = document.querySelector("[data-active-tag]");
    const clearTagButtons = document.querySelectorAll("[data-clear-tag]");

    function readTag() {
      if (!tagFilterEnabled) return "";
      const tag = new URL(window.location.href).searchParams.get("tag") || "";
      return /^[1-9]\d*$/u.test(tag) ? tag : "";
    }

    let activeTag = readTag();

    function updateTagAddress() {
      const next = new URL(window.location.href);
      if (activeTag) next.searchParams.set("tag", activeTag);
      else next.searchParams.delete("tag");
      if (next.href !== window.location.href) window.history.pushState(null, "", next);
    }

    function filterPosts() {
      const terms = normalize(input.value).trim().split(/\s+/u).filter(Boolean);
      let visible = 0;
      cards.forEach((card, index) => {
        const matches = (!activeTag || cardTags[index].has(activeTag)) && terms.every((term) => searchable[index].includes(term));
        card.hidden = !matches;
        if (matches) visible += 1;
      });
      const tagName = tagNames.get(activeTag) || activeTag;
      if (count) count.textContent = (activeTag ? `标签「${tagName}」：` : "") + (terms.length ? `找到 ${visible} 篇文章` : `共 ${visible} 篇文章`);
      if (noResults) noResults.hidden = visible !== 0;
      if (clearButton) clearButton.disabled = input.value.length === 0;
      if (tagFilterEnabled) {
        if (activeFilter) activeFilter.hidden = !activeTag;
        if (activeLabel) activeLabel.textContent = activeTag ? `标签：${tagName}` : "";
        tagLinks.forEach((link) => {
          if (activeTag === link.dataset.tagId) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        });
      }
    }

    function clearSearch(event) {
      event.preventDefault();
      input.value = "";
      filterPosts();
      input.focus();
    }

    input.addEventListener("input", filterPosts);
    input.addEventListener("search", filterPosts);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      filterPosts();
    });
    const clearButtons = new Set(document.querySelectorAll("[data-clear-search]"));
    if (clearButton) clearButtons.add(clearButton);
    clearButtons.forEach((button) => button.addEventListener("click", clearSearch));
    if (tagFilterEnabled) {
      tagLinks.forEach((link) => link.addEventListener("click", (event) => {
        // Modified clicks retain the real static tag-page URL for a new tab.
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === "_blank") return;
        const tag = link.dataset.tagId || "";
        if (!/^[1-9]\d*$/u.test(tag)) return;
        event.preventDefault();
        activeTag = tag;
        updateTagAddress();
        filterPosts();
      }));
      clearTagButtons.forEach((button) => button.addEventListener("click", (event) => {
        event.preventDefault();
        activeTag = "";
        updateTagAddress();
        filterPosts();
        input.focus();
      }));
      window.addEventListener("popstate", () => {
        activeTag = readTag();
        filterPosts();
      });
    }
    form.hidden = false;
    filterPosts();
  }

  function copyWithSelection(text) {
    const activeElement = document.activeElement;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const field = document.createElement("textarea");
    field.value = text;
    field.readOnly = true;
    field.setAttribute("aria-label", "待复制代码");
    field.style.cssText = "position:fixed;top:0;left:-9999px;";
    document.body.appendChild(field);
    field.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      field.remove();
      if (selection) {
        selection.removeAllRanges();
        ranges.forEach((range) => selection.addRange(range));
      }
      if (activeElement instanceof HTMLElement) activeElement.focus({ preventScroll: true });
    }
    if (!copied) throw new Error("Copy is unavailable");
  }

  function initializeCodeCopy() {
    document.querySelectorAll(".prose pre").forEach((pre) => {
      if (pre.parentElement.classList.contains("code-block")) return;
      const code = pre.querySelector("code");
      const text = (code || pre).textContent;
      const block = document.createElement("div");
      block.className = "code-block";
      pre.parentNode.insertBefore(block, pre);
      block.appendChild(pre);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "复制";
      button.setAttribute("aria-label", "复制代码");
      button.setAttribute("aria-live", "polite");
      block.appendChild(button);
      let resetTimer;

      button.addEventListener("click", async () => {
        window.clearTimeout(resetTimer);
        try {
          if (navigator.clipboard && window.isSecureContext) {
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              copyWithSelection(text);
            }
          } else {
            copyWithSelection(text);
          }
          button.textContent = "已复制";
          button.setAttribute("aria-label", "代码已复制");
        } catch {
          button.textContent = "请手动复制";
          button.setAttribute("aria-label", "复制未成功，请选择代码后手动复制");
        }
        resetTimer = window.setTimeout(() => {
          button.textContent = "复制";
          button.setAttribute("aria-label", "复制代码");
        }, 2500);
      });
    });
  }

  function initialize() {
    initializeSearch();
    initializeCodeCopy();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
