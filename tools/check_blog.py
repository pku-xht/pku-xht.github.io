"""Independently compare generated article content with the public source snapshot."""
import hashlib
import json
import re
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
VOID = set("area base br col embed hr img input link meta param source track wbr".split())
TARGET_IDS = {}


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
    assert target.is_file(), (current, url, "missing local target")
    if parts.fragment:
        if target not in TARGET_IDS:
            doc = Document(target.read_text(encoding="utf-8"))
            TARGET_IDS[target] = {n.attrs["id"] for n in nodes(doc.root) if "id" in n.attrs}
        assert unquote(parts.fragment) in TARGET_IDS[target], (current, url, "missing fragment")


def main():
    batch = json.loads((ROOT / "migration/sources/notes-2026-10-23.json").read_text(encoding="utf-8"))
    report = json.loads((ROOT / "migration/notes-batch1.json").read_text(encoding="utf-8"))
    assert batch["visibility"] == "anonymous-public-only"
    assert len(batch["posts"]) == len({p["id"] for p in batch["posts"]}) == 29
    assert {p["id"] for p in batch["posts"]} == {p["id"] for p in report["posts"]}
    media = json.loads((ROOT / "migration/sources/media.json").read_text(encoding="utf-8"))
    media_map = {m["original_url"]: m["path"] for m in media}
    totals = {"articles": 0, "code_blocks": 0, "code_elements": 0, "formulas": 0, "headings": 0, "images": 0, "tables": 0}
    for source in batch["posts"]:
        assert source["status"] == "publish" and not source["protected"] and 13 in source["categories"]
        assert hashlib.sha256(source["content_html"].encode()).hexdigest() == source["content_sha256"]
        assert (datetime.fromisoformat(source["date"]) - datetime.fromisoformat(source["date_gmt"])).total_seconds() == 28800
        raw = re.sub(r"^\s*<p>Visits:\s*\d+</p>", "", source["content_html"], count=1)
        original = Document(raw).root
        path = ROOT / f'blog/posts/{source["id"]}/index.html'
        document = Document(path.read_text(encoding="utf-8")).root
        prose = [n for n in nodes(document) if has_class(n, "prose")]
        assert len(prose) == 1
        prose = prose[0]
        assert canonical(original) == canonical(prose, True), (source["id"], "article text or TeX changed")
        for tag in ("code", "pre"):
            before = [content(n) for n in nodes(original) if n.tag == tag]
            after = [content(n) for n in nodes(prose) if n.tag == tag]
            assert before == after, (source["id"], tag, "code changed")
            totals["code_elements" if tag == "code" else "code_blocks"] += len(before)
        before_images = [media_map[n.attrs["src"]] for n in nodes(original) if n.tag == "img"]
        after_images = [n.attrs["src"] for n in nodes(prose) if n.tag == "img"]
        assert before_images == after_images, (source["id"], "image missing/reordered")
        totals["images"] += len(before_images)
        for tag, metric in [(r"h[1-6]", "headings"), ("table", "tables")]:
            before = sum(bool(re.fullmatch(tag, n.tag)) for n in nodes(original))
            after = sum(bool(re.fullmatch(tag, n.tag)) for n in nodes(prose))
            assert before == after, (source["id"], metric, "structure changed")
            totals[metric] += before
        totals["formulas"] += sum("data-original-math" in n.attrs for n in nodes(prose))
        assert not any(has_class(n, "katex-error") for n in nodes(prose))
        dates = [n.attrs["datetime"] for n in nodes(document) if n.tag == "time"]
        assert dates == [source["date"] + "+08:00"]
        ids = [n.attrs["id"] for n in nodes(document) if "id" in n.attrs]
        assert len(ids) == len(set(ids)), (source["id"], "duplicate ID")
        totals["articles"] += 1
    for item in media:
        assert hashlib.sha256((ROOT / item["path"].lstrip("/")).read_bytes()).hexdigest() == item["sha256"]
    pages = list((ROOT / "blog").rglob("*.html"))
    assert len(pages) == 31
    for path in pages:
        document = Document(path.read_text(encoding="utf-8")).root
        for node in nodes(document):
            for key in ("href", "src"):
                if key in node.attrs:
                    check_local_url(node.attrs[key], path)
        for node in nodes(document):
            if node.tag == "script":
                assert not urlsplit(node.attrs.get("src", "")).scheme
    for path in (ROOT / "assets/vendor/katex").glob("*.css"):
        for url in re.findall(r"url\(([^)]+)\)", path.read_text(encoding="utf-8")):
            assert (path.parent / url.strip('\"\'')).is_file(), url
    for metric in ("code_blocks", "formulas", "headings", "images"):
        assert totals[metric] == report["totals"][metric]
    print("PASS: original text/TeX, code, images, tables, dates, local links and font assets")
    print(json.dumps(totals, ensure_ascii=False))


if __name__ == "__main__":
    main()
