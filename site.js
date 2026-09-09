(function () {
  "use strict";

  const content = window.SITE_CONTENT || {};
  const storageKey = "pku-xht-language";
  const recordGroups = ["publications", "education", "internships", "teaching", "awards"];
  let currentLanguage = "zh";

  function languageCode(value) {
    if (typeof value !== "string") return null;
    const code = value.trim().toLowerCase().split(/[-_]/)[0];
    return code === "zh" || code === "en" ? code : null;
  }

  function preferredLanguage() {
    try {
      const fromURL = languageCode(new URL(window.location.href).searchParams.get("lang"));
      if (fromURL) return fromURL;
    } catch (_) {
      // A readable homepage also works in restrictive preview environments.
    }
    try {
      const saved = languageCode(window.localStorage.getItem(storageKey));
      if (saved) return saved;
    } catch (_) {
      // Storage is optional; private or restricted browsing must still work.
    }
    const preferences = window.navigator.languages || [window.navigator.language];
    for (const preference of preferences) {
      const supported = languageCode(preference);
      if (supported) return supported;
    }
    return "zh";
  }

  function localized(value, fallback) {
    if (typeof value === "string") return value.trim() || fallback || "";
    if (value && typeof value === "object") {
      const preferred = value[currentLanguage];
      if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
      const alternate = value[currentLanguage === "zh" ? "en" : "zh"];
      if (typeof alternate === "string" && alternate.trim()) return alternate.trim();
    }
    return fallback || "";
  }

  function uiText(key, fallback) {
    const ui = content.ui || {};
    const selected = ui[currentLanguage] || {};
    const alternate = ui[currentLanguage === "zh" ? "en" : "zh"] || {};
    return localized(selected[key], localized(alternate[key], fallback));
  }

  function safeURL(value) {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const url = new URL(value.trim());
      if (!["https:", "http:", "mailto:"].includes(url.protocol)) return null;
      if (url.protocol !== "mailto:" && (!url.hostname || url.username || url.password)) return null;
      if (url.protocol === "mailto:" && !url.pathname) return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function setText(selector, text) {
    document.querySelectorAll(selector).forEach(function (element) {
      element.textContent = text;
    });
  }

  function setHidden(selector, hidden) {
    document.querySelectorAll(selector).forEach(function (element) {
      element.hidden = hidden;
    });
  }

  function prepareLink(link, url) {
    link.href = url;
    if (/^https?:/.test(url)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.removeAttribute("target");
      link.removeAttribute("rel");
    }
    return link;
  }

  function appendDetailsLink(container, url, title, className, labelKey, customLabel) {
    if (!url) return;
    const label = localized(customLabel, uiText(labelKey, currentLanguage === "zh" ? "查看详情" : "View details"));
    const link = prepareLink(node("a", className, label), url);
    link.setAttribute("aria-label", label + ": " + title);
    const arrow = node("span", className + "-arrow", "↗");
    arrow.setAttribute("aria-hidden", "true");
    link.appendChild(arrow);
    container.appendChild(link);
  }

  function appendRecordLinks(container, entry, title) {
    if (!Array.isArray(entry.links)) {
      appendDetailsLink(container, safeURL(entry.url), title, "record-link", "recordLink", entry.linkLabel);
      return;
    }
    const group = node("div", "record-links");
    entry.links.forEach(function (entryLink) {
      if (!entryLink || typeof entryLink !== "object") return;
      const url = safeURL(entryLink.url);
      const label = localized(entryLink.label);
      if (!url || !label) return;
      appendDetailsLink(group, url, title, "record-link", "recordLink", label);
    });
    if (group.childElementCount) container.appendChild(group);
  }

  function renderUI() {
    document.querySelectorAll("[data-i18n]").forEach(function (element) {
      const text = uiText(element.dataset.i18n);
      if (text) element.textContent = text;
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (element) {
      const text = uiText(element.dataset.i18nAriaLabel);
      if (text) element.setAttribute("aria-label", text);
    });
    document.querySelectorAll("[data-lang]").forEach(function (button) {
      const active = button.dataset.lang === currentLanguage;
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("is-active", active);
    });
    setText("[data-year]", String(new Date().getFullYear()));
  }

  function renderProfile() {
    const profile = content.profile || {};
    const name = localized(profile.name, "pku-xht");
    const intro = localized(profile.intro, currentLanguage === "zh" ? "欢迎来到我的个人主页。" : "Welcome to my personal homepage.");
    const about = localized(profile.about, currentLanguage === "zh" ? "这是我的个人主页。你可以在 GitHub 找到我。" : "This is my personal homepage. You can find me on GitHub.");
    setText("[data-profile-name]", name);
    const alternateLanguage = currentLanguage === "zh" ? "en" : "zh";
    const alternateName = profile.name && typeof profile.name === "object" ? profile.name[alternateLanguage] : "";
    document.querySelectorAll("[data-profile-alternate]").forEach(function (element) {
      const text = typeof alternateName === "string" ? alternateName.trim() : "";
      element.textContent = text;
      element.hidden = !text || text === name;
      element.lang = alternateLanguage === "zh" ? "zh-CN" : "en";
    });
    setText("[data-profile-intro]", intro);
    setText("[data-profile-about]", about);

    const advisor = profile.advisor || {};
    const advisorURL = safeURL(advisor.url);
    document.querySelectorAll("[data-profile-advisor]").forEach(function (link) {
      link.hidden = !advisorURL;
      if (!advisorURL) {
        link.removeAttribute("href");
        return;
      }
      link.textContent = localized(advisor.name, uiText("advisorLabel", "Advisor"));
      prepareLink(link, advisorURL);
    });
    return { name: name, intro: intro };
  }

  function renderWork() {
    const entries = Array.isArray(content.work) ? content.work.filter(function (entry) {
      return entry && typeof entry === "object" && localized(entry.title);
    }) : [];
    setHidden("[data-work-section], [data-work-nav]", entries.length === 0);
    document.querySelectorAll("[data-work-list]").forEach(function (list) {
      const fragment = document.createDocumentFragment();
      entries.forEach(function (entry) {
        const title = localized(entry.title);
        const article = node("article", "work-item");
        const copy = node("div", "work-copy");
        const meta = localized(entry.meta);
        if (meta) copy.appendChild(node("p", "work-meta", meta));
        copy.appendChild(node("h3", "work-title", title));
        const description = localized(entry.description);
        if (description) copy.appendChild(node("p", "work-description", description));
        article.appendChild(copy);
        appendDetailsLink(article, safeURL(entry.url), title, "work-link", "workLink");
        fragment.appendChild(article);
      });
      list.replaceChildren(fragment);
    });
  }

  function renderInterests() {
    const entries = Array.isArray(content.interests) ? content.interests.filter(function (entry) {
      return typeof entry === "string" ? entry.trim() : entry && localized(entry.title);
    }) : [];
    setHidden("[data-interest-section], [data-interest-nav]", entries.length === 0);
    document.querySelectorAll("[data-interest-list]").forEach(function (list) {
      const fragment = document.createDocumentFragment();
      entries.forEach(function (entry) {
        const article = node("article", "interest-item");
        article.appendChild(node("h3", "interest-title", localized(typeof entry === "string" ? entry : entry.title)));
        const description = localized(entry.description);
        if (description) article.appendChild(node("p", "interest-description", description));
        fragment.appendChild(article);
      });
      list.replaceChildren(fragment);
    });
  }

  function renderRecords() {
    const records = content.records || {};
    recordGroups.forEach(function (group) {
      const entries = Array.isArray(records[group]) ? records[group].filter(function (entry) {
        return entry && typeof entry === "object" && localized(entry.title);
      }) : [];
      setHidden('[data-record-section="' + group + '"], [data-record-nav="' + group + '"]', entries.length === 0);
      document.querySelectorAll('[data-record-list="' + group + '"]').forEach(function (list) {
        const fragment = document.createDocumentFragment();
        entries.forEach(function (entry) {
          const title = localized(entry.title);
          const isPublication = group === "publications";
          const article = node("article", isPublication ? "record-item publication-item" : "record-item");
          const period = localized(entry.period);
          const copy = node("div", "record-copy");
          copy.appendChild(node("h3", "record-title", title));
          if (Array.isArray(entry.authors)) {
            const authors = entry.authors.filter(function (author) { return typeof author === "string" && author.trim(); });
            if (authors.length) {
              const authorLine = node("p", "record-authors");
              authors.forEach(function (author, index) {
                if (index) authorLine.appendChild(document.createTextNode(", "));
                authorLine.appendChild(node(author === entry.highlightAuthor ? "strong" : "span", "", author));
              });
              copy.appendChild(authorLine);
            }
          }
          const subtitle = localized(entry.subtitle);
          if (subtitle) copy.appendChild(node("p", "record-subtitle", subtitle));
          const description = localized(entry.description);
          if (isPublication) {
            const metadata = node("div", "publication-meta");
            if (period) metadata.appendChild(node("p", "record-period publication-venue", period));
            if (description) metadata.appendChild(node("p", "record-description publication-status", description));
            appendRecordLinks(metadata, entry, title);
            if (metadata.childElementCount) copy.appendChild(metadata);
          } else {
            if (description) copy.appendChild(node("p", "record-description", description));
            appendRecordLinks(copy, entry, title);
          }
          article.appendChild(copy);
          if (!isPublication && period) article.appendChild(node("p", "record-period", period));
          fragment.appendChild(article);
        });
        list.replaceChildren(fragment);
      });
    });
  }

  function renderContacts() {
    const entries = Array.isArray(content.contacts) ? content.contacts : [];
    document.querySelectorAll("[data-contact-list]").forEach(function (list) {
      const fragment = document.createDocumentFragment();
      entries.forEach(function (entry) {
        if (!entry || typeof entry !== "object") return;
        const url = safeURL(entry.url);
        const label = localized(entry.label);
        if (!url || !label) return;
        const link = prepareLink(node("a", "contact-link"), url);
        link.appendChild(node("span", "contact-link-label", label));
        const arrow = node("span", "contact-link-arrow", "↗");
        arrow.setAttribute("aria-hidden", "true");
        link.appendChild(arrow);
        fragment.appendChild(link);
      });
      list.replaceChildren(fragment);
    });
  }

  function setMeta(attribute, name, value) {
    let element = document.head.querySelector('meta[' + attribute + '="' + name + '"]');
    if (!element) {
      element = document.createElement("meta");
      element.setAttribute(attribute, name);
      document.head.appendChild(element);
    }
    element.setAttribute("content", value);
  }

  function renderMetadata(profile) {
    const title = profile.name + (currentLanguage === "zh" ? " · 个人主页" : " · Personal homepage");
    const description = profile.name + " — " + profile.intro;
    document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.language = currentLanguage;
    document.title = title;
    setMeta("name", "description", description);
    setMeta("property", "og:title", title);
    setMeta("property", "og:description", description);
    setMeta("property", "og:locale", currentLanguage === "zh" ? "zh_CN" : "en_US");
    setMeta("property", "og:locale:alternate", currentLanguage === "zh" ? "en_US" : "zh_CN");
    setMeta("property", "og:site_name", profile.name);
    setMeta("name", "twitter:title", title);
    setMeta("name", "twitter:description", description);
  }

  function rememberLanguage(language) {
    try {
      window.localStorage.setItem(storageKey, language);
    } catch (_) {
      // The current selection still applies when storage is unavailable.
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("lang", language);
      window.history.replaceState(window.history.state, "", url.href);
    } catch (_) {
      // No navigation is required when a preview blocks history changes.
    }
  }

  function setLanguage(language, explicit) {
    const supported = languageCode(language);
    if (!supported) return;
    currentLanguage = supported;
    if (explicit) rememberLanguage(supported);
    renderUI();
    const profile = renderProfile();
    renderWork();
    renderInterests();
    renderRecords();
    renderContacts();
    renderMetadata(profile);
  }

  function setupReveals() {
    const elements = Array.from(document.querySelectorAll(".reveal"));
    if (!elements.length) return;
    const motionPreference = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let observer = null;
    const revealAll = function () {
      if (observer) observer.disconnect();
      document.documentElement.classList.remove("reveal-ready");
      elements.forEach(function (element) { element.classList.add("is-visible"); });
    };

    if (!("IntersectionObserver" in window) || (motionPreference && motionPreference.matches)) {
      revealAll();
      return;
    }

    try {
      observer = new window.IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      }, { threshold: 0.01, rootMargin: "0px 0px -20px 0px" });
      elements.forEach(function (element) { observer.observe(element); });
      document.documentElement.classList.add("reveal-ready");
    } catch (_) {
      revealAll();
      return;
    }

    document.addEventListener("focusin", function (event) {
      const target = event.target instanceof Element ? event.target.closest(".reveal") : null;
      if (target) {
        target.classList.add("is-visible");
        observer.unobserve(target);
      }
    });

    if (motionPreference) {
      const onMotionChange = function (event) { if (event.matches) revealAll(); };
      if (typeof motionPreference.addEventListener === "function") {
        motionPreference.addEventListener("change", onMotionChange);
      } else if (typeof motionPreference.addListener === "function") {
        motionPreference.addListener(onMotionChange);
      }
    }
  }

  function initialize() {
    setLanguage(preferredLanguage(), false);
    document.querySelectorAll("[data-lang]").forEach(function (button) {
      button.addEventListener("click", function () { setLanguage(button.dataset.lang, true); });
    });
    window.addEventListener("popstate", function () { setLanguage(preferredLanguage(), false); });
    setupReveals();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
