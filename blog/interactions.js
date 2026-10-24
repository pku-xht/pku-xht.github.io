(() => {
  "use strict";

  function endpoint(base, path) {
    const url = new URL(base, window.location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid API URL");
    url.pathname = url.pathname.replace(/\/+$/u, "") + "/";
    return new URL(path, url);
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return null;
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { credentials: "omit", cache: "no-store", ...options, signal: controller.signal });
      let data;
      try { data = await response.json(); } catch { data = null; }
      if (!response.ok) {
        const error = new Error("API request failed");
        error.status = response.status;
        error.code = data && data.error;
        throw error;
      }
      return { status: response.status, data };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function initializeComments(section) {
    if (section.dataset.commentsInitialized === "true") return;
    section.dataset.commentsInitialized = "true";
    const form = section.querySelector(".comment-form");
    if (!form) return;
    const nickname = form.querySelector('[name="nickname"]');
    const body = form.querySelector('[name="body"]');
    const website = form.querySelector('[name="website"]');
    const submit = form.querySelector('[type="submit"]');
    const fields = Array.from(form.querySelectorAll("input, textarea, button, fieldset"));
    let status = form.querySelector(".comment-form-status");
    if (!status) {
      status = document.createElement("p");
      status.className = "comment-form-status";
      status.setAttribute("role", "status");
      form.appendChild(status);
    }
    const disabledMessage = "新评论暂未开放，历史评论可正常阅读。";
    const documentId = section.dataset.documentId || "";
    let api;
    try { api = endpoint(section.dataset.blogApi || "", "v1/comments"); } catch { api = null; }
    const enabled = section.dataset.commentsEnabled === "true" && Boolean(section.dataset.blogApi) && /^[1-9]\d*$/u.test(documentId) && Boolean(api) && Boolean(nickname && body && submit);
    let submitting = false;
    let parentId = null;
    const pendingRequests = new Map();

    function lockForm(locked) {
      fields.forEach((field) => { field.disabled = locked; });
      form.setAttribute("aria-busy", submitting ? "true" : "false");
    }

    lockForm(!enabled);
    form.addEventListener("submit", submitComment);
    if (!enabled) {
      status.textContent = disabledMessage;
      section.querySelectorAll("[data-comment-reply]").forEach((button) => {
        button.hidden = true;
        button.setAttribute("aria-disabled", "true");
        if (button.tagName === "BUTTON") button.disabled = true;
      });
      return;
    }
    section.querySelectorAll("[data-comment-reply]").forEach((button) => {
      button.hidden = false;
      button.removeAttribute("disabled");
      button.removeAttribute("aria-disabled");
      if (button.tagName === "BUTTON") button.disabled = false;
    });
    status.textContent = "";
    const submitLabel = submit.textContent;
    const known = new Map();
    section.querySelectorAll("[data-comment-id]").forEach((node) => {
      if (!node.id) node.id = "comment-" + node.dataset.commentId;
      known.set(node.dataset.commentId, node);
    });
    let list = section.querySelector(".comment-list");
    if (!list) {
      list = document.createElement("ol");
      list.className = "comment-list";
      form.parentNode.insertBefore(list, form);
    }
    let loadStatus = section.querySelector(".comments-load-status");
    if (!loadStatus) {
      loadStatus = document.createElement("p");
      loadStatus.className = "comments-load-status comments-note";
      loadStatus.setAttribute("role", "status");
      list.parentNode.insertBefore(loadStatus, list);
    }
    let more = section.querySelector("[data-comments-more]");
    if (!more) {
      more = document.createElement("button");
      more.type = "button";
      more.className = "comments-more";
      more.dataset.commentsMore = "";
      more.hidden = true;
      form.parentNode.insertBefore(more, form);
    }
    let replyContext = form.querySelector("[data-comment-reply-context]");
    if (!replyContext) {
      replyContext = document.createElement("p");
      replyContext.className = "comment-reply-context";
      replyContext.dataset.commentReplyContext = "";
      replyContext.hidden = true;
      const label = document.createElement("span");
      label.dataset.commentReplyName = "";
      replyContext.appendChild(label);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "comment-cancel-reply";
      cancel.dataset.cancelReply = "";
      cancel.textContent = "取消回复";
      replyContext.appendChild(cancel);
      form.insertBefore(replyContext, form.firstChild);
    }
    const replyName = replyContext.querySelector("[data-comment-reply-name]");
    const waitingForParent = new Map();
    let loading = false;
    let nextCursor = null;
    let retryCursor = null;

    function resetReply() {
      parentId = null;
      replyContext.hidden = true;
      if (replyName) replyName.textContent = "";
    }

    function clearValidity(field) {
      field.removeAttribute("aria-invalid");
      if (typeof field.setCustomValidity === "function") field.setCustomValidity("");
    }

    [nickname, body].forEach((field) => field.addEventListener("input", () => clearValidity(field)));

    function invalid(field, message) {
      status.textContent = message;
      field.setAttribute("aria-invalid", "true");
      if (typeof field.setCustomValidity === "function") field.setCustomValidity(message);
      field.focus();
      if (typeof field.reportValidity === "function") field.reportValidity();
    }

    function errorMessage(error) {
      if (error.code === "invalid_nickname") return "请填写昵称，最多 40 个字符。";
      if (error.code === "invalid_comment") return "请填写评论正文，最多 10000 个字符。";
      if (error.status === 403) return "当前页面暂不能提交评论，请从正式站点打开后重试。草稿已保留。";
      if (error.status === 404) return "该页面的评论尚未开放。草稿已保留。";
      if (error.status === 409) return "本次提交的重试标识发生冲突，请修改内容后重试。草稿已保留。";
      if (error.status === 429) return "提交过于频繁，请稍后重试。草稿已保留。";
      return "请求暂未完成，请检查连接后重试。草稿已保留。";
    }

    async function submitComment(event) {
      event.preventDefault();
      if (!enabled) { status.textContent = disabledMessage; return; }
      if (submitting) return;
      clearValidity(nickname);
      clearValidity(body);
      const name = nickname.value.trim();
      const text = body.value.trim();
      if (!name || name.length > 40) { invalid(nickname, "请填写昵称，最多 40 个字符。"); return; }
      if (!text || text.length > 10000) { invalid(body, "请填写评论正文，最多 10000 个字符。"); return; }
      const payload = { document: documentId, nickname: name, body: text, parent_id: parentId, website: website ? website.value : "" };
      const fingerprint = JSON.stringify(payload);
      let id = pendingRequests.get(fingerprint);
      if (!id) {
        id = randomId();
        if (!id) { status.textContent = "当前浏览器无法生成提交标识，请更新浏览器后重试。草稿已保留。"; return; }
        pendingRequests.set(fingerprint, id);
      }
      payload.request_id = id;
      submitting = true;
      lockForm(true);
      submit.textContent = "提交中…";
      status.textContent = "";
      try {
        const result = await request(api, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
        if (result.status !== 202 || !result.data || result.data.status !== "pending") throw new Error("Unexpected submission response");
        // A pending response never adds a public comment or increments a count.
        status.textContent = "已提交，等待审核。";
        nickname.value = "";
        body.value = "";
        if (website) website.value = "";
        pendingRequests.delete(fingerprint);
        resetReply();
      } catch (error) {
        status.textContent = errorMessage(error);
      } finally {
        submitting = false;
        lockForm(false);
        submit.textContent = submitLabel;
      }
    }

    section.addEventListener("click", (event) => {
      const cancel = event.target.closest("[data-cancel-reply]");
      if (cancel && section.contains(cancel)) {
        event.preventDefault();
        if (!submitting) { resetReply(); body.focus(); }
        return;
      }
      const button = event.target.closest("[data-comment-reply]");
      if (!button || !section.contains(button)) return;
      event.preventDefault();
      if (submitting) return;
      const item = button.closest("[data-comment-id]");
      const id = button.dataset.parentId || (item && item.dataset.commentId) || "";
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) return;
      parentId = id;
      const author = item && item.querySelector(".comment-author");
      const name = button.dataset.parentName || (author && author.textContent) || "原评论";
      if (replyName) replyName.textContent = "回复：" + name;
      replyContext.hidden = false;
      (nickname.value.trim() ? body : nickname).focus();
    });

    function parentHref(id) {
      const parent = known.get(id);
      if (parent) return "#" + encodeURIComponent(parent.id);
      const source = document.querySelector(".source-note a");
      if (/^wp-\d+$/u.test(id) && source) {
        const original = new URL(source.href, window.location.href);
        original.hash = "comment-" + id.slice(3);
        return original.href;
      }
      return "#" + encodeURIComponent("comment-" + id);
    }

    function makeComment(item) {
      const node = document.createElement("li");
      node.className = "comment-item";
      node.dataset.commentId = item.id;
      node.id = "comment-" + item.id;
      const article = document.createElement("article");
      article.className = "comment";
      const meta = document.createElement("header");
      meta.className = "comment-meta";
      const author = document.createElement("span");
      author.className = "comment-author";
      author.textContent = item.nickname;
      meta.appendChild(author);
      const date = new Date(item.created_at);
      if (!Number.isNaN(date.getTime())) {
        const time = document.createElement("time");
        time.dateTime = item.created_at;
        time.textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(date);
        meta.appendChild(time);
      }
      const permalink = document.createElement("a");
      permalink.className = "comment-permalink";
      permalink.href = "#" + encodeURIComponent(node.id);
      permalink.textContent = "链接";
      meta.appendChild(permalink);
      article.appendChild(meta);
      const content = document.createElement("div");
      content.className = "comment-body";
      const paragraph = document.createElement("p");
      paragraph.className = "comment-text";
      paragraph.textContent = item.body;
      content.appendChild(paragraph);
      article.appendChild(content);
      const reply = document.createElement("button");
      reply.type = "button";
      reply.className = "comment-reply";
      reply.dataset.commentReply = "";
      reply.dataset.parentId = item.id;
      reply.dataset.parentName = item.nickname;
      reply.textContent = "回复";
      article.appendChild(reply);
      node.appendChild(article);
      return node;
    }

    function placeReply(node, id) {
      const parent = known.get(id);
      if (!parent || parent === node || node.contains(parent)) return false;
      let replies = Array.from(parent.children).find((child) => child.classList.contains("comment-replies"));
      if (!replies) {
        replies = document.createElement("ol");
        replies.className = "comment-replies";
        parent.appendChild(replies);
      }
      replies.appendChild(node);
      const note = node.querySelector(".comment-missing-parent");
      if (note) note.remove();
      return true;
    }

    function renderComments(items) {
      const incoming = [];
      items.forEach((item) => {
        if (!item || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.id) || String(item.document) !== documentId || typeof item.nickname !== "string" || typeof item.body !== "string" || (item.status && item.status !== "approved") || known.has(item.id)) return;
        const node = makeComment(item);
        known.set(item.id, node);
        incoming.push({ item, node });
      });
      incoming.forEach(({ item, node }) => {
        if (typeof item.parent_id === "string" && item.parent_id) {
          if (placeReply(node, item.parent_id)) return;
          const note = document.createElement("p");
          note.className = "comment-reply-context comment-missing-parent";
          const link = document.createElement("a");
          link.href = parentHref(item.parent_id);
          link.textContent = "回复原评论";
          note.appendChild(link);
          node.querySelector(".comment-body").insertBefore(note, node.querySelector(".comment-text"));
          waitingForParent.set(node, item.parent_id);
        }
        list.appendChild(node);
      });
      waitingForParent.forEach((id, node) => {
        if (placeReply(node, id)) waitingForParent.delete(node);
      });
      section.querySelectorAll("[data-comment-count]").forEach((counter) => {
        counter.textContent = String(known.size);
      });
      section.querySelectorAll(".comments-empty").forEach((message) => {
        message.hidden = known.size !== 0;
      });
    }

    async function loadComments(cursor) {
      if (loading) return;
      loading = true;
      retryCursor = cursor;
      more.disabled = true;
      loadStatus.textContent = "正在加载新评论…";
      try {
        const url = new URL(api);
        url.searchParams.set("document", documentId);
        if (cursor !== null) url.searchParams.set("cursor", String(cursor));
        const result = await request(url, { headers: { Accept: "application/json" } });
        const data = result.data;
        if (!data || !Array.isArray(data.comments) || (data.next_cursor !== null && (!Number.isSafeInteger(data.next_cursor) || data.next_cursor < 0))) throw new Error("Unexpected comments response");
        renderComments(data.comments);
        nextCursor = data.next_cursor;
        more.hidden = nextCursor === null;
        more.textContent = "加载更多评论";
        loadStatus.textContent = "";
      } catch {
        loadStatus.textContent = "新评论暂时无法加载，已迁入的历史评论仍可阅读。";
        more.hidden = false;
        more.textContent = "重试加载";
      } finally {
        loading = false;
        more.disabled = false;
      }
    }

    more.addEventListener("click", () => loadComments(more.textContent === "重试加载" ? retryCursor : nextCursor));
    loadComments(null);
  }

  function initialize() {
    document.querySelectorAll(".comments-section").forEach(initializeComments);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
