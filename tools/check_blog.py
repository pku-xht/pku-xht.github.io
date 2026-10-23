"""Independently compare all generated public content with its checked snapshot.

This checker deliberately does not import the generator: the source HTML, routes,
indexes, media bytes and generated report are checked against one another here.
"""
import hashlib
import html
import json
import re
from collections import Counter
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
VOID = set("area base br col embed hr img input link meta param source track wbr".split())
TARGET_IDS = {}
OLD_HOSTS = {"www.xht37.com", "xht37.com"}
STRUCTURAL_TAGS = set("p strong em b i u s del ul ol li a code pre blockquote hr img table thead tbody tr th td sup sub".split())


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
        assert canonical(links[0]) == " ".join(html.unescape(source["title"]).split()), (label, source["id"], "card title changed")
        times = [n for n in nodes(card) if n.tag == "time"]
        assert len(times) == 1 and times[0].attrs.get("datetime") == source["date"] + "+08:00", (label, source["id"], "card date changed")
        assert canonical(times[0]) == visible_date(source["date"]), (label, source["id"], "visible card date changed")
        searchable = card.attrs.get("data-search", "")
        for tag_id in source.get("tags", []):
            assert html.unescape(tags[tag_id]["name"]) in searchable, (label, source["id"], tag_id, "original tag absent from search index")
        actual.append(destination)
    assert_routes(actual, list(expected), label)
    assert actual == [route(p) for p in sources], (label, "source chronological order changed")


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
            assert canonical(links[0]) == " ".join(html.unescape(source["title"]).split()), (source["id"], "archive title changed")
            times = [n for n in nodes(item) if n.tag == "time"]
            assert len(times) == 1 and times[0].attrs.get("datetime") == source["date"] + "+08:00", (source["id"], "archive date changed")
            assert canonical(times[0]) == source["date"][5:10] and year == source["date"][:4], (source["id"], "archive visible date changed")
            actual.append(destination)
    assert_routes(actual, list(expected), "archive")
    assert actual == [route(p) for p in sources], "archive chronological order changed"
    assert years == sorted({p["date"][:4] for p in sources}, reverse=True), "archive year missing, duplicate or reordered"


def main():
    batch = json.loads((ROOT / "migration/sources/public-2026-10-23.json").read_text(encoding="utf-8"))
    report = json.loads((ROOT / "migration/public-batch.json").read_text(encoding="utf-8"))
    assert batch["visibility"] == "anonymous-public-only"
    assert report["publication"] == "local-only" and report["design"] == "C"
    posts, historical_pages = batch["posts"], batch.get("pages", [])
    sources = posts + historical_pages
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
    aliases = json.loads((ROOT / "migration/sources/legacy-anchors.json").read_text(encoding="utf-8"))
    assert aliases["visibility"] == "anonymous-public-only"
    explicit_aliases = {(a["post_id"], a["fragment"]): a["heading_text"] for a in aliases["anchors"]}
    media = json.loads((ROOT / "migration/sources/media.json").read_text(encoding="utf-8"))
    media_map = {m["original_url"]: m["path"] for m in media}
    assert len(media_map) == len(media), "duplicate media original URL"
    media_by_key = {}
    for item in media:
        key = media_key(item["original_url"])
        assert key not in media_by_key or media_by_key[key] == item["path"], (key, "ambiguous media aliases")
        media_by_key[key] = item["path"]
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
    totals = {"articles": 0, "pages": 0, "code_blocks": 0, "code_elements": 0, "formulas": 0, "headings": 0, "images": 0, "tables": 0}
    for source in sources:
        assert source["type"] in {"post", "page"}
        assert source["status"] == "publish" and not source["protected"], (source["id"], "source visibility changed")
        assert len(source["categories"]) == len(set(source["categories"]))
        assert set(source["categories"]) <= set(category_by_id)
        assert len(source["tags"]) == len(set(source["tags"])) and set(source["tags"]) <= set(tags)
        assert (source["type"] == "page") == (source in historical_pages)
        assert hashlib.sha256(source["content_html"].encode()).hexdigest() == source["content_sha256"]
        assert (datetime.fromisoformat(source["date"]) - datetime.fromisoformat(source["date_gmt"])).total_seconds() == 28800
        original = source_document(source)
        path = ROOT / route(source).lstrip("/") / "index.html"
        document = read_document(path)
        row = report_by_id[source["id"]]
        assert row["path"] == route(source) and row["original_url"] == source["link"]
        assert row["source_sha256"] == source["content_sha256"] and row["date"] == source["date"]
        assert html.unescape(row["title"]) == html.unescape(source["title"])
        assert row["type"] == source["type"] and row["categories"] == source["categories"] and row["tags"] == source["tags"], (source["id"], "report metadata changed")
        prose = [n for n in nodes(document) if has_class(n, "prose")]
        assert len(prose) == 1, (source["id"], "missing or duplicate article body")
        prose = prose[0]
        assert canonical(original) == canonical(prose, True), (source["id"], "article text or TeX changed")
        assert structural_tags(original) == structural_tags(prose), (source["id"], "ordered HTML structure changed")
        article_title = [n for n in nodes(document) if n.tag == "h1"]
        assert len(article_title) == 1 and canonical(article_title[0]) == " ".join(html.unescape(source["title"]).split()), (source["id"], "article title changed")
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
        dates = [n for n in nodes(document) if n.tag == "time"]
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
        assert [(n.attrs["data-source-tag"], canonical(n)) for n in tag_nodes] == [(str(i), " ".join(html.unescape(tags[i]["name"]).split())) for i in source["tags"]], (source["id"], "original tags changed")
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
        assert html.unescape(category["name"]) == html.unescape(category_by_id[category_id]["name"])
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
    pages = list((ROOT / "blog").rglob("*.html"))
    expected_pages = {ROOT / "blog/index.html", ROOT / "blog/archive/index.html"} | expected_category_files | {ROOT / route(p).lstrip("/") / "index.html" for p in sources}
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
            if node.tag == "script":
                assert not urlsplit(node.attrs.get("src", "")).scheme and not urlsplit(node.attrs.get("src", "")).netloc
            if node.tag == "link" and node.attrs.get("rel") == "stylesheet":
                assert not urlsplit(node.attrs.get("href", "")).scheme and not urlsplit(node.attrs.get("href", "")).netloc
    for path in (ROOT / "assets/vendor/katex").glob("*.css"):
        for url in re.findall(r"url\(([^)]+)\)", path.read_text(encoding="utf-8")):
            assert (path.parent / url.strip('\"\'')).is_file(), url
    for metric in ("code_blocks", "formulas", "headings", "images"):
        assert totals[metric] == report["totals"][metric]
    print("PASS: all public text/TeX, code, ordered structure, dates, contents, complete indexes, migrated links, media hashes and font assets")
    print(json.dumps({**totals, "categories": len(nonempty_categories), "media_files": len(media), "static_pages": len(pages)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
