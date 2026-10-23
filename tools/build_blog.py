"""Build the approved public blog batch from its checked, anonymous snapshot.

Python 3.9+ and Node.js; no network, cookies, package install or deployment.
"""
import hashlib
import html
import json
import re
import subprocess
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "migration/sources/notes-2026-10-23.json"
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
    if not isinstance(node, Element) or node.tag in {"pre", "code"}:
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


def serialize(node, post, routes, media):
    if isinstance(node, str):
        return html.escape(node, quote=False)
    if isinstance(node, Math):
        cls = "math-block" if node.display else "math-inline"
        return f'<span class="{cls}" data-original-math="{escape(node.original)}">{node.rendered}</span>'
    tag, attrs = node.tag, {}
    if tag == "root":
        return "".join(serialize(ch, post, routes, media) for ch in node.children)
    if "id" in node.attrs:
        attrs["id"] = node.attrs["id"]
    if tag == "a":
        url = safe_url(node.attrs.get("href", ""))
        parts = urlsplit(url)
        if parts.hostname in {"www.xht37.com", "xht37.com"} and normal_path(url) in routes:
            url = routes[normal_path(url)] + ("#" + parts.fragment if parts.fragment else "")
        attrs["href"] = url
        if url.startswith(("https:", "http:")):
            attrs.update(target="_blank", rel="noopener noreferrer")
    if tag == "img":
        url = node.attrs["src"]
        if url not in media:
            raise ValueError("Image has not been saved locally: " + url)
        attrs.update(src=media[url]["path"], alt=node.attrs.get("alt") or post["title"] + "：原文插图", loading="lazy", decoding="async")
    if tag == "code":
        classes = re.findall(r"language-[\w+-]+", node.attrs.get("class", ""))
        if classes:
            attrs["class"] = classes[0]
    if tag == "pre":
        attrs["tabindex"] = "0"
    if tag in {"td", "th"} and node.attrs.get("align") in {"left", "center", "right"}:
        attrs["class"] = "align-" + node.attrs["align"]
    rendered_attrs = "".join(f' {key}="{escape(value)}"' for key, value in attrs.items())
    rendered = f"<{tag}{rendered_attrs}>"
    if tag not in VOID:
        rendered += "".join(serialize(ch, post, routes, media) for ch in node.children) + f"</{tag}>"
    if tag == "table":
        rendered = '<div class="table-scroll" tabindex="0">' + rendered + "</div>"
    return rendered


def display_date(value):
    year, month, day = map(int, value[:10].split("-"))
    return f"{year} 年 {month} 月 {day} 日"


def header(active="博客"):
    nav = []
    for label, url in [("主页", "/"), ("博客", "/blog/"), ("归档", "/blog/archive/"), ("旧站 ↗", "https://www.xht37.com/")]:
        attrs = ' aria-current="page"' if label == active else ""
        if url.startswith("https:"):
            attrs += ' target="_blank" rel="noopener noreferrer"'
        nav.append(f'<a href="{url}"{attrs}>{label}</a>')
    return '<a class="skip-link" href="#main">跳到正文</a><header class="site-header"><div class="site-width"><a class="identity" href="/"><img src="/assets/x-script-icon.svg" alt="" width="25" height="25"><span>徐皓天 <span class="identity-note">/ 博客</span></span></a><nav class="site-nav" aria-label="主导航">' + "".join(nav) + '</nav></div></header>'


def page(title, description, route, body, active="博客", has_math=False):
    math_css = '<link rel="stylesheet" href="/assets/vendor/katex/katex.min.css">' if has_math else ""
    return f'''<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><meta name="theme-color" content="#fcfbf8">
<title>{escape(title)} · 徐皓天</title><meta name="description" content="{escape(description)}">
<link rel="canonical" href="https://pku-xht.github.io{route}">
<meta property="og:title" content="{escape(title)} · 徐皓天"><meta property="og:description" content="{escape(description)}">
<meta property="og:type" content="{'article' if has_math or route.startswith('/blog/posts/') else 'website'}"><meta property="og:url" content="https://pku-xht.github.io{route}">
<link rel="icon" href="/assets/favicon.svg?v=2" type="image/svg+xml">
<link rel="stylesheet" href="/blog/blog.css?v=1">{math_css}<script defer src="/blog/blog.js?v=1"></script>
</head><body class="blog-page">{header(active)}
<main class="site-width" id="main">{body}</main>
<footer class="site-footer"><div class="site-width">徐皓天 · xht37</div></footer>
</body></html>
'''


def write(route, content):
    path = ROOT / route.lstrip("/") / "index.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def main():
    batch = json.loads(SOURCE.read_text(encoding="utf-8"))
    posts = batch["posts"]
    summaries = json.loads((ROOT / "migration/sources/note-summaries.json").read_text(encoding="utf-8"))
    assert len(posts) == len({p["id"] for p in posts}) == batch["count"] == 29
    media_list = json.loads((ROOT / "migration/sources/media.json").read_text(encoding="utf-8"))
    media = {m["original_url"]: m for m in media_list}
    for item in media_list:
        assert hashlib.sha256((ROOT / item["path"].lstrip("/")).read_bytes()).hexdigest() == item["sha256"]
    routes = {normal_path(p["link"]): f'/blog/posts/{p["id"]}/' for p in posts}
    formulas = {}
    for post in posts:
        assert post["status"] == "publish" and not post["protected"] and 13 in post["categories"]
        assert hashlib.sha256(post["content_html"].encode()).hexdigest() == post["content_sha256"]
        post["title"] = html.unescape(post["title"])
        post["route"] = routes[normal_path(post["link"])]
        root = parse(post["content_html"])
        paragraphs = [text(n).strip() for n in walk(root) if isinstance(n, Element) and n.tag == "p" and text(n).strip()]
        excerpt = paragraphs[0] if paragraphs else post["title"]
        excerpt = re.sub(r"\$\$.*?\$\$", " ", excerpt, flags=re.S)
        excerpt = re.sub(r"\s+", " ", excerpt).replace("$", "")
        excerpt = re.sub(r"\\(?:mathcal|mathrm|operatorname|text)\s*", "", excerpt)
        symbols = {"le": "≤", "leq": "≤", "ge": "≥", "geq": "≥", "times": "×"}
        excerpt = re.sub(r"\\(leq|geq|le|ge|times)(?![A-Za-z])", lambda m: symbols[m.group(1)], excerpt)
        post["excerpt"] = summaries.get(str(post["id"]), excerpt[:140] + ("…" if len(excerpt) > 140 else ""))
        prepare_math(root, post["id"])
        headings = [n for n in walk(root) if isinstance(n, Element) and re.fullmatch(r"h[1-6]", n.tag)]
        if headings:
            shift = 2 - min(int(n.tag[1]) for n in headings)
            for i, heading in enumerate(headings, 1):
                heading.tag = "h" + str(min(6, int(heading.tag[1]) + shift))
                heading.attrs["id"] = f"section-{i}"
        post["headings"] = headings
        post["tree"] = root
        for n in walk(root):
            if isinstance(n, Math):
                formulas[(n.tex, n.display)] = None
    keys = list(formulas)
    result = subprocess.run(["node", str(ROOT / "tools/render_math.cjs")], input=json.dumps([{"tex": k[0], "display": k[1]} for k in keys]), text=True, encoding="utf-8", capture_output=True, check=True)
    rendered = json.loads(result.stdout)
    errors = [(keys[i], row["error"]) for i, row in enumerate(rendered) if "error" in row]
    if errors:
        for key, error in errors:
            print(repr(key), error)
        raise ValueError(f"{len(errors)} unique TeX expressions failed")
    formulas = {key: row["html"] for key, row in zip(keys, rendered)}
    report = {"batch": "public-notes-2026-10-23", "design": "C", "publication": "local-only", "posts": []}
    cards = []
    for index, post in enumerate(posts):
        root = post["tree"]
        for n in walk(root):
            if isinstance(n, Math):
                n.rendered = formulas[(n.tex, n.display)]
        headings = post["headings"]
        toc = ""
        if headings:
            toc_items = "".join(f'<li class="toc-level-{h.tag[1]}"><a href="#{h.attrs["id"]}">' + "".join(serialize(c, post, routes, media) for c in h.children) + '</a></li>' for h in headings)
            toc = f'<details class="article-toc"{" open" if len(headings) <= 10 else ""}><summary>本文目录（{len(headings)} 节）</summary><ol>{toc_items}</ol></details>'
        modified = "" if post["date"][:10] == post["modified"][:10] else f'<span>更新于 {display_date(post["modified"])}</span>'
        meta = f'<p class="post-meta"><time datetime="{post["date"]}+08:00">{display_date(post["date"])}</time><span>笔记</span>{modified}</p>'
        navigation = []
        if index > 0:
            prev = posts[index - 1]
            navigation.append(f'<a class="rel-prev" rel="prev" href="{prev["route"]}"><span>较新一篇</span>{escape(prev["title"])}</a>')
        if index + 1 < len(posts):
            nxt = posts[index + 1]
            navigation.append(f'<a class="rel-next" rel="next" href="{nxt["route"]}"><span>较早一篇</span>{escape(nxt["title"])}</a>')
        body_html = serialize(root, post, routes, media)
        image_credit = ''
        if any(isinstance(n, Element) and n.tag == 'img' and n.attrs['src'].startswith('https://oiwiki.org/') for n in walk(root)):
            image_credit = '<span class="image-credit">插图：<a href="https://oi-wiki.org/geometry/convex-hull/" target="_blank" rel="noopener noreferrer">OI Wiki 项目组</a>（<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a> / <a href="https://github.com/zTrix/sata-license">SATA</a>），原图未修改。</span>'
        body = f'<article class="post"><a class="back-link" href="/blog/">← 全部文章</a><header class="article-header"><h1>{escape(post["title"])}</h1>{meta}</header>{toc}<div class="prose">{body_html}</div><p class="source-note">本文迁自 <a href="{escape(post["link"])}" target="_blank" rel="noopener noreferrer">xht37 的旧博客原文</a>，保留原始内容与发布日期。{image_credit}</p><nav class="post-navigation" aria-label="相邻文章">{"".join(navigation)}</nav></article>'
        math_count = sum(isinstance(n, Math) for n in walk(root))
        write(post["route"], page(post["title"], post["excerpt"], post["route"], body, has_math=math_count > 0))
        cards.append(f'<article class="post-card" data-search="{escape(post["title"] + " " + post["excerpt"] + " 笔记")}"><h2><a href="{post["route"]}">{escape(post["title"])}</a></h2>{meta}<p class="post-excerpt">{escape(post["excerpt"])}</p></article>')
        report["posts"].append({"id": post["id"], "title": post["title"], "date": post["date"], "path": post["route"], "original_url": post["link"], "source_sha256": post["content_sha256"], "formulas": math_count, "code_blocks": sum(isinstance(n, Element) and n.tag == "pre" for n in walk(root)), "headings": len(headings), "images": sum(isinstance(n, Element) and n.tag == "img" for n in walk(root))})
    search = '<form class="search-form" role="search" hidden><label for="blog-search">查找文章</label><input id="blog-search" type="search" aria-label="搜索文章" placeholder="搜索标题或摘要" autocomplete="off"><button id="clear-search" type="button">清空</button></form><p id="search-count" aria-live="polite">29 篇笔记</p>'
    body = '<section class="page-intro"><p class="eyebrow">BLOG / NOTES</p><h1>文章与记录</h1><p>留下一些想明白的事。</p></section>' + search + '<div class="post-list">' + "".join(cards) + '</div><p id="no-results" hidden>没有找到匹配的文章。</p>'
    write("/blog/", page("博客", "徐皓天的算法、数学与学习笔记。", "/blog/", body))
    years = {}
    for post in posts:
        years.setdefault(post["date"][:4], []).append(post)
    archive = '<section class="page-intro"><p class="eyebrow">ARCHIVE</p><h1>文章归档</h1><p>29 篇笔记，按原始发布日期排列。</p></section>'
    for year, items in years.items():
        archive += f'<section class="archive-year"><h2>{year}</h2><ul class="archive-list">' + "".join(f'<li><time datetime="{p["date"]}+08:00">{p["date"][5:10]}</time><a href="{p["route"]}">{escape(p["title"])}</a></li>' for p in items) + '</ul></section>'
    write("/blog/archive/", page("文章归档", "按原始发布日期排列的公开文章。", "/blog/archive/", archive, active="归档"))
    report["totals"] = {key: sum(p[key] for p in report["posts"]) for key in ["formulas", "code_blocks", "headings", "images"]}
    (ROOT / "migration/notes-batch1.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"posts": len(posts), "unique_formulas": len(formulas), **report["totals"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
