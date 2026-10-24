"""Render public blog navigation, archived discussions, and disabled-by-default APIs."""
import html
from collections import defaultdict
from datetime import datetime
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


def comment_datetime(value):
    parsed = datetime.fromisoformat(value)
    timestamp = parsed.isoformat() if parsed.tzinfo else parsed.isoformat() + "+08:00"
    visible = f"{parsed.year} 年 {parsed.month} 月 {parsed.day} 日 {parsed:%H:%M:%S}"
    return timestamp, visible


def comments_section(document_id, records, rendered, feature):
    """The HTML archive is independent of a live writable comment service."""
    children = defaultdict(list)
    known = {row["id"] for row in records}
    for row in records:
        children[row["parent"] if row["parent"] in known else 0].append(row)

    def thread(parent):
        result = []
        for row in children[parent]:
            parent_value = f'wp-{row["parent"]}' if row["parent"] else ""
            author = '<span class="comment-author">' + escape(row["author_name"]) + '</span>'
            if row.get("author_url"):
                author = f'<a class="comment-author" href="{escape(row["author_url"])}" target="_blank" rel="ugc nofollow noopener noreferrer">{escape(row["author_name"])}</a>'
            timestamp, visible = comment_datetime(row["date"])
            replies = '<ol class="comment-replies">' + thread(row["id"]) + '</ol>' if children[row["id"]] else ""
            reply = f'<button type="button" data-comment-reply data-parent-id="wp-{row["id"]}" data-parent-name="{escape(row["author_name"])}" hidden>回复</button>'
            result.append(f'<li class="comment-item" id="comment-{row["id"]}" data-comment-id="wp-{row["id"]}" data-parent-id="{parent_value}"><article class="comment"><header class="comment-meta">{author}<time datetime="{escape(timestamp)}">{visible}</time><a class="comment-permalink" href="#comment-{row["id"]}" aria-label="这条评论的链接">#</a></header><div class="comment-body">{rendered[row["id"]]}</div>{reply}</article>{replies}</li>')
        return ''.join(result)

    form = f'''<form class="comment-form" data-comment-form>
<p class="comments-note">填写昵称即可留言。新评论经站主审核后公开，请勿提交私人信息。</p>
<p class="comment-reply-context" data-comment-reply-context hidden><span data-comment-reply-name></span> <button type="button" data-cancel-reply>取消回复</button></p>
<div class="comment-field"><label for="comment-nickname-{document_id}">昵称（必填）</label><input id="comment-nickname-{document_id}" name="nickname" required maxlength="40" autocomplete="off"></div>
<div class="comment-field"><label for="comment-body-{document_id}">评论（必填）</label><textarea id="comment-body-{document_id}" name="body" required maxlength="10000" rows="5"></textarea></div>
<div class="comment-honeypot" aria-hidden="true" hidden><label>网站<input name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="comment-form-actions"><button type="submit" disabled>提交评论</button></div>
<p class="comment-form-status" role="status" aria-live="polite">{'正在连接评论服务…' if feature['enabled'] else '新评论暂未开放，历史评论可正常阅读。'}</p>
</form>'''
    listing = '<ol class="comment-list" data-comment-list>' + thread(0) + '</ol>'
    empty = '<p class="comments-empty">暂无已公开评论。</p>' if not records else ""
    return f'<section class="comments-section historical-comments" id="comments" data-document-id="{document_id}" data-blog-api="{escape(feature["api_base"])}" data-comments-enabled="{str(feature["enabled"]).lower()}"><h2>评论 <span data-comment-count>{len(records)}</span></h2><p class="comments-note">历史评论来自旧站，保留原昵称、时间与回复关系。</p>{listing}{empty}<div data-new-comments></div><p class="comments-load-status" role="status"></p><button type="button" class="comments-more" data-comments-more hidden>加载更多评论</button>{form}<noscript><p>历史评论无需脚本即可阅读；提交新评论需要启用 JavaScript。</p></noscript></section>'
