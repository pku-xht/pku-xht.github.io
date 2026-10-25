"""Render public blog navigation, archived discussions, and disabled-by-default APIs."""
import html
from pathlib import Path
from urllib.parse import urlsplit

from blog_sources import _yaml


def escape(value):
    return html.escape(str(value), quote=True)


def load_features(path):
    path = Path(path)
    config = _yaml(path.read_text(encoding="utf-8"), path)
    if not isinstance(config, dict) or set(config) != {"version", "comments", "visits"} or type(config["version"]) is not int or config["version"] != 1:
        raise ValueError(f"{path}: expected version 1, comments, and visits")
    for name in ("comments", "visits"):
        entry = config[name]
        keys = {"enabled", "api_base", "moderation"} if name == "comments" else {"enabled", "api_base"}
        if not isinstance(entry, dict) or set(entry) != keys or type(entry.get("enabled")) is not bool or not isinstance(entry.get("api_base"), str):
            raise ValueError(f"{path}: invalid {name} feature configuration")
        base = entry["api_base"]
        if base:
            parts = urlsplit(base)
            local = parts.hostname in {"127.0.0.1", "localhost"} and parts.scheme == "http"
            if not ((parts.scheme == "https" and parts.hostname) or local) or parts.username or parts.password or parts.query or parts.fragment or any(char.isspace() for char in base):
                raise ValueError(f"{path}: {name} API must be HTTPS or a loopback development URL")
        if entry["enabled"] and not base:
            raise ValueError(f"{path}: enabled {name} needs an API URL")
        entry["api_base"] = base.rstrip("/")
    if config["comments"]["moderation"] != "required":
        raise ValueError(f"{path}: all new comments must require moderation")
    return config


def tag_records(tags, posts):
    records = []
    for identifier, term in tags.items():
        count = sum(identifier in post.get("tags", []) for post in posts)
        if count:
            records.append({"id": identifier, "name": term["name"], "path": f"/blog/tags/{identifier}/", "count": count})
    return sorted(records, key=lambda term: (term["name"].casefold(), term["id"]))


def tag_cloud(records, collapsed=False):
    largest = max((row["count"] for row in records), default=1)
    items = []
    for row in records:
        weight = 1 + round(4 * (row["count"] - 1) / max(1, largest - 1))
        items.append(f'<li><a href="{row["path"]}" class="tag-weight-{weight}" data-tag-id="{row["id"]}" data-tag-name="{escape(row["name"])}" data-tag-count="{row["count"]}">{escape(row["name"])} <span class="tag-count">{row["count"]}</span></a></li>')
    cloud = '<ul class="tag-cloud">' + "".join(items) + '</ul>'
    if collapsed:
        return f'<details class="tag-section"><summary>按标签浏览（{len(records)}）</summary>{cloud}<p><a href="/blog/tags/">查看全部标签</a></p></details>'
    return '<section class="tag-section" aria-label="标签云">' + cloud + '</section>'


def friend_list(links):
    items = ''.join(f'<li><a class="friend-name" href="{escape(link["url"])}" target="_blank" rel="noopener noreferrer">{escape(link["name"])}</a></li>' for link in links)
    return '<section class="friend-links" aria-label="友情链接"><ul class="friend-list">' + items + '</ul></section>'


def comments_section(document_id, feature):
    """The service is the only authority for comment visibility and moderation."""
    form = f'''<form class="comment-form" data-comment-form>
<p class="comments-note">填写昵称即可留言。评论经站主审核后公开，请勿提交私人信息。</p>
<p class="comment-reply-context" data-comment-reply-context hidden><span data-comment-reply-name></span> <button type="button" data-cancel-reply>取消回复</button></p>
<div class="comment-field"><label for="comment-nickname-{document_id}">昵称（必填）</label><input id="comment-nickname-{document_id}" name="nickname" required maxlength="40" autocomplete="off"></div>
<div class="comment-field"><label for="comment-body-{document_id}">评论（必填）</label><textarea id="comment-body-{document_id}" name="body" required maxlength="10000" rows="5"></textarea></div>
<div class="comment-honeypot" aria-hidden="true" hidden><label>网站<input name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="comment-form-actions"><button type="submit" disabled>提交评论</button></div>
<p class="comment-form-status" role="status" aria-live="polite">{'正在连接评论服务…' if feature['enabled'] else '评论暂未开放。'}</p>
</form>'''
    listing = '<ol class="comment-list" data-comment-list></ol>'
    empty = '<p class="comments-empty" hidden>暂无已公开评论。</p>'
    return f'<section class="comments-section" id="comments" data-document-id="{document_id}" data-blog-api="{escape(feature["api_base"])}" data-comments-enabled="{str(feature["enabled"]).lower()}"><h2>评论 <span data-comment-count></span></h2>{listing}{empty}<p class="comments-load-status" role="status"></p><button type="button" class="comments-more" data-comments-more hidden>加载更多评论</button>{form}<noscript><p>阅读和提交评论需要启用 JavaScript。</p></noscript></section>'
