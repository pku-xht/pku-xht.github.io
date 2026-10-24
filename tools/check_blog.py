"""Check Markdown sources against generated pages and optionally their original archive.

This checker deliberately does not import the generator: the source HTML, routes,
indexes, media bytes and generated report are checked against one another here.
The opt-in archive comparison reads immutable WordPress HTML independently of the
Markdown renderer, so a shared rendering bug cannot establish migration fidelity.
"""
import argparse
import hashlib
import html
import json
import re
from collections import Counter, defaultdict
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
VOID = set("area base br col embed hr img input link meta param source track wbr".split())
TARGET_IDS = {}
OLD_HOSTS = {"www.xht37.com", "xht37.com"}
STRUCTURAL_TAGS = set("p strong em b i u s del ul ol li a code pre blockquote hr img table thead tbody tr th td sup sub".split())
COMMENT_FIELDS = set("id post parent author_name author_url date date_gmt content link type status".split())
COMMENT_TAGS = set("p br strong em b i u s del a code pre blockquote ul ol li dl dt dd hr table thead tbody tr th td sup sub span div abbr acronym q cite h1 h2 h3 h4 h5 h6".split())


class Node:
    def __init__(self, tag, attrs=None):
        self.tag, self.attrs, self.children = tag, dict(attrs or []), []


class Document(HTMLParser):
    def __init__(self, value):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]
        self.feed(value)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

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


def nodes(node):
    if isinstance(node, Node):
        yield node
        for child in node.children:
            yield from nodes(child)


def content(node, original_math=False):
    if isinstance(node, str):
        return node
    if original_math and "data-original-math" in node.attrs:
        return node.attrs["data-original-math"]
    if node.tag == "br":
        return "\n"
    return "".join(content(ch, original_math) for ch in node.children)


def canonical(node, original_math=False):
    return " ".join(content(node, original_math).split())


def has_class(node, name):
    return name in node.attrs.get("class", "").split()


def semantic_nodes(node):
    """Exclude generated formula markup when comparing source HTML structure."""
    if isinstance(node, Node):
        if "data-original-math" in node.attrs:
            return
        yield node
        for child in node.children:
            yield from semantic_nodes(child)


def structural_tags(node):
    if isinstance(node, str) or "data-original-math" in node.attrs:
        return []
    tag = "heading" if re.fullmatch(r"h[1-6]", node.tag) else node.tag
    kept = node.tag in STRUCTURAL_TAGS or tag == "heading"
    result = [tag] if kept else []
    for child in node.children:
        result.extend(structural_tags(child))
    if kept and node.tag not in VOID:
        result.append("/" + tag)
    return result


def original_formulas(node):
    """Read dollar-delimited source formulas without inspecting rendered output."""
    if isinstance(node, str) or node.tag in {"pre", "code"}:
        return []
    result, run = [], []

    def collect():
        value = "".join(run)
        result.extend(m.group(0) for m in re.finditer(r"(?<!\\)(\$\$|\$).*?(?<!\\)\1", value, re.S))
        run.clear()

    for child in node.children:
        if isinstance(child, str):
            run.append(child)
        elif child.tag == "br":
            run.append("\n")
        else:
            collect()
            result.extend(original_formulas(child))
    collect()
    return result


def source_document(source):
    document = Document(source["content_html"]).root
    first = next((n for n in document.children if isinstance(n, Node)), None)
    if first and first.tag == "p" and re.fullmatch(r"\s*Visits:\s*\d+\s*", content(first)):
        document.children.remove(first)
    return document


def route(source):
    return f'/blog/{"pages" if source.get("type") == "page" else "posts"}/{source["id"]}/'


def visible_date(value):
    date = datetime.fromisoformat(value)
    return f"{date.year} 年 {date.month} 月 {date.day} 日"


def normalized_path(url):
    return unquote(urlsplit(url).path).rstrip("/").lower()


def media_key(url):
    parts = urlsplit(url)
    if parts.hostname in OLD_HOSTS:
        return ("old-site", normalized_path(url))
    return (parts.netloc.lower(), unquote(parts.path), parts.query)


def expected_link(url, paths, by_id, media):
    parts = urlsplit(url)
    destination = None
    if media_key(url) in media:
        destination = media[media_key(url)]
    elif parts.hostname in OLD_HOSTS or (not parts.netloc and not parts.scheme and parts.path.startswith("/")):
        query = parse_qs(parts.query)
        for key in ("p", "page_id"):
            values = query.get(key, [])
            if len(values) == 1 and values[0].isdigit():
                destination = by_id.get(int(values[0]))
                if destination:
                    break
        destination = destination or paths.get(normalized_path(url))
        if parts.hostname in OLD_HOSTS and not parts.path.strip("/") and not parts.query:
            destination = "/blog/"
    return destination + ("#" + parts.fragment if parts.fragment else "") if destination else url


def check_local_url(url, current):
    parts = urlsplit(url)
    if parts.scheme or parts.netloc:
        return
    path = unquote(parts.path)
    target = ROOT / path.lstrip("/") if path.startswith("/") else current.parent / path
    if not path:
        target = current
    if target.is_dir():
        target /= "index.html"
    target = target.resolve()
    assert ROOT == target or ROOT in target.parents, (current, url, "local target escapes repository")
    assert target.is_file(), (current, url, "missing local target")
    if parts.fragment and target.suffix.lower() in {".html", ".htm", ".svg"}:
        if target not in TARGET_IDS:
            doc = Document(target.read_text(encoding="utf-8"))
            TARGET_IDS[target] = {n.attrs["id"] for n in nodes(doc.root) if "id" in n.attrs}
        assert unquote(parts.fragment) in TARGET_IDS[target], (current, url, "missing fragment")


def read_document(path):
    return Document(path.read_text(encoding="utf-8")).root


def assert_routes(actual, expected, label):
    assert Counter(actual) == Counter(expected), (label, "missing, duplicate or unexpected entries", Counter(expected) - Counter(actual), Counter(actual) - Counter(expected))
    assert len(actual) == len(set(actual)), (label, "duplicate entries")


def check_cards(document, sources, label, tags):
    cards = [n for n in nodes(document) if has_class(n, "post-card")]
    actual = []
    expected = {route(p): p for p in sources}
    for card in cards:
        headings = [n for n in nodes(card) if n.tag == "h2"]
        assert len(headings) == 1, (label, "card needs one title")
        links = [n for n in nodes(headings[0]) if n.tag == "a"]
        assert len(links) == 1, (label, "card title needs one link")
        destination = links[0].attrs.get("href")
        assert destination in expected, (label, destination, "unexpected card")
        source = expected[destination]
        assert canonical(links[0]) == " ".join(source["title"].split()), (label, source["id"], "card title changed")
        times = [n for n in nodes(card) if n.tag == "time"]
        assert len(times) == 1 and times[0].attrs.get("datetime") == source["date"] + "+08:00", (label, source["id"], "card date changed")
        assert canonical(times[0]) == visible_date(source["date"]), (label, source["id"], "visible card date changed")
        searchable = card.attrs.get("data-search", "")
        selected_tags = card.attrs.get("data-tags", "").split()
        assert selected_tags == [str(tag_id) for tag_id in source.get("tags", [])], (label, source["id"], "card tag IDs changed")
        for tag_id in source.get("tags", []):
            assert tags[tag_id]["name"] in searchable, (label, source["id"], tag_id, "original tag absent from search index")
        actual.append(destination)
    assert_routes(actual, list(expected), label)
    assert actual == [route(p) for p in sources], (label, "source chronological order changed")


def check_tag_cloud(document, tags, posts, label, folded=False):
    used = {tag_id for post in posts for tag_id in post["tags"]}
    largest = max((sum(identifier in post["tags"] for post in posts) for identifier in used), default=1)
    links = [node for node in nodes(document) if node.tag == "a" and "data-tag-id" in node.attrs]
    actual = []
    for link in links:
        identifier = link.attrs["data-tag-id"]
        assert identifier.isdigit() and int(identifier) in used, (label, identifier, "unexpected tag")
        identifier = int(identifier)
        count = sum(identifier in post["tags"] for post in posts)
        assert link.attrs.get("href") == f"/blog/tags/{identifier}/", (label, identifier, "tag route changed")
        assert link.attrs.get("data-tag-name") == tags[identifier]["name"], (label, identifier, "tag name changed")
        assert link.attrs.get("data-tag-count") == str(count), (label, identifier, "tag article count changed")
        assert tags[identifier]["name"] in content(link), (label, identifier, "visible tag label missing")
        expected_weight = "tag-weight-" + str(1 + round(4 * (count - 1) / max(1, largest - 1)))
        assert [name for name in link.attrs.get("class", "").split() if re.fullmatch(r"tag-weight-[1-5]", name)] == [expected_weight], (label, identifier, "tag weight differs from article count")
        visible_counts = [node for node in nodes(link) if has_class(node, "tag-count")]
        assert len(visible_counts) == 1 and content(visible_counts[0]) == str(count), (label, identifier, "visible tag count changed")
        actual.append(identifier)
    assert_routes(actual, list(used), label)
    if folded:
        details = [node for node in nodes(document) if node.tag == "details" and any("data-tag-id" in child.attrs for child in nodes(node))]
        assert len(details) == 1 and "open" not in details[0].attrs, (label, "homepage tag cloud must start collapsed")


def check_friends_page(document, friends):
    areas = [node for node in nodes(document) if has_class(node, "friend-links")]
    assert len(areas) == 1, "missing or duplicate friend-links section"
    lists = [node for node in nodes(areas[0]) if node.tag == "ul" and has_class(node, "friend-list")]
    assert len(lists) == 1, "friends page needs one friend-list"
    links = [node for node in nodes(lists[0]) if node.tag == "a" and has_class(node, "friend-name")]
    assert [(content(link), link.attrs.get("href")) for link in links] == [(friend["name"], friend["url"]) for friend in friends], "friend names, URLs or original order changed"
    for link in links:
        assert link.attrs.get("target") == "_blank" and {"noopener", "noreferrer"} <= set(link.attrs.get("rel", "").split()), "friend link missing safe external-link attributes"


def safe_comment_url(value, author=False):
    assert isinstance(value, str) and not any(char.isspace() or ord(char) < 32 for char in value) and "\\" not in value, ("comment", "unsafe URL", value)
    if not value and author:
        return
    parsed = urlsplit(value)
    assert not parsed.username and not parsed.password, ("comment", "URL credentials are not public metadata")
    if author:
        assert parsed.scheme in {"http", "https"} and parsed.hostname, ("comment", "unsafe author URL")
    else:
        assert parsed.scheme in {"http", "https", ""}, ("comment", "unsafe body URL")
        assert (parsed.hostname if parsed.scheme else not parsed.netloc and value.startswith(("#", "/"))), ("comment", "unresolved or protocol-relative URL")


def check_comment_html(document, identifier, rendered=False):
    """Inspect source or semantic generated HTML independently of sanitization."""
    if rendered:
        for node in nodes(document):
            if "data-original-math" in node.attrs:
                assert node.tag == "span" and set(node.attrs) == {"class", "data-original-math"} and node.attrs["class"] in {"math-block", "math-inline"}, (identifier, "unexpected generated math wrapper")
    for node in (semantic_nodes(document) if rendered else nodes(document)):
        if node is document:
            continue
        assert node.tag in COMMENT_TAGS, (identifier, node.tag, "unsafe historical comment element")
        allowed = {"a": {"href", "title", "target", "rel"}, "code": {"class"}, "pre": {"tabindex"}, "ol": {"start"}, "td": {"align", "class", "rowspan", "colspan"}, "th": {"align", "class", "rowspan", "colspan"}, "abbr": {"title"}, "acronym": {"title"}, "q": {"title"}, "blockquote": {"title"}, "div": {"class", "tabindex"}}.get(node.tag, set())
        assert set(node.attrs) <= allowed, (identifier, node.tag, set(node.attrs) - allowed, "unexpected or private comment attributes")
        if node.tag == "a":
            safe_comment_url(node.attrs.get("href", ""))
        if node.tag == "code" and node.attrs.get("class"):
            assert re.fullmatch(r"language-[\w+-]+", node.attrs["class"]), (identifier, "unsafe code class")
        if node.tag == "div" and node.attrs:
            assert node.attrs == {"class": "table-scroll", "tabindex": "0"}, (identifier, "unsafe comment wrapper attributes")


def comment_preorder(comments):
    children = defaultdict(list)
    by_id = {comment["id"]: comment for comment in comments}
    assert len(by_id) == len(comments), "duplicate public comment ID"
    for comment in comments:
        assert not comment["parent"] or comment["parent"] in by_id, (comment["id"], "unresolved parent comment")
        children[comment["parent"]].append(comment)
    ordered, seen = [], set()

    def visit(parent):
        for comment in children[parent]:
            assert comment["id"] not in seen, "cyclic comment parent relation"
            seen.add(comment["id"])
            ordered.append(comment)
            visit(comment["id"])

    visit(0)
    assert len(ordered) == len(comments), "unreachable or cyclic public comments"
    return ordered


def check_comment_records(comments, post_id):
    for comment in comments:
        identifier = comment.get("id")
        assert set(comment) == COMMENT_FIELDS, (identifier, "unexpected/private comment metadata fields")
        assert type(identifier) is int and identifier > 0 and comment["post"] == post_id
        assert type(comment["parent"]) is int and comment["parent"] >= 0
        assert isinstance(comment["author_name"], str)
        safe_comment_url(comment["author_url"], author=True)
        safe_comment_url(comment["link"])
        assert isinstance(comment["content"], dict) and set(comment["content"]) == {"rendered"} and isinstance(comment["content"]["rendered"], str), (identifier, "unexpected/private comment body fields")
        assert comment["status"] == "approved" and comment["type"] in {"comment", "pingback", "trackback"}, (identifier, "unapproved or unexpected historical comment")
        assert (datetime.fromisoformat(comment["date"]) - datetime.fromisoformat(comment["date_gmt"])).total_seconds() == 28800, (identifier, "comment date timezone changed")
        check_comment_html(Document(comment["content"]["rendered"]).root, identifier)


def check_article_comments(document, source, comments, features, paths, by_id, media):
    sections = [node for node in nodes(document) if has_class(node, "historical-comments")]
    assert len(sections) == 1, (source["id"], "missing or duplicate historical comment section")
    section = sections[0]
    assert section.attrs.get("data-document-id") == str(source["id"]), (source["id"], "comment section document ID changed")
    assert section.attrs.get("data-comments-enabled") == str(features["comments"]["enabled"]).lower() and section.attrs.get("data-blog-api") == features["comments"]["api_base"], (source["id"], "rendered new-comment availability differs from formal configuration")
    prose = next(node for node in nodes(document) if has_class(node, "prose"))
    assert not any(node is section for node in nodes(prose)), (source["id"], "comments must stay outside article prose")
    rows = [node for node in nodes(section) if node.tag == "li" and "data-comment-id" in node.attrs]
    expected = comment_preorder(comments)
    assert [node.attrs.get("data-comment-id") for node in rows] == [f'wp-{comment["id"]}' for comment in expected], (source["id"], "historical comment count or thread order changed")
    parents = {}

    def collect(node, parent=""):
        if not isinstance(node, Node):
            return
        if "data-comment-id" in node.attrs:
            parents[node.attrs["data-comment-id"]] = parent
            parent = node.attrs["data-comment-id"]
        for child in node.children:
            collect(child, parent)

    collect(section)
    formulas = 0
    for row, comment in zip(rows, expected):
        identifier = comment["id"]
        parent = f'wp-{comment["parent"]}' if comment["parent"] else ""
        assert row.attrs.get("id") == f"comment-{identifier}" and row.attrs.get("data-parent-id") == parent and parents[f"wp-{identifier}"] == parent, (identifier, "comment parent relation or anchor changed")
        articles = [child for child in row.children if isinstance(child, Node) and has_class(child, "comment")]
        assert len(articles) == 1, (identifier, "comment row needs one article")
        article = articles[0]
        authors = [node for node in nodes(article) if has_class(node, "comment-author")]
        assert len(authors) == 1 and content(authors[0]) == comment["author_name"], (identifier, "comment author changed")
        assert authors[0].tag == ("a" if comment["author_url"] else "span"), (identifier, "comment author URL markup changed")
        if comment["author_url"]:
            assert authors[0].attrs.get("href") == comment["author_url"], (identifier, "comment author URL changed")
            assert {"noopener", "noreferrer"} <= set(authors[0].attrs.get("rel", "").split()), (identifier, "unsafe author link attributes")
        times = [node for node in nodes(article) if node.tag == "time"]
        assert len(times) == 1 and times[0].attrs.get("datetime") == comment["date"] + "+08:00", (identifier, "comment date changed")
        date = datetime.fromisoformat(comment["date"])
        assert date.strftime("%H:%M:%S") in content(times[0]) and visible_date(comment["date"]) in content(times[0]), (identifier, "full visible comment date changed")
        permalinks = [node for node in nodes(article) if has_class(node, "comment-permalink")]
        assert len(permalinks) == 1 and permalinks[0].attrs.get("href") == f"#comment-{identifier}", (identifier, "comment permalink changed")
        bodies = [node for node in nodes(article) if has_class(node, "comment-body")]
        assert len(bodies) == 1, (identifier, "missing or duplicate comment body")
        original, body = Document(comment["content"]["rendered"]).root, bodies[0]
        check_comment_html(body, identifier, rendered=True)
        assert canonical(original) == canonical(body, True), (identifier, "historical comment text or TeX changed")
        assert structural_tags(original) == structural_tags(body), (identifier, "historical comment structure changed")
        rendered_formulas = [node.attrs["data-original-math"] for node in nodes(body) if "data-original-math" in node.attrs]
        assert rendered_formulas == original_formulas(original), (identifier, "historical comment formula changed")
        assert not any(has_class(node, "katex-error") for node in nodes(body)), (identifier, "historical comment math failed")
        formulas += len(rendered_formulas)
        for tag in ("pre", "code"):
            assert [content(node) for node in nodes(original) if node.tag == tag] == [content(node) for node in nodes(body) if node.tag == tag], (identifier, "historical comment code bytes changed")
        before = [expected_link(node.attrs.get("href", ""), paths, by_id, media) for node in nodes(original) if node.tag == "a"]
        after = [node.attrs.get("href", "") for node in semantic_nodes(body) if node.tag == "a"]
        assert before == after, (identifier, "historical comment links changed")
    forms = [node for node in nodes(section) if node.tag == "form"]
    for form in forms:
        fields = [node for node in nodes(form) if node.tag in {"input", "textarea"}]
        assert all(node.attrs.get("name") in {"nickname", "body", "website"} and node.attrs.get("type") != "email" for node in fields), (source["id"], "new-comment form unexpectedly collects private fields")
    if not features["comments"]["enabled"]:
        for form in forms:
            submit = [node for node in nodes(form) if node.tag in {"button", "input"} and node.attrs.get("type", "submit" if node.tag == "button" else "text") == "submit"]
            assert submit and all("disabled" in node.attrs for node in submit), (source["id"], "unconfigured new comments must not accept submission")
        assert "未开放" in content(section) or "未启用" in content(section), (source["id"], "disabled new-comment state is not explained")
    return formulas


def check_history_links(document, sources, label):
    areas = [n for n in nodes(document) if has_class(n, "historical-pages-list")]
    links = [n.attrs.get("href") for area in areas for n in nodes(area) if n.tag == "a"]
    assert_routes(links, [route(p) for p in sources], label)


def check_archive(document, sources):
    expected = {route(p): p for p in sources}
    sections = [n for n in nodes(document) if has_class(n, "archive-year")]
    actual, years = [], []
    for section in sections:
        headings = [n for n in nodes(section) if n.tag == "h2"]
        assert len(headings) == 1, "archive year needs one heading"
        year = canonical(headings[0])
        years.append(year)
        lists = [n for n in nodes(section) if has_class(n, "archive-list")]
        assert len(lists) == 1, (year, "archive year needs one article list")
        for item in (n for n in nodes(lists[0]) if n.tag == "li"):
            links = [n for n in nodes(item) if n.tag == "a"]
            assert len(links) == 1, (year, "archive item needs one article link")
            destination = links[0].attrs.get("href")
            assert destination in expected, (destination, "unexpected archive item")
            source = expected[destination]
            assert canonical(links[0]) == " ".join(source["title"].split()), (source["id"], "archive title changed")
            times = [n for n in nodes(item) if n.tag == "time"]
            assert len(times) == 1 and times[0].attrs.get("datetime") == source["date"] + "+08:00", (source["id"], "archive date changed")
            assert canonical(times[0]) == source["date"][5:10] and year == source["date"][:4], (source["id"], "archive visible date changed")
            actual.append(destination)
    assert_routes(actual, list(expected), "archive")
    assert actual == [route(p) for p in sources], "archive chronological order changed"
    assert years == sorted({p["date"][:4] for p in sources}, reverse=True), "archive year missing, duplicate or reordered"


def assert_preserved_content(reference, current, media, paths=None, by_id=None):
    """Compare original HTML with the Markdown render without using exporter code."""
    before, after = source_document(reference), source_document(current)
    identifier = current["id"]
    assert canonical(before) == canonical(after), (identifier, "original snapshot: text changed during Markdown conversion")
    assert structural_tags(before) == structural_tags(after), (identifier, "original snapshot: nested structure changed")
    assert original_formulas(before) == original_formulas(after), (identifier, "original snapshot: TeX changed")
    for tag in ("pre", "code"):
        assert [content(n) for n in nodes(before) if n.tag == tag] == [content(n) for n in nodes(after) if n.tag == tag], (identifier, "original snapshot", tag, "code bytes changed")
    before_headings = [n for n in nodes(before) if re.fullmatch(r"h[1-6]", n.tag)]
    after_headings = [n for n in nodes(after) if re.fullmatch(r"h[1-6]", n.tag)]
    assert [(n.tag, canonical(n)) for n in before_headings] == [(n.tag, canonical(n)) for n in after_headings], (identifier, "original snapshot: heading hierarchy or text changed")
    for tag, attribute in (("img", "src"), ("a", "href")):
        original_urls = [expected_link(n.attrs.get(attribute, ""), paths or {}, by_id or {}, media) for n in nodes(before) if n.tag == tag]
        current_urls = [expected_link(n.attrs.get(attribute, ""), paths or {}, by_id or {}, media) for n in nodes(after) if n.tag == tag]
        assert original_urls == current_urls, (identifier, "original snapshot", attribute, "media or links changed")


def check_original_snapshot(batch, path, media):
    archive = json.loads(path.read_text(encoding="utf-8"))
    assert archive["visibility"] == "anonymous-public-only"
    old_sources = archive["posts"] + archive.get("pages", [])
    current_sources = batch["posts"] + batch.get("pages", [])
    current_by_id = {p["id"]: p for p in current_sources}
    assert {p["id"] for p in old_sources} == set(current_by_id), "original snapshot: document scope changed"
    paths = {normalized_path(p["link"]): route(p) for p in current_sources}
    by_id = {p["id"]: route(p) for p in current_sources}
    old_taxonomy = {key: {item["id"]: html.unescape(item["name"]) for item in archive[key]} for key in ("categories", "tags")}
    current_taxonomy = {key: {item["id"]: item["name"] for item in batch[key]} for key in ("categories", "tags")}
    old_resources = json.loads((path.parent / "media.json").read_text(encoding="utf-8"))
    current_resources = {item["original_url"]: item for item in batch["resources"]}
    assert {item["original_url"] for item in old_resources} == set(current_resources), "original snapshot: resource scope changed"
    for item in old_resources:
        for key in ("path", "sha256", "bytes"):
            assert item[key] == current_resources[item["original_url"]][key], (item["original_url"], "original snapshot: resource metadata changed", key)
    old_anchors = json.loads((path.parent / "legacy-anchors.json").read_text(encoding="utf-8"))
    assert old_anchors["visibility"] == "anonymous-public-only"
    for anchor in old_anchors["anchors"]:
        assert current_by_id[anchor["post_id"]].get("legacy_anchors", {}).get(anchor["fragment"]) == anchor["heading_text"], (anchor["post_id"], "original snapshot: verified anchor changed")
    for reference in old_sources:
        identifier = reference["id"]
        current = current_by_id[identifier]
        assert reference["status"] == "publish" and not reference["protected"]
        assert hashlib.sha256(reference["content_html"].encode()).hexdigest() == reference["content_sha256"]
        for key in ("type", "date", "date_gmt", "modified", "slug", "link"):
            assert current[key] == reference[key], (identifier, "original snapshot", key, "metadata changed")
        assert current["title"] == html.unescape(reference["title"]), (identifier, "original snapshot: title changed")
        for key in ("categories", "tags"):
            assert current[key] == reference[key], (identifier, "original snapshot", key, "assigned IDs changed")
            for item in reference[key]:
                assert current_taxonomy[key][item] == old_taxonomy[key][item], (identifier, "original snapshot", key, item, "name changed")
        assert_preserved_content(reference, current, media, paths, by_id)
    print(f"PASS: immutable original snapshot independently matches {len(old_sources)} Markdown documents")


def check_comment_source_files(batch, content_root, post_ids):
    """Read raw formal YAML independently of the comment loader/sanitizer."""
    from blog_sources import _yaml
    directory = content_root / "comments"
    index_path = directory / "index.yaml"
    index_bytes = index_path.read_bytes()
    index = _yaml(index_bytes.decode("utf-8"), index_path)
    assert isinstance(index, dict) and set(index) == {"version", "files", "count"} and type(index["version"]) is int and index["version"] == 1
    assert isinstance(index["files"], list) and len(index["files"]) == len(set(index["files"])), "duplicate comment source file"
    assert type(index["count"]) is int and index["count"] >= 0
    assert batch["index_file"] == "content/blog/comments/index.yaml" and batch["index_sha256"] == hashlib.sha256(index_bytes).hexdigest()
    expected, all_ids, files = {identifier: [] for identifier in post_ids}, set(), set()
    for member in index["files"]:
        assert isinstance(member, str) and re.fullmatch(r"[1-9]\d*\.yaml", member), "comment source must use a neighboring numeric filename"
        path = directory / member
        files.add(path)
        raw = path.read_bytes()
        value = _yaml(raw.decode("utf-8"), path)
        assert isinstance(value, dict) and set(value) == {"version", "post_id", "comments"} and type(value["version"]) is int and value["version"] == 1
        identifier = value["post_id"]
        assert type(identifier) is int and identifier in expected and path.name == f"{identifier}.yaml", "comment source document scope changed"
        comments = value["comments"]
        assert isinstance(comments, list) and comments, "empty comment files should not be registered"
        check_comment_records(comments, identifier)
        comment_preorder(comments)
        for comment in comments:
            assert comment["id"] not in all_ids, "comment ID duplicated across documents"
            all_ids.add(comment["id"])
        expected[identifier] = comments
        info = batch["sources"][identifier]
        assert info["source_file"] == f"content/blog/comments/{member}" and info["source_sha256"] == hashlib.sha256(raw).hexdigest() and info["count"] == len(comments), (identifier, "comment source metadata differs")
    assert set(directory.rglob("*.yaml")) == files | {index_path}, "unregistered or missing historical comment source"
    assert expected == batch["by_post"], "raw comment YAML differs from loaded public comments"
    assert index["count"] == len(all_ids) == batch["count"], "historical comment source total differs"
    assert set(batch["sources"]) == {identifier for identifier, comments in expected.items() if comments}


def check_original_comments(batch, path):
    archive = json.loads(path.read_text(encoding="utf-8"))
    assert archive["visibility"] == "approved-public-comments-for-migrated-content"
    assert set(archive["scope_post_ids"]) == set(batch["by_post"]), "original comments: migrated-document scope changed"
    archived = archive["comments"]
    assert len(archived) == archive["count"] == batch["count"] and len({comment["id"] for comment in archived}) == len(archived), "original comments: total or IDs changed"
    by_post = {identifier: [] for identifier in batch["by_post"]}
    for comment in archived:
        assert comment["post"] in by_post, "original comments: unknown migrated document"
        by_post[comment["post"]].append(comment)
    for identifier, comments in by_post.items():
        check_comment_records(comments, identifier)
        assert comments == batch["by_post"][identifier], (identifier, "original comments: fields, HTML, code, date or original order changed")
    print(f"PASS: immutable public comment snapshot independently matches {len(archived)} historical comments")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-snapshot", nargs="?", type=Path,
                        const=Path("migration/sources/public-2026-10-23.json"),
                        help="also compare Markdown with the immutable migration snapshot (optional JSON path)")
    args = parser.parse_args(argv)
    from blog_sources import load_blog
    from blog_comments import load_comments
    from blog_friends import load_friends
    from blog_interactions import load_features
    batch = load_blog(ROOT / "content/blog", project_root=ROOT)
    for group in ("posts", "pages"):
        batch[group] = sorted(batch[group], key=lambda source: (source["date"], source["id"]), reverse=True)
    TARGET_IDS.clear()
    report = json.loads((ROOT / "migration/public-batch.json").read_text(encoding="utf-8"))
    assert report["source_format"] == "markdown-yaml", "build report is not based on formal Markdown sources"
    assert report["publication"] == "local-only" and report["design"] == "C"
    posts, historical_pages = batch["posts"], batch.get("pages", [])
    sources = posts + historical_pages
    comments = load_comments(ROOT / "content/blog", post_ids=[source["id"] for source in sources], project_root=ROOT)
    features = load_features(ROOT / "content/blog/features.yaml")
    friends = load_friends(ROOT / "content/blog/friends.yaml")
    check_comment_source_files(comments, ROOT / "content/blog", [source["id"] for source in sources])
    assert not features["visits"]["enabled"], "Visits are disabled for this migration"
    assert report["features"] == {"comments_enabled": features["comments"]["enabled"], "visits_enabled": features["visits"]["enabled"]}, "build feature state differs from the formal configuration"
    assert report["comments"]["count"] == comments["count"] and report["comments"]["index_file"] == comments["index_file"] and report["comments"]["index_sha256"] == comments["index_sha256"]
    assert {int(key): value for key, value in report["comments"]["sources"].items()} == comments["sources"], "build comment-source report differs"
    assert report["comments"]["types"] == comments["types"], "build comment-type report differs"
    assert len(posts) == batch["count"]
    assert len(sources) == len({p["id"] for p in sources}), "duplicate source ID"
    assert [p["date"] for p in posts] == sorted((p["date"] for p in posts), reverse=True), "source posts are not chronological"
    for key, values in (("posts", posts), ("pages", historical_pages)):
        assert len(report[key]) == len({p["id"] for p in report[key]})
        assert {p["id"] for p in values} == {p["id"] for p in report[key]}, (key, "report scope differs")
    report_by_id = {p["id"]: p for p in report["posts"] + report["pages"]}
    category_by_id = {c["id"]: c for c in batch["categories"]}
    assert len(category_by_id) == len(batch["categories"]), "duplicate category ID"
    tags = {t["id"]: t for t in batch["tags"]}
    assert len(tags) == len(batch["tags"]), "duplicate source tag ID"
    explicit_aliases = {(p["id"], fragment): heading for p in sources for fragment, heading in p.get("legacy_anchors", {}).items()}
    media = batch["resources"]
    media_map = {m["original_url"]: m["path"] for m in media}
    assert len(media_map) == len(media), "duplicate media original URL"
    media_by_key = {}
    for item in media:
        key = media_key(item["original_url"])
        assert key not in media_by_key or media_by_key[key] == item["path"], (key, "ambiguous media aliases")
        media_by_key[key] = item["path"]
        media_by_key[media_key(item["path"])] = item["path"]
    paths = {normalized_path(p["link"]): route(p) for p in sources}
    assert len(paths) == len(sources), "duplicate original permalink"
    by_id = {p["id"]: route(p) for p in sources}
    by_route = {route(p): p for p in sources}
    alias_targets = dict(explicit_aliases)
    for source in sources:
        for anchor in (n for n in nodes(source_document(source)) if n.tag == "a"):
            destination = urlsplit(expected_link(anchor.attrs.get("href", ""), paths, by_id, media_by_key))
            if destination.path in by_route and destination.fragment:
                target_source = by_route[destination.path]
                key = (target_source["id"], unquote(destination.fragment))
                if key not in alias_targets:
                    label = unquote(destination.fragment).replace("_", " ")
                    matches = [n for n in nodes(source_document(target_source)) if re.fullmatch(r"h[1-6]", n.tag) and canonical(n) == label]
                    assert len(matches) == 1, (key, "legacy fragment needs verified source evidence")
                    alias_targets[key] = canonical(matches[0])
    totals = {"articles": 0, "pages": 0, "code_blocks": 0, "code_elements": 0, "formulas": 0, "headings": 0, "images": 0, "tables": 0, "comment_formulas": 0}
    for source in sources:
        assert source["type"] in {"post", "page"}
        assert source["status"] == "publish" and not source["protected"], (source["id"], "source visibility changed")
        assert len(source["categories"]) == len(set(source["categories"]))
        assert set(source["categories"]) <= set(category_by_id)
        assert len(source["tags"]) == len(set(source["tags"])) and set(source["tags"]) <= set(tags)
        assert (source["type"] == "page") == (source in historical_pages)
        assert hashlib.sha256(source["content_html"].encode()).hexdigest() == source["content_sha256"]
        expected_source = f'content/blog/{"pages" if source["type"] == "page" else "posts"}/{source["id"]}.md'
        assert source["source_file"] == expected_source, (source["id"], "unexpected formal source path")
        source_bytes = (ROOT / source["source_file"]).read_bytes()
        assert hashlib.sha256(source_bytes).hexdigest() == source["source_sha256"], (source["id"], "formal source byte hash differs")
        assert (datetime.fromisoformat(source["date"]) - datetime.fromisoformat(source["date_gmt"])).total_seconds() == 28800
        original = source_document(source)
        path = ROOT / route(source).lstrip("/") / "index.html"
        document = read_document(path)
        row = report_by_id[source["id"]]
        assert row["path"] == route(source) and row["original_url"] == source["link"]
        assert row["source_file"] == source["source_file"] and row["source_sha256"] == source["source_sha256"]
        assert row["content_sha256"] == source["content_sha256"] and row["date"] == source["date"]
        assert row["title"] == source["title"]
        assert row["type"] == source["type"] and row["categories"] == source["categories"] and row["tags"] == source["tags"], (source["id"], "report metadata changed")
        prose = [n for n in nodes(document) if has_class(n, "prose")]
        assert len(prose) == 1, (source["id"], "missing or duplicate article body")
        prose = prose[0]
        assert canonical(original) == canonical(prose, True), (source["id"], "article text or TeX changed")
        assert structural_tags(original) == structural_tags(prose), (source["id"], "ordered HTML structure changed")
        article_headers = [n for n in nodes(document) if has_class(n, "article-header")]
        assert len(article_headers) == 1, (source["id"], "missing or duplicate article header")
        article_title = [n for n in nodes(article_headers[0]) if n.tag == "h1"]
        assert len(article_title) == 1 and canonical(article_title[0]) == " ".join(source["title"].split()), (source["id"], "article title changed")
        headings = [n for n in nodes(prose) if re.fullmatch(r"h[1-6]", n.tag)]
        source_headings = [n for n in nodes(original) if re.fullmatch(r"h[1-6]", n.tag)]
        if source_headings:
            minimum = min(int(h.tag[1]) for h in source_headings)
            assert [int(h.tag[1]) for h in headings] == [min(6, int(h.tag[1]) + 2 - minimum) for h in source_headings], (source["id"], "heading hierarchy changed")
        assert [canonical(h) for h in source_headings] == [canonical(h, True) for h in headings], (source["id"], "heading content changed")
        toc = [n for n in nodes(document) if has_class(n, "article-toc")]
        assert len(toc) == bool(headings), (source["id"], "missing or duplicate contents")
        items = [n for n in nodes(toc[0]) if n.tag == "li"] if toc else []
        assert len(items) == len(headings), (source["id"], "contents count differs from headings")
        for heading, item in zip(headings, items):
            links = [n for n in nodes(item) if n.tag == "a"]
            assert len(links) == 1, (source["id"], "contents item must have one local heading link")
            assert links[0].attrs.get("href") == "#" + heading.attrs["id"], (source["id"], "contents points outside its heading")
            assert canonical(item, True) == canonical(heading, True), (source["id"], "contents label differs from heading")
        for tag in ("code", "pre"):
            before = [content(n) for n in nodes(original) if n.tag == tag]
            after = [content(n) for n in nodes(prose) if n.tag == tag]
            assert before == after, (source["id"], tag, "code changed")
            totals["code_elements" if tag == "code" else "code_blocks"] += len(before)
        before_images = [media_by_key[media_key(n.attrs["src"])] for n in nodes(original) if n.tag == "img"]
        after_images = [n.attrs["src"] for n in semantic_nodes(prose) if n.tag == "img"]
        assert before_images == after_images, (source["id"], "image missing/reordered")
        totals["images"] += len(before_images)
        before_links = [n.attrs.get("href", "") for n in nodes(original) if n.tag == "a"]
        after_links = [n.attrs.get("href", "") for n in semantic_nodes(prose) if n.tag == "a"]
        assert [expected_link(url, paths, by_id, media_by_key) for url in before_links] == after_links, (source["id"], "body link lost or migration target wrong")
        for tag, metric in [(r"h[1-6]", "headings"), ("table", "tables")]:
            before = sum(bool(re.fullmatch(tag, n.tag)) for n in nodes(original))
            after = sum(bool(re.fullmatch(tag, n.tag)) for n in nodes(prose))
            assert before == after, (source["id"], metric, "structure changed")
            totals[metric] += before
        formulas = [n.attrs["data-original-math"] for n in nodes(prose) if "data-original-math" in n.attrs]
        assert original_formulas(original) == formulas, (source["id"], "formula missing, reordered or altered")
        totals["formulas"] += len(formulas)
        assert not any(has_class(n, "katex-error") for n in nodes(prose))
        dates = [n for n in nodes(article_headers[0]) if n.tag == "time"]
        assert len(dates) == 1 and dates[0].attrs.get("datetime") == source["date"] + "+08:00", (source["id"], "published date changed")
        assert canonical(dates[0]) == visible_date(source["date"]), (source["id"], "visible published date changed")
        meta = [n for n in nodes(document) if has_class(n, "post-meta")]
        assert len(meta) == 1
        if source["date"][:10] != source["modified"][:10]:
            assert "更新于 " + visible_date(source["modified"]) in canonical(meta[0]), (source["id"], "original updated date changed")
        else:
            assert "更新于" not in canonical(meta[0]), (source["id"], "unexpected updated date")
        ids = [n.attrs["id"] for n in nodes(document) if "id" in n.attrs]
        assert len(ids) == len(set(ids)), (source["id"], "duplicate ID")
        counts = {"formulas": len(formulas), "headings": len(headings), "images": len(before_images), "code_blocks": sum(n.tag == "pre" for n in nodes(original))}
        for metric, value in counts.items():
            assert row[metric] == value, (source["id"], metric, "report count differs")
        tag_areas = [n for n in nodes(document) if has_class(n, "source-tags")]
        assert len(tag_areas) == bool(source["tags"]), (source["id"], "original tag metadata missing or duplicated")
        tag_nodes = [n for area in tag_areas for n in nodes(area) if "data-source-tag" in n.attrs]
        assert [(n.attrs["data-source-tag"], canonical(n)) for n in tag_nodes] == [(str(i), " ".join(tags[i]["name"].split())) for i in source["tags"]], (source["id"], "original tags changed")
        assert all(n.tag == "a" and n.attrs.get("href") == f'/blog/tags/{n.attrs["data-source-tag"]}/' for n in tag_nodes), (source["id"], "article tag metadata is not navigable")
        if "comment_count" in row:
            assert row["comment_count"] == len(comments["by_post"][source["id"]]), (source["id"], "historical comment report count changed")
        totals["comment_formulas"] += check_article_comments(document, source, comments["by_post"][source["id"]], features, paths, by_id, media_by_key)
        for (post_id, fragment), heading_text in alias_targets.items():
            if post_id == source["id"]:
                targets = [h for h in headings if any(n.attrs.get("id") == fragment for n in nodes(h))]
                assert len(targets) == 1 and canonical(targets[0], True) == heading_text, (post_id, fragment, "verified legacy anchor points to wrong heading")
        totals["pages" if source["type"] == "page" else "articles"] += 1
    for item in media:
        media_path = (ROOT / item["path"].lstrip("/")).resolve()
        assert ROOT in media_path.parents and item["path"].startswith("/blog/media/")
        data = media_path.read_bytes()
        assert len(data) == item["bytes"], (item["original_url"], "media size differs")
        assert hashlib.sha256(data).hexdigest() == item["sha256"], (item["original_url"], "media hash differs")
    home = read_document(ROOT / "blog/index.html")
    check_cards(home, posts, "blog index", tags)
    check_history_links(home, historical_pages, "blog historical-page index")
    check_tag_cloud(home, tags, posts, "homepage tag cloud", folded=True)
    archive = read_document(ROOT / "blog/archive/index.html")
    check_archive(archive, posts)
    check_history_links(archive, historical_pages, "archive historical-page index")
    nonempty_categories = {c["id"] for c in batch["categories"] if any(c["id"] in p["categories"] for p in posts)}
    assert all(c["count"] == sum(c["id"] in p["categories"] for p in posts) for c in batch["categories"]), "source category count disagrees with public scope"
    assert len(report["categories"]) == len({c["id"] for c in report["categories"]}) == len(nonempty_categories)
    assert {c["id"] for c in report["categories"]} == nonempty_categories
    expected_category_files = set()
    for category in report["categories"]:
        category_id = category["id"]
        items = [p for p in posts if category_id in p["categories"]]
        assert len(items) == category["count"] == category_by_id[category_id]["count"], (category_id, "category count differs")
        assert category["name"] == category_by_id[category_id]["name"]
        expected_route = f"/blog/categories/{category_id}/"
        assert category["path"] == expected_route
        category_path = ROOT / expected_route.lstrip("/") / "index.html"
        expected_category_files.add(category_path)
        check_cards(read_document(category_path), items, f"category {category_id}", tags)
        if items:
            assert any(n.tag == "a" and n.attrs.get("href") == expected_route for n in nodes(home)), (category_id, "nonempty category missing from blog index")
    for directory, values in (("posts", posts), ("pages", historical_pages)):
        expected_files = {ROOT / route(p).lstrip("/") / "index.html" for p in values}
        assert set((ROOT / "blog" / directory).rglob("*.html")) == expected_files, (directory, "missing or stale content pages")
    assert set((ROOT / "blog/categories").rglob("*.html")) == expected_category_files, "missing or stale category pages"
    used_tags = {identifier for source in posts for identifier in source["tags"]}
    assert len(report["tags"]) == len({tag["id"] for tag in report["tags"]}) == len(used_tags)
    assert {tag["id"] for tag in report["tags"]} == used_tags, "missing, duplicate or unused generated tag"
    expected_tag_files = set()
    for tag in report["tags"]:
        identifier = tag["id"]
        items = [source for source in posts if identifier in source["tags"]]
        expected_route = f"/blog/tags/{identifier}/"
        assert tag["name"] == tags[identifier]["name"] and tag["count"] == len(items) and tag["path"] == expected_route, (identifier, "tag report differs")
        tag_path = ROOT / expected_route.lstrip("/") / "index.html"
        expected_tag_files.add(tag_path)
        check_cards(read_document(tag_path), items, f"tag {identifier}", tags)
    tag_index = ROOT / "blog/tags/index.html"
    check_tag_cloud(read_document(tag_index), tags, posts, "all tags")
    assert set((ROOT / "blog/tags").rglob("*.html")) == expected_tag_files | {tag_index}, "missing or stale tag pages"
    friends_path = ROOT / "blog/friends/index.html"
    check_friends_page(read_document(friends_path), friends)
    assert report["friends"] == {"path": "/blog/friends/", "count": len(friends), "source_file": "content/blog/friends.yaml"}, "friend-link report differs"
    pages = list((ROOT / "blog").rglob("*.html"))
    expected_pages = {ROOT / "blog/index.html", ROOT / "blog/archive/index.html", tag_index, friends_path} | expected_category_files | expected_tag_files | {ROOT / route(p).lstrip("/") / "index.html" for p in sources}
    assert set(pages) == expected_pages, "missing or stale generated blog HTML"
    for path in pages:
        document = Document(path.read_text(encoding="utf-8")).root
        ids = [n.attrs["id"] for n in nodes(document) if "id" in n.attrs]
        assert len(ids) == len(set(ids)), (path, "duplicate page ID")
        for node in nodes(document):
            for key in ("href", "src"):
                if key in node.attrs:
                    check_local_url(node.attrs[key], path)
        for node in nodes(document):
            assert not any(key.startswith("data-visit") for key in node.attrs), (path, "disabled Visits DOM is present")
            assert not ({"visits", "visit-count", "post-visits", "article-visits", "site-visits"} & set(node.attrs.get("class", "").split())), (path, "disabled Visits count is rendered")
            if node.tag == "script":
                assert not urlsplit(node.attrs.get("src", "")).scheme and not urlsplit(node.attrs.get("src", "")).netloc
                assert not urlsplit(node.attrs.get("src", "")).path.endswith("/visits.js"), (path, "disabled Visits script is loaded")
            if node.tag == "link" and node.attrs.get("rel") == "stylesheet":
                assert not urlsplit(node.attrs.get("href", "")).scheme and not urlsplit(node.attrs.get("href", "")).netloc
    for path in (ROOT / "assets/vendor/katex").glob("*.css"):
        for url in re.findall(r"url\(([^)]+)\)", path.read_text(encoding="utf-8")):
            assert (path.parent / url.strip('\"\'')).is_file(), url
    for metric in ("code_blocks", "formulas", "headings", "images"):
        assert totals[metric] == report["totals"][metric]
    assert totals["comment_formulas"] == report["comments"]["formulas"], "historical comment formula report differs"
    print("PASS: formal Markdown text/TeX, code, ordered structure, dates, contents, complete indexes, migrated links, media hashes and font assets")
    print(json.dumps({**totals, "categories": len(nonempty_categories), "tags": len(used_tags), "friends": len(friends), "historical_comments": comments["count"], "media_files": len(media), "static_pages": len(pages)}, ensure_ascii=False))
    if args.original_snapshot is not None:
        check_original_snapshot(batch, (ROOT / args.original_snapshot).resolve(), media_by_key)
        check_original_comments(comments, ROOT / "migration/sources/comments-public-2026-10-25.json")
        from blog_friends import check_friends_snapshot
        check_friends_snapshot(ROOT / "content/blog/friends.yaml", ROOT / "migration/sources/friends-public-2026-10-25.json")
        print(f"PASS: original public sidebar independently matches {len(friends)} friend links in order")


if __name__ == "__main__":
    main()
