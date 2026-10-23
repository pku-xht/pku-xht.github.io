"""Import the approved public snapshot into maintainable Markdown once.

Normal rebuilds never call this importer or read the historical snapshot. Existing
Markdown and the collection manifest are deliberately never overwritten: import
into a separate empty directory when auditing a later snapshot.
"""
import argparse
import collections
import hashlib
import html
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/vendor/python"))
import yaml

import build_blog as blog
from blog_sources import render_markdown

SOURCE = ROOT / "migration/sources/public-2026-10-23.json"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class TopLevelBlocks(HTMLParser):
    """Keep the exact original HTML for a block-level conversion fallback."""

    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.lines = [0]
        for match in re.finditer("\n", source):
            self.lines.append(match.end())
        self.stack = []
        self.start = None
        self.blocks = []
        self.feed(source)
        self.close()
        if self.stack:
            raise ValueError("Unclosed original HTML tags: " + repr(self.stack))

    def source_offset(self):
        line, column = self.getpos()
        return self.lines[line - 1] + column

    def handle_starttag(self, tag, attrs):
        if not self.stack:
            self.start = self.source_offset()
        if tag not in VOID:
            self.stack.append(tag)
        elif not self.stack:
            self.blocks.append(self.source[self.start:self.source_offset() + len(self.get_starttag_text())])

    def handle_startendtag(self, tag, attrs):
        if self.stack:
            return
        start = self.source_offset()
        self.blocks.append(self.source[start:start + len(self.get_starttag_text())])

    def handle_endtag(self, tag):
        # WordPress left a few unmatched </p> tags inside list items. Match the
        # established fragment parser's tolerant ancestor closing semantics.
        if tag not in self.stack:
            return
        index = len(self.stack) - 1 - self.stack[::-1].index(tag)
        del self.stack[index:]
        if not self.stack:
            end = self.source.index(">", self.source_offset()) + 1
            self.blocks.append(self.source[self.start:end])

    def handle_data(self, data):
        if not self.stack and data.strip():
            raise ValueError("Unexpected text outside an original HTML block")

    def handle_entityref(self, name):
        if not self.stack:
            raise ValueError("Unexpected root-level entity")

    handle_charref = handle_entityref


def prepared(source, document_id):
    tree = blog.parse(source)
    blog.prepare_math(tree, document_id)
    return tree


def signature(tree):
    """Compare structure, semantic text, exact formulas/code and URL attributes."""
    # Spaces between inline children can distinguish adjacent words or formula
    # delimiters even though indentation and line wrapping are insignificant.
    result = [("canonical", " ".join(blog.text(tree).split()))]

    def visit(node):
        if isinstance(node, str):
            normalized = re.sub(r"\s+", "", node)
            if normalized:
                result.append(("text", normalized))
            return
        if isinstance(node, blog.Math):
            result.append(("math", node.original, node.display))
            return
        tag = {"b": "strong", "i": "em"}.get(node.tag, node.tag)
        if tag == "root":
            for child in node.children:
                visit(child)
            return
        if tag in {"pre", "code"}:
            # A pre includes one code child in the approved snapshot. Keeping both
            # exact text and language detects accidental fence normalization.
            classes = re.findall(r"language-[\w+-]+", node.attrs.get("class", ""))
            result.append((tag, blog.text(node), tuple(classes)))
            if tag == "pre":
                for child in node.children:
                    if isinstance(child, blog.Element):
                        visit(child)
            return
        relevant = {k: v for k, v in node.attrs.items() if k in {"href", "src", "alt", "start", "align", "colspan", "rowspan", "id"}}
        if tag == "ol" and relevant.get("start") == "1":
            relevant.pop("start")
        result.append(("start", tag, tuple(sorted(relevant.items()))))
        for child in node.children:
            visit(child)
        result.append(("end", tag))

    visit(tree)
    # Adjacent text nodes may be merged or split by a Markdown renderer.
    merged = []
    for item in result:
        if item[0] == "text" and merged and merged[-1][0] == "text":
            merged[-1] = ("text", merged[-1][1] + item[1])
        else:
            merged.append(item)
    return merged


def raw_html(node):
    if isinstance(node, str):
        return html.escape(node, quote=False)
    if isinstance(node, blog.Math):
        return html.escape(node.original, quote=False)
    if node.tag == "root":
        return "".join(raw_html(child) for child in node.children)
    attrs = "".join(f' {key}="{html.escape(value, quote=True)}"' for key, value in node.attrs.items())
    value = "<" + node.tag + attrs + ">"
    if node.tag not in VOID:
        value += "".join(raw_html(child) for child in node.children) + "</" + node.tag + ">"
    return value


def escape_text(value):
    # Source HTML collapses ordinary whitespace. Explicit source <br> elements
    # become Markdown hard breaks; code and math never use this function.
    value = re.sub(r"\s+", " ", value)
    value = html.escape(value, quote=False)
    return re.sub(r"([\\`*_{}\[\]()#+.!|~\-])", r"\\\1", value)


def inline(node):
    if isinstance(node, str):
        return escape_text(node)
    if isinstance(node, blog.Math):
        return node.original
    tag = node.tag
    if tag == "br":
        return "  \n"
    children = "".join(inline(child) for child in node.children)
    if tag in {"strong", "b", "em", "i"}:
        marker = "**" if tag in {"strong", "b"} else "*"
        if not children or children != children.strip():
            return raw_html(node)
        return marker + children + marker
    if tag == "a":
        href = node.attrs.get("href", "")
        if any(ch in href for ch in "<>\n\r"):
            return raw_html(node)
        return "[" + children + "](<" + href + ">)"
    if tag == "img":
        src = node.attrs["src"]
        if any(ch in src for ch in "<>\n\r"):
            return raw_html(node)
        alt = escape_text(node.attrs.get("alt", ""))
        return "![" + alt + "](<" + src + ">)"
    if tag == "code":
        value = blog.text(node)
        if not value or "\n" in value or "\r" in value:
            return raw_html(node)
        fence = "`" * max([len(match.group()) + 1 for match in re.finditer(r"`+", value)] + [1])
        pad = " " if value.startswith("`") or value.endswith("`") or (value.startswith(" ") and value.endswith(" ") and value.strip()) else ""
        return fence + pad + value + pad + fence
    return raw_html(node)


def inline_children(node):
    value = "".join(inline(child) for child in node.children)
    # Whitespace immediately after an explicit break is HTML formatting only.
    return re.sub(r" {2}\n +", "  \n", value).strip(" ")


def blocks(nodes):
    rendered = []
    inline_run = []

    def flush():
        if inline_run:
            value = "".join(inline(child) for child in inline_run).strip(" ")
            if value:
                rendered.append(value)
            inline_run.clear()

    for node in nodes:
        if isinstance(node, blog.Element) and node.tag in {"p", "pre", "ul", "ol", "blockquote", "hr", "table", "div", "h1", "h2", "h3", "h4", "h5", "h6"}:
            flush()
            rendered.append(block(node))
        else:
            inline_run.append(node)
    flush()
    return "\n\n".join(value for value in rendered if value)


def block(node):
    tag = node.tag
    if tag == "p":
        return inline_children(node)
    if re.fullmatch(r"h[1-6]", tag):
        return "#" * int(tag[1]) + " " + inline_children(node)
    if tag == "hr":
        return "---"
    if tag == "blockquote":
        return "\n".join("> " + line if line else ">" for line in blocks(node.children).split("\n"))
    if tag == "pre":
        elements = [child for child in node.children if isinstance(child, blog.Element)]
        if len(elements) != 1 or elements[0].tag != "code" or any(isinstance(child, str) and child for child in node.children):
            return raw_html(node)
        value = blog.text(elements[0])
        if not value.endswith("\n") or "\r" in value:
            return raw_html(node)
        classes = re.findall(r"language-([\w+-]+)", elements[0].attrs.get("class", ""))
        language = classes[0] if classes else ""
        fence = "`" * max([len(match.group()) + 1 for match in re.finditer(r"`+", value)] + [3])
        return fence + language + "\n" + value + fence
    if tag in {"ul", "ol"}:
        items = [child for child in node.children if isinstance(child, blog.Element)]
        if any(child.tag != "li" for child in items):
            return raw_html(node)
        # A loose Markdown list retains the source's paragraph wrappers. Mixed
        # wrapper shapes are detected by the per-block comparison and kept HTML.
        loose = any(any(isinstance(child, blog.Element) and child.tag == "p" for child in item.children) for item in items)
        start = int(node.attrs.get("start", "1"))
        rendered = []
        for index, item in enumerate(items):
            marker = "- " if tag == "ul" else str(start + index) + ". "
            body = blocks(item.children)
            lines = body.split("\n")
            rendered.append(marker + lines[0] + "".join("\n" + " " * len(marker) + line if line else "\n" for line in lines[1:]))
        return ("\n\n" if loose else "\n").join(rendered)
    return raw_html(node)


class Description(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.value = None
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta" and values.get("name") == "description":
            self.value = values["content"]


def convert(source, document_id, stats):
    converted = []
    for original in TopLevelBlocks(source).blocks:
        tree = prepared(original, document_id)
        if not tree.children:  # The old dynamic Visits paragraph is not content.
            stats["removed_visit_counters"] += 1
            continue
        candidate = blocks(tree.children)
        expected = signature(tree)
        if signature(prepared(render_markdown(candidate), document_id)) == expected:
            converted.append(candidate)
            if candidate.lstrip().startswith("<"):
                stats["raw_html_blocks"] += 1
            else:
                stats["markdown_blocks"] += 1
                first = next((child for child in tree.children if isinstance(child, blog.Element)), None)
                if first is not None:
                    stats["native_" + first.tag] += 1
        else:
            # Preserve the exact original complex block, never drop any content.
            if signature(prepared(render_markdown(original), document_id)) != expected:
                raise ValueError(f"Original HTML fallback does not round-trip for {document_id}: {original[:120]!r}")
            converted.append(original)
            stats["raw_html_blocks"] += 1
            stats["fallback_blocks"] += 1
    body = "\n\n".join(converted) + "\n"
    if signature(prepared(render_markdown(body), document_id)) != signature(prepared(source, document_id)):
        raise ValueError(f"Joined Markdown does not preserve the original structure for {document_id}")
    return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, default=SOURCE)
    parser.add_argument("--resources", type=Path, default=ROOT / "migration/sources/media.json")
    parser.add_argument("--legacy-anchors", type=Path, default=ROOT / "migration/sources/legacy-anchors.json")
    parser.add_argument("--output-root", type=Path, default=ROOT / "content/blog")
    args = parser.parse_args()
    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    if snapshot.get("visibility") != "anonymous-public-only":
        raise ValueError("Only an approved anonymous public snapshot can be imported")
    posts, pages = snapshot["posts"], snapshot.get("pages", [])
    documents = posts + pages
    if len(posts) != snapshot["count"] or len({post["id"] for post in documents}) != len(documents):
        raise ValueError("Snapshot count or IDs are inconsistent")
    categories = {item["id"]: html.unescape(item["name"]) for item in snapshot["categories"]}
    tags = {item["id"]: html.unescape(item["name"]) for item in snapshot.get("tags", [])}
    resources = json.loads(args.resources.read_text(encoding="utf-8"))
    anchor_evidence = json.loads(args.legacy_anchors.read_text(encoding="utf-8"))
    if anchor_evidence.get("visibility") != "anonymous-public-only":
        raise ValueError("Legacy anchor evidence is not approved public material")
    anchors = collections.defaultdict(dict)
    for item in anchor_evidence["anchors"]:
        anchors[item["post_id"]][item["fragment"]] = item["heading_text"]
    targets = [(post, args.output_root / ("posts" if post["type"] == "post" else "pages") / f'{post["id"]}.md') for post in documents]
    manifest_path = args.output_root / "collection.yaml"
    resources_path = args.output_root / "resources.yaml"
    existing = sorted(args.output_root.rglob("*.md")) if args.output_root.exists() else []
    if manifest_path.exists():
        existing.append(manifest_path)
    if resources_path.exists():
        existing.append(resources_path)
    if existing:
        raise FileExistsError("Import refuses to overwrite maintained sources; choose a new --output-root: " + str(existing[0]))
    stats = collections.Counter()
    prepared_documents = []
    for post, target in targets:
        if post.get("status") != "publish" or post.get("protected"):
            raise ValueError("Import contains a non-public document")
        if post["type"] not in {"post", "page"}:
            raise ValueError("Unexpected document type")
        if hashlib.sha256(post["content_html"].encode("utf-8")).hexdigest() != post["content_sha256"]:
            raise ValueError("Snapshot body does not match its recorded digest")
        metadata = {
            "id": post["id"],
            "type": post["type"],
            "title": html.unescape(post["title"]),
            "date": post["date"] + "+08:00",
            "modified": post["modified"] + "+08:00",
            "slug": post["slug"],
            "original_url": post["link"],
            "categories": [{"id": cid, "name": categories[cid]} for cid in post["categories"]],
            "tags": [{"id": tid, "name": tags[tid]} for tid in post.get("tags", [])],
        }
        if anchors.get(post["id"]):
            metadata["legacy_anchors"] = anchors[post["id"]]
        current_page = ROOT / "blog" / ("posts" if post["type"] == "post" else "pages") / str(post["id"]) / "index.html"
        if current_page.exists():
            summary = Description(current_page.read_text(encoding="utf-8")).value
            if summary is not None:
                metadata["summary"] = summary
        body = convert(post["content_html"], post["id"], stats)
        front_matter = yaml.safe_dump(metadata, allow_unicode=True, sort_keys=False, width=1000)
        prepared_documents.append((target, "---\n" + front_matter + "---\n\n" + body))
    # Validate every conversion before writing the first maintained file.
    for path, value in prepared_documents:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(value)
    manifest = {"version": 1, "posts": ["posts/" + str(post["id"]) + ".md" for post in posts], "pages": ["pages/" + str(page["id"]) + ".md" for page in pages]}
    with manifest_path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False))
    with resources_path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(yaml.safe_dump({"version": 1, "resources": resources}, allow_unicode=True, sort_keys=False, width=1000))
    print(json.dumps({"documents": len(documents), "posts": len(posts), "pages": len(pages), **stats}, ensure_ascii=False))


if __name__ == "__main__":
    main()
