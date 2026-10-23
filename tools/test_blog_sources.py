"""Isolated checks for editable Markdown sources and migration evidence.

Every mutation is made inside TemporaryDirectory; the repository's 212 sources,
original snapshots and generated website are never modified by these tests.
"""
import contextlib
import hashlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import build_blog
import check_blog
from blog_sources import load_blog, read_document, render_markdown


PROJECT = Path(__file__).resolve().parents[1]
FRONTMATTER = """---
id: 7
type: post
title: "临时校验"
date: "2020-02-03T04:05:06+08:00"
modified: "2020-02-03T04:05:06+08:00"
slug: temporary
original_url: "https://www.xht37.com/temporary/"
categories:
  - id: 13
    name: "笔记"
tags:
  - id: 2
    name: "C++"
summary: "可独立维护的摘要"
---

"""
BODY = """## 标题

源哨兵 alpha；字面的 \\*号\\* 与 $x_i \\times y_j$，以及 **强调**。

```cpp
""" + "int x = a & b;  \n```\n"
REFERENCE_HTML = '<h2>标题</h2>\n<p>源哨兵 alpha；字面的 *号* 与 $x_i \\times y_j$，以及 <strong>强调</strong>。</p>\n<pre><code>int x = a &amp; b;  \n</code></pre>\n'
COLLECTION = "version: 1\nposts:\n  - posts/7.md\npages: []\n"


class MarkdownSourcesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="blog-sources-")
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)
        self.content = self.project / "content/blog"
        (self.content / "posts").mkdir(parents=True)
        (self.content / "pages").mkdir()
        self.source = self.content / "posts/7.md"
        self.collection = self.content / "collection.yaml"
        self.collection.write_text(COLLECTION, encoding="utf-8")
        (self.content / "resources.yaml").write_text("version: 1\nresources: []\n", encoding="utf-8")
        self.write_source(FRONTMATTER + BODY)

    def write_source(self, value):
        with self.source.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(value)

    def load(self):
        return load_blog(self.content, project_root=self.project)

    def prepare_build(self):
        tools = self.project / "tools"
        (tools / "vendor/katex").mkdir(parents=True)
        shutil.copyfile(PROJECT / "tools/render_math.cjs", tools / "render_math.cjs")
        shutil.copyfile(PROJECT / "tools/vendor/katex/katex.cjs", tools / "vendor/katex/katex.cjs")
        # No migration/sources directory exists: none of the original JSON can be a build input.
        (self.project / "migration").mkdir()
        for relative in ("assets/favicon.svg", "assets/x-script-icon.svg"):
            path = self.project / relative
            path.parent.mkdir(exist_ok=True)
            path.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8")
        katex_style = self.project / "assets/vendor/katex/katex.min.css"
        katex_style.parent.mkdir(parents=True)
        katex_style.write_text("/* Style fixture; visual fonts are checked on the real site. */", encoding="utf-8")
        (self.project / "blog").mkdir()
        for relative in ("blog/blog.css", "blog/blog.js"):
            (self.project / relative).write_text("", encoding="utf-8")
        (self.project / "index.html").write_text('<main id="main">临时主页</main>', encoding="utf-8")

    def build(self):
        original_root = build_blog.ROOT
        try:
            build_blog.ROOT = self.project
            with contextlib.redirect_stdout(io.StringIO()):
                build_blog.main()
        finally:
            build_blog.ROOT = original_root

    def check(self, *arguments):
        original_root = check_blog.ROOT
        try:
            check_blog.ROOT = self.project
            with contextlib.redirect_stdout(io.StringIO()):
                check_blog.main(list(arguments))
        finally:
            check_blog.ROOT = original_root

    def test_markdown_preserves_literal_escapes_tex_and_exact_code(self):
        current = {"id": 7, "content_html": render_markdown(BODY)}
        reference = {"id": 7, "content_html": REFERENCE_HTML}
        check_blog.assert_preserved_content(reference, current, {})
        document = check_blog.source_document(current)
        self.assertEqual(check_blog.original_formulas(document), [r"$x_i \times y_j$"])
        self.assertEqual([check_blog.content(n) for n in check_blog.nodes(document) if n.tag == "code"], ["int x = a & b;  \n"])

    def test_original_comparison_detects_markdown_conversion_regressions(self):
        reference = {"id": 7, "content_html": REFERENCE_HTML}
        changes = {
            "literal escapes": BODY.replace(r"\*号\*", "*号*"),
            "TeX": BODY.replace(r"\times", r"\cdot"),
            "code": BODY.replace("a & b", "a | b"),
            "heading hierarchy": BODY.replace("## 标题", "### 标题"),
        }
        for label, markdown in changes.items():
            with self.subTest(label=label):
                with self.assertRaises(AssertionError):
                    check_blog.assert_preserved_content(reference, {"id": 7, "content_html": render_markdown(markdown)}, {})

    def test_escaped_dollar_and_code_dollars_do_not_become_formulas(self):
        markdown = r"价格 \$5，公式 $a_b$，代码 `$literal`。" + "\n\n```text\n$code$\n```\n"
        self.write_source(FRONTMATTER + markdown)
        self.prepare_build()
        self.build()
        self.check()
        document = check_blog.read_document(self.project / "blog/posts/7/index.html")
        prose = next(n for n in check_blog.nodes(document) if check_blog.has_class(n, "prose"))
        self.assertIn("价格 $5", check_blog.canonical(prose, True))
        self.assertEqual([n.attrs["data-original-math"] for n in check_blog.nodes(prose) if "data-original-math" in n.attrs], ["$a_b$"])
        self.assertEqual([check_blog.content(n) for n in check_blog.nodes(prose) if n.tag == "code"], ["$literal", "$code$\n"])

    def test_metadata_and_file_hash_come_from_formal_source(self):
        batch = self.load()
        self.assertEqual(batch["count"], 1)
        source = batch["posts"][0]
        self.assertEqual(source["source_file"], "content/blog/posts/7.md")
        self.assertEqual(source["source_sha256"], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(source["date"], "2020-02-03T04:05:06")
        self.assertEqual(source["categories"], [13])
        self.assertEqual(source["tags"], [2])
        self.assertEqual(source["summary"], "可独立维护的摘要")

    def test_yaml_metadata_is_plain_text_without_double_entity_decoding(self):
        metadata = FRONTMATTER.replace('title: "临时校验"', 'title: "A &lt; B"').replace('name: "笔记"', 'name: "C &amp; D"').replace('name: "C++"', 'name: "E &lt; F"')
        self.write_source(metadata + BODY)
        self.prepare_build()
        self.build()
        self.check()
        document = check_blog.read_document(self.project / "blog/posts/7/index.html")
        title = next(n for n in check_blog.nodes(document) if n.tag == "h1")
        self.assertEqual(check_blog.canonical(title), "A &lt; B")

    def test_build_uses_changed_markdown_and_default_check_allows_edits(self):
        self.prepare_build()
        original = self.load()
        # Use independently written HTML, rather than accepting the loader's own output as evidence.
        reference = dict(original["posts"][0])
        reference["content_html"] = REFERENCE_HTML
        reference["content_sha256"] = hashlib.sha256(REFERENCE_HTML.encode()).hexdigest()
        archive = {"visibility": "anonymous-public-only", "posts": [reference], "pages": [], "categories": original["categories"], "tags": original["tags"]}
        self.build()
        self.check()
        self.assertFalse((self.project / "migration/sources").exists())
        target = self.project / "blog/posts/7/index.html"
        first_page = target.read_text(encoding="utf-8")
        first_report = json.loads((self.project / "migration/public-batch.json").read_text(encoding="utf-8"))
        self.assertIn("源哨兵 alpha", first_page)
        snapshot = self.project / "migration/sources/public-2026-10-23.json"
        snapshot.parent.mkdir()
        (snapshot.parent / "media.json").write_text("[]\n", encoding="utf-8")
        (snapshot.parent / "legacy-anchors.json").write_text(json.dumps({"visibility": "anonymous-public-only", "anchors": []}), encoding="utf-8")
        snapshot.write_text(json.dumps(archive, ensure_ascii=False), encoding="utf-8")
        self.check("--original-snapshot")
        self.write_source((FRONTMATTER + BODY).replace("源哨兵 alpha", "源哨兵 beta"))
        self.build()
        self.check()
        second_page = target.read_text(encoding="utf-8")
        second_report = json.loads((self.project / "migration/public-batch.json").read_text(encoding="utf-8"))
        self.assertIn("源哨兵 beta", second_page)
        self.assertNotIn("源哨兵 alpha", second_page)
        self.assertNotEqual(first_report["posts"][0]["source_sha256"], second_report["posts"][0]["source_sha256"])
        with self.assertRaisesRegex(AssertionError, "original snapshot"):
            self.check("--original-snapshot")

    def test_deleting_registered_source_fails_build_instead_of_using_snapshot(self):
        self.prepare_build()
        self.build()
        self.source.unlink()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.load()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.build()

    def test_corrupt_frontmatter_fails_load_and_build(self):
        self.prepare_build()
        self.write_source((FRONTMATTER + BODY).replace('title: "临时校验"', "title: [unterminated"))
        with self.assertRaises(ValueError):
            self.load()
        with self.assertRaises(ValueError):
            self.build()

    def test_invalid_metadata_fails(self):
        mutations = {
            "filename id": ("id: 7", "id: 8"),
            "type directory": ("type: post", "type: page"),
            "timezone": ("+08:00", "+00:00"),
            "missing title": ('title: "临时校验"\n', ""),
        }
        for label, (before, after) in mutations.items():
            with self.subTest(label=label):
                self.write_source((FRONTMATTER + BODY).replace(before, after))
                with self.assertRaises(ValueError):
                    read_document(self.source, expected_type="post")

    def test_missing_formal_manifests_fail_without_snapshot_fallback(self):
        self.prepare_build()
        for filename in ("collection.yaml", "resources.yaml"):
            with self.subTest(filename=filename):
                manifest = self.content / filename
                original = manifest.read_bytes()
                manifest.unlink()
                try:
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        self.load()
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        self.build()
                finally:
                    manifest.write_bytes(original)

    def test_collection_rejects_duplicate_traversal_and_unregistered_sources(self):
        for label, collection in {
            "duplicate": COLLECTION.replace("pages: []", "  - posts/7.md\npages: []"),
            "traversal": COLLECTION.replace("posts/7.md", "../outside.md"),
        }.items():
            with self.subTest(label=label):
                self.collection.write_text(collection, encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.load()
        self.collection.write_text(COLLECTION, encoding="utf-8")
        (self.content / "posts/8.md").write_text((FRONTMATTER + BODY).replace("id: 7", "id: 8"), encoding="utf-8")
        with self.assertRaises(ValueError):
            self.load()


if __name__ == "__main__":
    unittest.main(verbosity=2)
