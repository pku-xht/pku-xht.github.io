"""Build the public blog from its registered Markdown + YAML source files.

Python 3.9+ and Node.js; no network, cookies, package install or deployment.
"""
import hashlib
import html
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
from blog_sources import load_blog
from blog_comments import load_comments, sanitize_comment_html
from blog_friends import load_friends
from blog_interactions import comments_section, friend_list, load_features, tag_cloud, tag_records
ALLOWED = set("p br strong em b i u s del h1 h2 h3 h4 h5 h6 ul ol li a code pre blockquote hr img table thead tbody tr th td sup sub span div".split())
VOID = {"br", "hr", "img"}


@dataclass
class Element:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)


@dataclass
class Math:
    original: str
    tex: str
    display: bool
    rendered: str = ""


class Fragment(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Element("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        if tag not in ALLOWED:
            raise ValueError("Unexpected source tag: " + tag)
        element = Element(tag, dict(attrs))
        self.stack[-1].children.append(element)
        if tag not in VOID:
            self.stack.append(element)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def text(node):
    if isinstance(node, str):
        return node
    if isinstance(node, Math):
        return node.original
    if node.tag == "br":
        return "\n"
    return "".join(text(child) for child in node.children)


def walk(node):
    yield node
    if isinstance(node, Element):
        for child in node.children:
            yield from walk(child)


def parse(source):
    parser = Fragment()
    parser.feed(source)
    parser.close()
    root = parser.root
    # The old counter plugin prepends a dynamic paragraph to rendered content.
    first = next((n for n in root.children if isinstance(n, Element)), None)
    if first and first.tag == "p" and re.fullmatch(r"\s*Visits:\s*\d+\s*", text(first)):
        root.children.remove(first)
    return root


def split_math(value, post_id):
    result, start, i = [], 0, 0
    while i < len(value):
        if value[i] != "$" or (i > 0 and value[i - 1] == "\\"):
            i += 1
            continue
        delimiter = "$$" if value[i:i + 2] == "$$" else "$"
        end = i + len(delimiter)
        while True:
            end = value.find(delimiter, end)
            if end < 0:
                raise ValueError(f"Unclosed math in post {post_id}: {value[max(0, i - 30):i + 150]!r}")
            if value[end - 1] != "\\":
                break
            end += len(delimiter)
        if i > start:
            result.append(value[start:i])
        original = value[i:end + len(delimiter)]
        tex = value[i + len(delimiter):end].replace("\ue000", "\n")
        # WordPress smart punctuation changes TeX minus signs into en dashes.
        tex = tex.replace("–", "-")
        # The old notes use a literal caret in text mode for the XOR operator.
        tex = tex.replace(r"\text{^}", r"\text{\textasciicircum}")
        result.append(Math(original.replace("\ue000", "\n"), tex, delimiter == "$$"))
        i = end + len(delimiter)
        start = i
    if start < len(value):
        result.append(value[start:])
    expanded = []
    for item in result:
        if isinstance(item, str):
            pieces = item.split("\ue000")
            for j, piece in enumerate(pieces):
                if j:
                    expanded.append(Element("br"))
                if piece:
                    expanded.append(piece)
        else:
            expanded.append(item)
    return expanded


def prepare_math(node, post_id):
    if not isinstance(node, Element) or node.tag in {"pre", "code"} or node.attrs.get("data-blog-literal-dollar") == "1":
        return
    children, run = [], []

    def flush():
        if run:
            children.extend(split_math("".join(run), post_id))
            run.clear()

    for child in node.children:
        if isinstance(child, str):
            run.append(child)
        elif isinstance(child, Element) and child.tag == "br":
            run.append("\ue000")
        else:
            flush()
            prepare_math(child, post_id)
            children.append(child)
    flush()
    node.children = children


def normal_path(url):
    return unquote(urlsplit(url).path).rstrip("/").lower()


def escape(value):
    return html.escape(str(value), quote=True)


def safe_url(value):
    parts = urlsplit(value)
    if any(ord(ch) < 32 for ch in value) or parts.scheme not in {"https", "http", "mailto", ""} or parts.username or parts.password:
        raise ValueError("Unsafe source URL: " + value)
    if not parts.scheme and not value.startswith(("#", "/")):
        raise ValueError("Unexpected relative source URL: " + value)
    return value


def local_target(value, routes, media):
    """Resolve only checked, public routes and saved resource aliases."""
    parts = urlsplit(value)
    fragment = "#" + parts.fragment if parts.fragment else ""
    resource_url = value.split("#", 1)[0]
    if resource_url in media:
        return media[resource_url]["path"] + fragment
    resource_key = (parts.hostname, unquote(parts.path), parts.query)
    for original, item in media.items():
        candidate = urlsplit(original)
        if resource_key == (candidate.hostname, unquote(candidate.path), candidate.query):
            return item["path"] + fragment
    # Old content mixes http/https for the same public upload.
    for alternate in ("https:" + resource_url[5:] if resource_url.startswith("http:") else "", "http:" + resource_url[6:] if resource_url.startswith("https:") else ""):
        if alternate in media:
            return media[alternate]["path"] + fragment
    if parts.hostname in {"www.xht37.com", "xht37.com"} or (not parts.scheme and value.startswith("/")):
        query = parse_qs(parts.query)
        for key, prefix in [("p", "post:"), ("page_id", "page:")]:
            if query.get(key) and prefix + query[key][0] in routes:
                return routes[prefix + query[key][0]] + fragment
        if normal_path(value) in routes:
            return routes[normal_path(value)] + fragment
    return value


def add_legacy_anchors(documents, routes, media):
    """Keep verified old heading fragments used by the migrated public corpus."""
    by_route = {post["route"]: post for post in documents}
    normalize = lambda value: re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")
    verified = {(post["id"], fragment): heading for post in documents for fragment, heading in post.get("legacy_anchors", {}).items()}
    for post in documents:
        for node in walk(post["tree"]):
            if not isinstance(node, Element) or node.tag != "a":
                continue
            original = node.attrs.get("href", "")
            resolved = local_target(original, routes, media)
            parts = urlsplit(resolved)
            target = post if resolved.startswith("#") else by_route.get(parts.path)
            if not parts.fragment or not target or parts.scheme or parts.netloc:
                continue
            fragment = unquote(parts.fragment)
            if any(isinstance(n, Element) and n.attrs.get("id") == fragment for n in walk(target["tree"])):
                continue
            headings = target["headings"]
            needle = normalize(fragment)
            if (target["id"], fragment) in verified:
                candidates = [h for h in headings if text(h).strip() == verified[(target["id"], fragment)]]
            else:
                candidates = [h for h in headings if needle and (normalize(text(h)) == needle or normalize(text(h)).endswith("_" + needle))]
            if len(candidates) != 1:
                raise ValueError(f"Unverified old heading fragment from {post['id']} to {target['id']}: {fragment!r}")
            aliases = candidates[0].attrs.setdefault("_aliases", [])
            if fragment not in aliases:
                aliases.append(fragment)


def serialize(node, post, routes, media, in_toc=False):
    if isinstance(node, str):
        return html.escape(node, quote=False)
    if isinstance(node, Math):
        cls = "math-block" if node.display else "math-inline"
        return f'<span class="{cls}" data-original-math="{escape(node.original)}">{node.rendered}</span>'
    tag, attrs = node.tag, {}
    if tag == "root" or (in_toc and tag == "a"):
        return "".join(serialize(ch, post, routes, media, in_toc) for ch in node.children)
    if "id" in node.attrs and not in_toc:
        attrs["id"] = node.attrs["id"]
    if tag == "a":
        url = safe_url(node.attrs.get("href", ""))
        url = local_target(url, routes, media)
        attrs["href"] = url
        if url.startswith(("https:", "http:")):
            attrs.update(target="_blank", rel="noopener noreferrer")
    if tag == "img":
        url = node.attrs["src"]
        local = local_target(url, routes, media)
        if not local.startswith("/blog/media/"):
            raise ValueError("Image has not been saved locally: " + url)
        attrs.update(src=local, alt=node.attrs.get("alt") or post["title"] + "：原文插图", loading="lazy", decoding="async")
    if tag == "code":
        classes = re.findall(r"language-[\w+-]+", node.attrs.get("class", ""))
        if classes:
            attrs["class"] = classes[0]
    if tag == "pre":
        attrs["tabindex"] = "0"
    if tag in {"td", "th"} and node.attrs.get("align") in {"left", "center", "right"}:
        attrs["class"] = "align-" + node.attrs["align"]
    if tag in {"td", "th"}:
        for key in ["colspan", "rowspan"]:
            if key in node.attrs and re.fullmatch(r"[1-9]\d{0,3}", node.attrs[key]):
                attrs[key] = node.attrs[key]
    if tag == "ol" and "start" in node.attrs and re.fullmatch(r"-?\d+", node.attrs["start"]):
        attrs["start"] = node.attrs["start"]
    rendered_attrs = "".join(f' {key}="{escape(value)}"' for key, value in attrs.items())
    rendered = f"<{tag}{rendered_attrs}>"
    if tag not in VOID:
        if not in_toc:
            rendered += "".join(f'<span id="{escape(alias)}" class="legacy-anchor" aria-hidden="true"></span>' for alias in node.attrs.get("_aliases", []))
        rendered += "".join(serialize(ch, post, routes, media, in_toc) for ch in node.children) + f"</{tag}>"
    if tag == "table":
        rendered = '<div class="table-scroll" tabindex="0">' + rendered + "</div>"
    return rendered


def display_date(value):
    year, month, day = map(int, value[:10].split("-"))
    return f"{year} 年 {month} 月 {day} 日"


def header(active="博客"):
    nav = []
    for label, url in [("主页", "/"), ("博客", "/blog/"), ("归档", "/blog/archive/"), ("标签", "/blog/tags/"), ("友链", "/blog/friends/"), ("旧站 ↗", "https://www.xht37.com/")]:
        attrs = ' aria-current="page"' if label == active else ""
        if url.startswith("https:"):
            attrs += ' target="_blank" rel="noopener noreferrer"'
        nav.append(f'<a href="{url}"{attrs}>{label}</a>')
    return '<a class="skip-link" href="#main">跳到正文</a><header class="site-header"><div class="site-width"><a class="identity" href="/"><img src="/assets/x-script-icon.svg" alt="" width="25" height="25"><span>徐皓天 <span class="identity-note">/ 博客</span></span></a><nav class="site-nav" aria-label="主导航">' + "".join(nav) + '</nav></div></header>'


def page(title, description, route, body, active="博客", has_math=False, features=None, document_id=None):
    math_css = '<link rel="stylesheet" href="/assets/vendor/katex/katex.min.css">' if has_math else ""
    visits = features and features["visits"]["enabled"]
    visits_script = '<script defer src="/blog/visits.js?v=1"></script>' if visits else ""
    visits_attrs = f' data-blog-visits data-visits-enabled="true" data-blog-api="{escape(features["visits"]["api_base"])}" data-document-id="{document_id or ""}"' if visits else ""
    counts = f'<p class="visit-counts"{visits_attrs} hidden>本站访问 <span data-site-visits>—</span>' + ('<span data-document-visits-wrapper> · 本文访问 <span data-document-visits>—</span></span>' if document_id else '') + '</p>' if visits else ""
    return f'''<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="theme-color" content="#fcfbf8">
<title>{escape(title)} · 徐皓天</title><meta name="description" content="{escape(description)}">
<link rel="canonical" href="https://pku-xht.github.io{route}">
<meta property="og:title" content="{escape(title)} · 徐皓天"><meta property="og:description" content="{escape(description)}">
<meta property="og:type" content="{'article' if has_math or route.startswith('/blog/posts/') else 'website'}"><meta property="og:url" content="https://pku-xht.github.io{route}">
<link rel="icon" href="/assets/favicon.svg?v=2" type="image/svg+xml">
<link rel="stylesheet" href="/blog/blog.css?v=2">{math_css}<script defer src="/blog/blog.js?v=2"></script><script defer src="/blog/interactions.js?v=1"></script>{visits_script}
</head><body class="blog-page">{header(active)}
<main class="site-width" id="main">{body}</main>
<footer class="site-footer"><div class="site-width">徐皓天 · xht37{counts}</div></footer>
</body></html>
'''


def write(route, content):
    path = ROOT / route.lstrip("/") / "index.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def main():
    source_dir = ROOT / "content/blog"
    batch = load_blog(source_dir, project_root=ROOT)
    assert batch["source_format"] == "markdown-yaml"
    posts = sorted(batch["posts"], key=lambda p: (p["date"], p["id"]), reverse=True)
    pages = sorted(batch.get("pages", []), key=lambda p: (p["date"], p["id"]), reverse=True)
    documents = posts + pages
    comments = load_comments(source_dir, post_ids=[post["id"] for post in documents], project_root=ROOT)
    friends = load_friends(source_dir / "friends.yaml")
    features = load_features(source_dir / "features.yaml")
    assert len(posts) == len({p["id"] for p in posts}) == batch["count"]
    assert len(pages) == len({p["id"] for p in pages})
    assert len({p["id"] for p in documents}) == len(documents)
    categories = {category["id"]: dict(category) for category in batch["categories"]}
    tags = {tag["id"]: dict(tag) for tag in batch.get("tags", [])}
    used_tags = tag_records(tags, posts)
    media_list = batch["resources"]
    media = {m["original_url"]: m for m in media_list}
    for item in media_list:
        assert hashlib.sha256((ROOT / item["path"].lstrip("/")).read_bytes()).hexdigest() == item["sha256"]
        if item.get("download_url"):
            media.setdefault(item["download_url"], item)
    routes = {"": "/blog/"}
    for post in documents:
        assert post["type"] in {"post", "page"}
        post["route"] = f'/blog/{"posts" if post["type"] == "post" else "pages"}/{post["id"]}/'
        routes[normal_path(post["link"])] = post["route"]
        routes[post["type"] + ":" + str(post["id"])] = post["route"]
    formulas = {}
    comment_trees = {}
    for post in documents:
        assert post["status"] == "publish" and not post["protected"]
        assert all(category in categories for category in post["categories"])
        assert all(tag in tags for tag in post.get("tags", []))
        assert hashlib.sha256(post["content_html"].encode()).hexdigest() == post["content_sha256"]
        root = parse(post["content_html"])
        paragraphs = [text(n).strip() for n in walk(root) if isinstance(n, Element) and n.tag == "p" and text(n).strip()]
        excerpt = paragraphs[0] if paragraphs else post["title"]
        excerpt = re.sub(r"\$\$.*?\$\$", " ", excerpt, flags=re.S)
        excerpt = re.sub(r"\s+", " ", excerpt).replace("$", "")
        excerpt = re.sub(r"\\(?:mathcal|mathrm|operatorname|text)\s*", "", excerpt)
        symbols = {"le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "times": "×"}
        excerpt = re.sub(r"\\(leq|geq|le|ge|times)(?![A-Za-z])", lambda m: symbols[m.group(1)], excerpt)
        post["excerpt"] = post.get("summary", excerpt[:140] + ("…" if len(excerpt) > 140 else ""))
        prepare_math(root, post["id"])
        headings = [n for n in walk(root) if isinstance(n, Element) and re.fullmatch(r"h[1-6]", n.tag)]
        if headings:
            shift = 2 - min(int(n.tag[1]) for n in headings)
            for i, heading in enumerate(headings, 1):
                heading.tag = "h" + str(min(6, int(heading.tag[1]) + shift))
                # Existing author-supplied anchors remain valid after migration.
                heading.attrs.setdefault("id", f"section-{i}")
        post["headings"] = headings
        post["tree"] = root
        for n in walk(root):
            if isinstance(n, Math):
                formulas[(n.tex, n.display)] = None
        for comment in comments["by_post"][post["id"]]:
            parser = Fragment()
            parser.feed(sanitize_comment_html(comment["content"]["rendered"]))
            parser.close()
            comment_root = parser.root
            prepare_math(comment_root, f'comment-{comment["id"]}')
            comment_trees[comment["id"]] = comment_root
            for node in walk(comment_root):
                if isinstance(node, Math):
                    formulas[(node.tex, node.display)] = None
    add_legacy_anchors(documents, routes, media)
    keys = list(formulas)
    result = subprocess.run(["node", str(ROOT / "tools/render_math.cjs")], input=json.dumps([{"tex": k[0], "display": k[1]} for k in keys]), text=True, encoding="utf-8", capture_output=True, check=True)
    rendered = json.loads(result.stdout)
    errors = [(keys[i], row["error"]) for i, row in enumerate(rendered) if "error" in row]
    if errors:
        for key, error in errors:
            print(repr(key), error)
        raise ValueError(f"{len(errors)} unique TeX expressions failed")
    formulas = {key: row["html"] for key, row in zip(keys, rendered)}
    report = {"batch": "public-2026-10-23", "source_format": "markdown-yaml", "source": "content/blog", "design": "C", "publication": "local-only", "posts": [], "pages": [], "categories": []}
    report["tags"] = used_tags
    report["friends"] = {"path": "/blog/friends/", "count": len(friends), "source_file": "content/blog/friends.yaml"}
    report["comments"] = {key: comments[key] for key in ("count", "sources", "index_file", "index_sha256", "types")}
    report["comments"]["formulas"] = sum(isinstance(node, Math) for tree in comment_trees.values() for node in walk(tree))
    report["features"] = {"comments_enabled": features["comments"]["enabled"], "visits_enabled": features["visits"]["enabled"]}

    def category_route(category_id):
        return f"/blog/categories/{category_id}/"

    def metadata(post):
        modified = "" if post["date"][:10] == post["modified"][:10] else f'<span>更新于 {display_date(post["modified"])}</span>'
        labels = "".join(f'<a href="{category_route(cid)}">{escape(categories[cid]["name"])}</a>' for cid in post["categories"])
        if post["type"] == "page":
            labels = '<span>旧站历史页</span>'
        return f'<p class="post-meta"><time datetime="{post["date"]}+08:00">{display_date(post["date"])}</time>{labels}{modified}</p>'

    def card(post):
        labels = " ".join(categories[cid]["name"] for cid in post["categories"])
        source_tags = " ".join(tags[tid]["name"] for tid in post.get("tags", []))
        search_text = post["title"] + " " + post["excerpt"] + " " + labels + " " + source_tags
        tag_ids = " ".join(str(identifier) for identifier in post.get("tags", []))
        return f'<article class="post-card" data-search="{escape(search_text)}" data-tags="{tag_ids}"><h2><a href="{post["route"]}">{escape(post["title"])}</a></h2>{metadata(post)}<p class="post-excerpt">{escape(post["excerpt"])}</p></article>'

    def category_navigation(selected=None):
        links = [f'<a href="/blog/"' + (' aria-current="page"' if selected is None else '') + f'>全部文章 <span>{len(posts)}</span></a>']
        for cid, category in categories.items():
            count = sum(cid in p["categories"] for p in posts)
            if count:
                current = ' aria-current="page"' if selected == cid else ""
                links.append(f'<a href="{category_route(cid)}"{current}>{escape(category["name"])} <span>{count}</span></a>')
        return '<nav class="category-nav" aria-label="文章分类">' + "".join(links) + '</nav>'

    def historical_pages():
        if not pages:
            return ""
        links = "".join(f'<li><a href="{p["route"]}">{escape(p["title"])}</a></li>' for p in pages)
        return '<nav class="historical-pages" aria-label="旧站历史页面"><span>旧站历史页</span><ul class="historical-pages-list">' + links + '</ul></nav>'

    def search_list(items, all_tags=False):
        count = len(items)
        search = '<form class="search-form" role="search" hidden><label for="blog-search">查找文章</label><input id="blog-search" type="search" aria-label="搜索文章" placeholder="搜索标题、摘要或标签" autocomplete="off"><button id="clear-search" type="button">清空</button></form>'
        active_tag = '<p class="active-tag-filter" hidden><span data-active-tag></span> <button type="button" data-clear-tag>清除标签</button></p>' if all_tags else ""
        tag_filter = ' data-tag-filter="all"' if all_tags else ""
        return search + active_tag + f'<p id="search-count" aria-live="polite">{count} 篇文章</p><div class="post-list"{tag_filter}>' + "".join(card(p) for p in items) + '</div><p id="no-results" hidden>没有找到匹配的文章。</p>'

    for post in documents:
        root = post["tree"]
        for n in walk(root):
            if isinstance(n, Math):
                n.rendered = formulas[(n.tex, n.display)]
        headings = post["headings"]
        toc = ""
        if headings:
            # Heading text can contain source links; a contents entry has only its local anchor.
            toc_items = "".join(f'<li class="toc-level-{h.tag[1]}"><a href="#{h.attrs["id"]}">' + "".join(serialize(c, post, routes, media, in_toc=True) for c in h.children) + '</a></li>' for h in headings)
            toc = f'<details class="article-toc"{" open" if len(headings) <= 10 else ""}><summary>本文目录（{len(headings)} 节）</summary><ol>{toc_items}</ol></details>'
        navigation = []
        if post["type"] == "post":
            index = posts.index(post)
            if index > 0:
                prev = posts[index - 1]
                navigation.append(f'<a class="rel-prev" rel="prev" href="{prev["route"]}"><span>较新一篇</span>{escape(prev["title"])}</a>')
            if index + 1 < len(posts):
                nxt = posts[index + 1]
                navigation.append(f'<a class="rel-next" rel="next" href="{nxt["route"]}"><span>较早一篇</span>{escape(nxt["title"])}</a>')
        navigation.append('<a class="all-posts" href="/blog/">返回全部文章</a>')
        body_html = serialize(root, post, routes, media)
        image_credit = ''
        if any(isinstance(n, Element) and n.tag == 'img' and n.attrs['src'].startswith('https://oiwiki.org/') for n in walk(root)):
            image_credit = '<span class="image-credit">插图：<a href="https://oi-wiki.org/geometry/convex-hull/" target="_blank" rel="noopener noreferrer">OI Wiki 项目组</a>（<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a> / <a href="https://github.com/zTrix/sata-license">SATA</a>），原图未修改。</span>'
        history_note = '<aside class="historical-note">这是旧站的历史页面，内容保留原站历次更新。当前个人信息请以<a href="/">主页</a>为准。</aside>' if post["type"] == "page" else ""
        source_tags = '<p class="source-tags">原站标签：' + "、".join(f'<a data-source-tag="{tid}" href="/blog/tags/{tid}/">{escape(tags[tid]["name"])}</a>' for tid in post.get("tags", [])) + '</p>' if post.get("tags") else ""
        body = f'<article class="post"><a class="back-link" href="/blog/">← 全部文章</a><header class="article-header"><h1>{escape(post["title"])}</h1>{metadata(post)}</header>{history_note}{toc}<div class="prose">{body_html}</div><p class="source-note">本文迁自 <a href="{escape(post["link"])}" target="_blank" rel="noopener noreferrer">xht37 的旧博客原文</a>，保留原始内容与发布日期。{image_credit}</p>{source_tags}<nav class="post-navigation" aria-label="相邻文章">{"".join(navigation)}</nav></article>'
        rendered_comments = {}
        for comment in comments["by_post"][post["id"]]:
            comment_root = comment_trees[comment["id"]]
            for node in walk(comment_root):
                if isinstance(node, Math):
                    node.rendered = formulas[(node.tex, node.display)]
            rendered_comments[comment["id"]] = serialize(comment_root, post, routes, media)
        body += comments_section(post["id"], comments["by_post"][post["id"]], rendered_comments, features["comments"])
        math_count = sum(isinstance(n, Math) for n in walk(root))
        has_comment_math = any(isinstance(node, Math) for comment in comments["by_post"][post["id"]] for node in walk(comment_trees[comment["id"]]))
        write(post["route"], page(post["title"], post["excerpt"], post["route"], body, has_math=math_count > 0 or has_comment_math, features=features, document_id=post["id"]))
        report["posts" if post["type"] == "post" else "pages"].append({"id": post["id"], "type": post["type"], "categories": post["categories"], "tags": post.get("tags", []), "title": post["title"], "date": post["date"], "path": post["route"], "original_url": post["link"], "source_file": post["source_file"], "source_sha256": post["source_sha256"], "content_sha256": post["content_sha256"], "formulas": math_count, "code_blocks": sum(isinstance(n, Element) and n.tag == "pre" for n in walk(root)), "headings": len(headings), "images": sum(isinstance(n, Element) and n.tag == "img" for n in walk(root)), "legacy_anchors": {alias: h.attrs["id"] for h in headings for alias in h.attrs.get("_aliases", [])}})
    body = '<section class="page-intro"><p class="eyebrow">BLOG</p><h1>文章与记录</h1><p>留下一些想明白的事。</p></section>' + category_navigation() + historical_pages() + tag_cloud(used_tags, collapsed=True) + search_list(posts, all_tags=True)
    write("/blog/", page("博客", "徐皓天的算法、数学、学习笔记与生活记录。", "/blog/", body, features=features))
    years = {}
    for post in posts:
        years.setdefault(post["date"][:4], []).append(post)
    archive = f'<section class="page-intro"><p class="eyebrow">ARCHIVE</p><h1>文章归档</h1><p>{len(posts)} 篇文章，按原始发布日期排列。</p></section>' + category_navigation() + historical_pages()
    for year, items in years.items():
        archive += f'<section class="archive-year"><h2>{year}</h2><ul class="archive-list">' + "".join(f'<li><time datetime="{p["date"]}+08:00">{p["date"][5:10]}</time><a href="{p["route"]}">{escape(p["title"])}</a></li>' for p in items) + '</ul></section>'
    write("/blog/archive/", page("文章归档", "按原始发布日期排列的公开文章。", "/blog/archive/", archive, active="归档", features=features))
    for cid, category in categories.items():
        items = [post for post in posts if cid in post["categories"]]
        if not items:
            continue
        route = category_route(cid)
        body = f'<section class="page-intro"><p class="eyebrow">CATEGORY</p><h1>{escape(category["name"])}</h1><p>{len(items)} 篇文章，按原始发布日期排列。</p></section>' + category_navigation(cid) + search_list(items)
        write(route, page(category["name"], f'{category["name"]}分类的全部公开文章。', route, body, features=features))
        report["categories"].append({"id": cid, "name": category["name"], "path": route, "count": len(items)})
    body = f'<section class="page-intro"><p class="eyebrow">TAGS</p><h1>标签</h1><p>{len(used_tags)} 个原站标签，按文章数显示。</p></section>' + tag_cloud(used_tags)
    write("/blog/tags/", page("标签", "按原站标签浏览全部公开文章。", "/blog/tags/", body, active="标签", features=features))
    for tag in used_tags:
        items = [post for post in posts if tag["id"] in post.get("tags", [])]
        body = f'<section class="page-intro"><p class="eyebrow">TAG</p><h1>{escape(tag["name"])}</h1><p>{len(items)} 篇文章，按原始发布日期排列。</p><p><a href="/blog/tags/">全部标签</a></p></section>' + search_list(items)
        write(tag["path"], page(tag["name"], f'{tag["name"]}标签的全部公开文章。', tag["path"], body, active="标签", features=features))
    body = '<section class="page-intro"><p class="eyebrow">FRIENDS</p><h1>友情链接</h1><p>保留旧站友链名单及原有顺序。</p></section>' + friend_list(friends)
    write("/blog/friends/", page("友情链接", "旧博客的友情链接。", "/blog/friends/", body, active="友链", features=features))
    admin_result = subprocess.run(
        ["node", str(ROOT / "tools/render_comment_admin.mjs")],
        input=json.dumps({"api_base": features["comments"]["api_base"]}),
        text=True, encoding="utf-8", capture_output=True, check=True,
    )
    admin_assets = json.loads(admin_result.stdout)
    if set(admin_assets) != {"html", "script", "style"} or not all(isinstance(value, str) and value for value in admin_assets.values()):
        raise ValueError("Comment admin renderer returned invalid assets")
    write("/blog/comment/", admin_assets["html"])
    admin_directory = ROOT / "blog/comment"
    for filename, key in (("admin.js", "script"), ("admin.css", "style")):
        with (admin_directory / filename).open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(admin_assets[key])
    report["comment_admin"] = {
        "path": "/blog/comment/", "api_base": features["comments"]["api_base"],
        "script": "/blog/comment/admin.js", "style": "/blog/comment/admin.css",
        "source_sha256": {
            path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in [ROOT / "tools/render_comment_admin.mjs", *sorted((ROOT / "services/blog-api/src").glob("admin*.mjs"))]
        },
        "asset_sha256": {
            path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(admin_directory.iterdir()) if path.is_file()
        },
    }
    report["totals"] = {key: sum(p[key] for p in report["posts"] + report["pages"]) for key in ["formulas", "code_blocks", "headings", "images"]}
    (ROOT / "migration/public-batch.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"posts": len(posts), "pages": len(pages), "categories": len(report["categories"]), "unique_formulas": len(formulas), **report["totals"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
