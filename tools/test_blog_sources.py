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
        (self.content / "friends.yaml").write_text("version: 1\nlinks:\n- name: Example\n  url: https://example.com/\n", encoding="utf-8")
        (self.content / "features.yaml").write_text("version: 1\ncomments:\n  enabled: false\n  api_base: ''\n  moderation: required\nvisits:\n  enabled: false\n  api_base: ''\n", encoding="utf-8")
        (self.content / "comments").mkdir()
        (self.content / "comments/index.yaml").write_text("version: 1\nfiles: []\ncount: 0\n", encoding="utf-8")
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
        shutil.copyfile(PROJECT / "tools/render_comment_admin.mjs", tools / "render_comment_admin.mjs")
        shutil.copyfile(PROJECT / "tools/render_article_editor.mjs", tools / "render_article_editor.mjs")
        admin_sources = self.project / "services/blog-api/src"
        admin_sources.mkdir(parents=True)
        for source in (PROJECT / "services/blog-api/src").glob("admin*.mjs"):
            shutil.copyfile(source, admin_sources / source.name)
        shutil.copyfile(PROJECT / "services/blog-api/src/article-editor.mjs", admin_sources / "article-editor.mjs")
        # No migration/sources directory exists: none of the original JSON can be a build input.
        (self.project / "migration").mkdir()
        for relative in ("assets/favicon.svg", "assets/x-script-icon.svg"):
            path = self.project / relative
            path.parent.mkdir(exist_ok=True)
            path.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8")
        katex_style = self.project / "assets/vendor/katex/katex.min.css"
        katex_style.parent.mkdir(parents=True)
        katex_style.write_text("/* Style fixture; visual fonts are checked on the real site. */", encoding="utf-8")
        shutil.copyfile(PROJECT / "assets/vendor/katex/katex.min.js", katex_style.with_name("katex.min.js"))
        (self.project / "blog").mkdir()
        for relative in ("blog/blog.css", "blog/blog.js", "blog/interactions.js", "blog/visits.js"):
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

    def test_comment_management_is_generated_and_uses_only_the_configured_api(self):
        self.prepare_build()
        self.build()
        self.check()
        admin = self.project / "blog/comment/index.html"
        self.assertIn('data-admin-enabled="false"', admin.read_text(encoding="utf-8"))
        features = self.content / "features.yaml"
        features.write_text(features.read_text(encoding="utf-8").replace("api_base: ''", "api_base: 'https://comments.example.test'", 1), encoding="utf-8")
        self.build()
        self.check()
        document = admin.read_text(encoding="utf-8")
        self.assertIn('data-admin-enabled="true"', document)
        self.assertIn('data-admin-api="https://comments.example.test"', document)
        # Closing public submissions must not lock the owner out of moderation.
        self.assertIn('data-comments-enabled="false"', (self.project / "blog/posts/7/index.html").read_text(encoding="utf-8"))
        admin.write_text(document.replace('data-admin-api="https://comments.example.test"', 'data-admin-api="https://unexpected.example"'), encoding="utf-8")
        with self.assertRaises(AssertionError):
            self.check()

    def test_enabled_visits_config_and_document_ids_are_checked(self):
        self.prepare_build()
        homepage = self.project / "index.html"
        original_homepage = homepage.read_bytes()
        self.build()
        self.check()
        self.assertEqual(homepage.read_bytes(), original_homepage)
        self.assertFalse((self.project / "blog/visits-config.js").exists())
        features = self.content / "features.yaml"
        features.write_text(features.read_text(encoding="utf-8").replace("visits:\n  enabled: false\n  api_base: ''", "visits:\n  enabled: true\n  api_base: https://visits.example.test"), encoding="utf-8")
        self.build()
        self.check()
        self.assertEqual(homepage.read_bytes(), original_homepage)
        self.assertFalse((self.project / "blog/visits-config.js").exists())
        blog_homepage = (self.project / "blog/index.html").read_text(encoding="utf-8")
        self.assertIn('data-visits-enabled="true" data-blog-api="https://visits.example.test" data-document-id=""', blog_homepage)
        self.assertRegex(blog_homepage, r'<strong\b[^>]*\bdata-site-visits>')
        self.assertNotIn('data-document-visits>', blog_homepage)
        self.build()
        self.assertEqual(homepage.read_bytes(), original_homepage)
        article = self.project / "blog/posts/7/index.html"
        original = article.read_text(encoding="utf-8")
        self.assertIn('data-visits-enabled="true" data-blog-api="https://visits.example.test" data-document-id="7"', original)
        article.write_text(original.replace('data-visits-enabled="true" data-blog-api="https://visits.example.test" data-document-id="7"', 'data-visits-enabled="true" data-blog-api="https://visits.example.test" data-document-id="8"', 1), encoding="utf-8")
        with self.assertRaises(AssertionError):
            self.check()
        article.write_text(original, encoding="utf-8")

    def test_personal_homepage_cannot_load_or_display_blog_visits(self):
        self.prepare_build()
        self.build()
        self.check()
        homepage = self.project / "index.html"
        original = homepage.read_text(encoding="utf-8")
        for injected in (
            '<p data-blog-visits hidden><span data-site-visits>0</span></p>',
            '<script defer src="/blog/visits.js?v=2"></script>',
            '<script defer src="/blog/visits-config.js?v=old"></script>',
        ):
            with self.subTest(injected=injected):
                homepage.write_text(original + injected, encoding="utf-8")
                with self.assertRaises(AssertionError):
                    self.check()
        homepage.write_text(original, encoding="utf-8")

    def test_shared_admin_client_changes_require_a_rebuild(self):
        self.prepare_build()
        self.build()
        client = self.project / "services/blog-api/src/admin-client.mjs"
        value = client.read_text(encoding="utf-8")
        marker = "// isolated management-source rebuild evidence"
        client.write_text(value.replace("function initAdmin() {", "function initAdmin() {\n  " + marker, 1), encoding="utf-8")
        with self.assertRaises(AssertionError):
            self.check()
        self.build()
        self.check()
        self.assertIn(marker, (self.project / "blog/comment/admin.js").read_text(encoding="utf-8"))

    def test_comments_are_loaded_from_one_service_without_static_reviving_records(self):
        self.prepare_build()
        features = self.content / "features.yaml"
        features.write_text("version: 1\ncomments:\n  enabled: true\n  api_base: https://comments.example.test\n  moderation: required\nvisits:\n  enabled: false\n  api_base: ''\n", encoding="utf-8")
        comment = {"id": 17, "post": 7, "parent": 0, "author_name": "Public author sentinel", "author_url": "", "date": "2020-01-02T08:00:00", "date_gmt": "2020-01-02T00:00:00", "content": {"rendered": "<p>Public comment sentinel $x_i$</p>"}, "link": "https://www.xht37.com/temporary/#comment-17", "type": "comment", "status": "approved"}
        (self.content / "comments/index.yaml").write_text("version: 1\nfiles: [7.yaml]\ncount: 1\n", encoding="utf-8")
        (self.content / "comments/7.yaml").write_text(json.dumps({"version": 1, "post_id": 7, "comments": [comment]}), encoding="utf-8")
        self.build()
        self.check()
        article = self.project / "blog/posts/7/index.html"
        value = article.read_text(encoding="utf-8")
        self.assertNotIn("Public comment sentinel", value)
        self.assertNotIn("Public author sentinel", value)
        self.assertNotIn("历史评论", value)
        self.assertNotIn("本文迁自", value)
        self.assertIn('<ol class="comment-list" data-comment-list></ol>', value)
        self.assertIn('/assets/vendor/katex/katex.min.js?v=0.19.0', value)
        article.write_text(value.replace('<ol class="comment-list" data-comment-list></ol>', '<ol class="comment-list" data-comment-list><li data-comment-id="wp-17">stale</li></ol>'), encoding="utf-8")
        with self.assertRaises(AssertionError):
            self.check()

    def test_each_document_editor_uses_fixed_api_and_has_no_embedded_source(self):
        self.prepare_build()
        self.build()
        self.check()
        editor = self.project / "blog/posts/7/exit/index.html"
        document = editor.read_text(encoding="utf-8")
        self.assertIn('data-document-id="7"', document)
        self.assertIn('autocomplete="current-password"', document)
        self.assertIn('name="username"', document)
        self.assertNotIn("源哨兵 alpha", document)
        self.assertIn('<textarea id="source"', document)
        editor.write_text(document.replace('</textarea>', 'tampered draft</textarea>'), encoding="utf-8")
        with self.assertRaises(AssertionError):
            self.check()
        self.build()
        editor.unlink()
        with self.assertRaises((AssertionError, FileNotFoundError)):
            self.check()

    def test_independent_page_has_the_same_editor_and_no_origin_badge(self):
        page = self.content / "pages/8.md"
        metadata = FRONTMATTER.replace("id: 7", "id: 8", 1).replace("type: post", "type: page").replace('title: "临时校验"', 'title: "临时页面"').replace("slug: temporary", "slug: temporary-page").replace('https://www.xht37.com/temporary/', 'https://www.xht37.com/temporary-page/')
        metadata = metadata[:metadata.index("categories:")] + "categories: []\ntags: []\n---\n\n"
        page.write_text(metadata + "这是一篇独立页面。\n", encoding="utf-8")
        self.collection.write_text(COLLECTION.replace("pages: []", "pages:\n  - pages/8.md"), encoding="utf-8")
        self.prepare_build()
        self.build()
        self.check()
        document = (self.project / "blog/pages/8/index.html").read_text(encoding="utf-8")
        self.assertNotIn("历史", document)
        self.assertNotIn("本文迁自", document)
        self.assertIn("这是一篇独立页面。", document)
        self.assertTrue((self.project / "blog/pages/8/exit/index.html").is_file())

    def test_only_the_authorized_orphan_link_removal_passes_original_comparison(self):
        removed_url = "https://www.xht37.com/zroi-19-csp-s-模拟赛十联测-day1-题解/#lwptoc2"
        reference = {"id": 925, "content_html": '<p>基本上就是 <a href="' + removed_url + '">这题</a>。</p><p><a href="https://example.test/">another</a></p>'}
        current = {"id": 925, "content_html": '<p>基本上就是 这题。</p><p><a href="https://example.test/">another</a></p>'}
        check_blog.assert_preserved_content(reference, current, {})
        with self.assertRaises(AssertionError):
            check_blog.assert_preserved_content(reference, {**current, "content_html": current["content_html"].replace("https://example.test/", "https://other.example.test/")}, {})
        with self.assertRaises(AssertionError):
            check_blog.assert_preserved_content(reference, {**current, "content_html": current["content_html"].replace("这题", "另一题")}, {})

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

    def test_standard_breaks_and_math_preserve_source(self):
        markdown = "第一行\n第二行 $f*g$ 与 $fwt[a]$。  \n显式换行。\n\n```text\nfirst\nsecond\n```\n"
        self.write_source(FRONTMATTER + markdown)
        self.prepare_build()
        self.build()
        document = check_blog.read_document(self.project / "blog/posts/7/index.html")
        prose = next(n for n in check_blog.nodes(document) if check_blog.has_class(n, "prose"))
        self.assertEqual(sum(n.tag == "br" for n in check_blog.nodes(prose)), 1)
        self.assertEqual([n.attrs["data-original-math"] for n in check_blog.nodes(prose) if "data-original-math" in n.attrs], [r"$f*g$", r"$fwt[a]$"])
        self.assertEqual([check_blog.content(n) for n in check_blog.nodes(prose) if n.tag == "code"], ["first\nsecond\n"])
        for source in (r"$f\*g$", r"$fwt\[a\]$", r"$\text{^}$", "$a–b$"):
            formula = build_blog.split_math(source, 7)[0]
            self.assertEqual(formula.tex, source[1:-1])
            self.assertEqual(formula.original, source)

    def test_standard_nested_list_strikethrough_and_table(self):
        source = "- 父项\n  - 子项 ~~删除~~\n  - 子项二\n- 同级\n\n| 列 | 值 |\n| --- | --- |\n| 一 | 二 |\n\n```text\n- code\n - still code\n```\n"
        rendered = render_markdown(source)
        self.assertIn("<li>父项\n<ul>", rendered)
        self.assertIn("<del>删除</del>", rendered)
        self.assertIn("<table>", rendered)
        self.assertIn("- code\n - still code\n", rendered)
        self.assertNotIn("<li>父项\n<ul>", render_markdown("- 父项\n - 子项\n"))

    def test_standard_math_aliases_preserve_formatted_source(self):
        self.write_source(FRONTMATTER + r"$p \lor q$, $p \land q$, $x \in \mathbb{Q}$." + "\n")
        self.prepare_build()
        self.build()
        document = check_blog.read_document(self.project / "blog/posts/7/index.html")
        prose = next(n for n in check_blog.nodes(document) if check_blog.has_class(n, "prose"))
        formulas = [n for n in check_blog.nodes(prose) if "data-original-math" in n.attrs]
        self.assertEqual([n.attrs["data-original-math"] for n in formulas], [r"$p \lor q$", r"$p \land q$", r"$x \in \mathbb{Q}$"])
        self.assertEqual(len(formulas), 3)
        page_html = (self.project / "blog/posts/7/index.html").read_text(encoding="utf-8")
        for expected in ("<mo>∨</mo>", "<mo>∧</mo>", '<mi mathvariant="double-struck">Q</mi>'):
            self.assertIn(expected, page_html)

    def test_legacy_math_aliases_and_escapes_are_rejected(self):
        self.prepare_build()
        for formula in (r"$p \or q$", r"$p \and q$", r"$x \in \Q$", r"$f\*g$", r"$fwt\[a\]$", r"$\text{^}$"):
            with self.subTest(formula=formula):
                self.write_source(FRONTMATTER + formula + "\n")
                with self.assertRaises(ValueError):
                    self.build()

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
        (snapshot.parent / "comments-public-2026-10-25.json").write_text(json.dumps({"visibility": "approved-public-comments-for-migrated-content", "scope_post_ids": [7], "count": 0, "comments": []}), encoding="utf-8")
        friend_html = '<aside><h4 class="widget-title">友情链接</h4><ul class="widget-links"><li><a href="https://example.com/">Example</a></li></ul></aside>'
        (snapshot.parent / "friends-public-2026-10-25.html").write_text(friend_html, encoding="utf-8")
        (snapshot.parent / "friends-public-2026-10-25.json").write_text(json.dumps({"source": "https://www.xht37.com/", "visibility": "anonymous-public-only", "scope": "sidebar-friend-links-only", "count": 1, "html_file": "friends-public-2026-10-25.html", "html_sha256": hashlib.sha256(friend_html.encode("utf-8")).hexdigest(), "links": [{"name": "Example", "url": "https://example.com/"}]}), encoding="utf-8")
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
