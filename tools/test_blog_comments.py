"""Offline checks for the public-only comment importer, source registry and HTML."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from blog_comments import COMMENT_FIELDS, load_comments, sanitize_comment_html, validate_comment, validate_thread
from sync_public_comments import fetch_approved_comments, inventory_comments, probe_type_coverage, query_url, request as api_request, write_new_snapshot, yaml_text


def comment(identifier=1, post=7, parent=0):
    return {"id": identifier, "post": post, "parent": parent, "author_name": "公开昵称", "author_url": "",
            "date": "2020-01-02T08:00:00", "date_gmt": "2020-01-02T00:00:00",
            "content": {"rendered": "<p>原文 $x_i$，<code>a &amp; b;  </code></p>\n"},
            "link": f"https://www.xht37.com/example/#comment-{identifier}", "type": "comment", "status": "approved"}


class Response(io.BytesIO):
    def __init__(self, values, total=None, pages=1):
        super().__init__(json.dumps(values, ensure_ascii=False).encode())
        self.status = 200
        self.headers = {"X-WP-Total": str(len(values) if total is None else total), "X-WP-TotalPages": str(pages)}


class PublicCommentsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="public-blog-comments-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.content = self.root / "content/blog"
        self.directory = self.content / "comments"
        self.directory.mkdir(parents=True)

    def write_sources(self, grouped):
        files = []
        for post_id, values in grouped.items():
            name = f"{post_id}.yaml"
            files.append(name)
            (self.directory / name).write_text(yaml_text({"version": 1, "post_id": post_id, "comments": values}), encoding="utf-8")
        (self.directory / "index.yaml").write_text(yaml_text({"version": 1, "files": files, "count": sum(map(len, grouped.values()))}), encoding="utf-8")

    def test_scope_is_required_and_queries_request_only_display_fields(self):
        with self.assertRaises(ValueError):
            query_url([])
        query = parse_qs(urlsplit(query_url([7, 8])).query)
        self.assertEqual(query["post"], ["7,8"])
        self.assertEqual(query["status"], ["approve"])
        self.assertEqual(query["context"], ["view"])
        self.assertEqual(set(query["_fields"][0].split(",")), COMMENT_FIELDS)
        for url in ("https://example.com/", "https://www.xht37.com/index.php?rest_route=/wp/v2/comments", "https://www.xht37.com/wp-admin/"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                api_request(url)

    def test_private_fields_unapproved_comments_and_other_posts_are_rejected(self):
        for field in ("author_email", "author_ip", "author_user_agent", "author_avatar_urls", "author"):
            value = comment()
            value[field] = "not retained"
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_comment(value, {7})
        for change in ({"status": "hold"}, {"post": 99}, {"content": {"rendered": "public", "raw": "not accepted"}}):
            value = {**comment(), **change}
            with self.subTest(change=list(change)), self.assertRaises(ValueError):
                validate_comment(value, {7})

    def test_pagination_checks_totals_uniqueness_and_explicit_post_scope(self):
        values = [comment(i) for i in range(1, 102)]
        responses = [Response(values[:100], total=101, pages=2), Response(values[100:], total=101, pages=2)]
        queries = []
        def fetch(url):
            queries.append(url)
            return responses.pop(0)
        result, urls, pages = fetch_approved_comments({7}, request_fn=fetch)
        self.assertEqual(len(result), 101)
        self.assertEqual(len({c["id"] for c in result}), 101)
        self.assertEqual([parse_qs(urlsplit(u).query)["page"][0] for u in urls], ["1", "2"])
        self.assertTrue(all(parse_qs(urlsplit(u).query)["post"] == ["7"] for u in queries))
        for changed in (Response([values[0]], total=101, pages=2), Response([values[-1]], total=102, pages=2)):
            responses = [Response(values[:100], total=101, pages=2), changed]
            with self.assertRaises(ValueError):
                fetch_approved_comments({7}, request_fn=lambda _: responses.pop(0))

    def test_forbidden_noncomment_type_is_recorded_without_login_or_bypass(self):
        calls = []
        def denied(url):
            calls.append(url)
            raise HTTPError(url, 401, "Forbidden query parameter", {}, io.BytesIO(b'{"code":"rest_forbidden_param"}'))
        selected, evidence = probe_type_coverage({7}, request_fn=denied)
        self.assertIsNone(selected)
        self.assertEqual(evidence["http_status"], 401)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("zero", evidence["api_types"])

    def test_loader_preserves_original_fields_and_gives_empty_lists_for_other_posts(self):
        first, reply = comment(), comment(2, parent=1)
        self.write_sources({7: [first, reply]})
        loaded = load_comments(self.content, {7, 8}, project_root=self.root)
        self.assertEqual(loaded["by_post"], {7: [first, reply], 8: []})
        self.assertEqual(loaded["count"], 2)
        self.assertEqual(loaded["sources"][7]["source_file"], "content/blog/comments/7.yaml")
        self.assertEqual(set(loaded["by_post"][7][0]), COMMENT_FIELDS)

    def test_missing_duplicate_extra_and_out_of_scope_archives_fail(self):
        self.write_sources({7: [comment()]})
        source = self.directory / "7.yaml"
        saved = source.read_bytes()
        source.unlink()
        with self.assertRaises(FileNotFoundError):
            load_comments(self.content, {7})
        source.write_bytes(saved)
        (self.directory / "8.yaml").write_text(yaml_text({"version": 1, "post_id": 8, "comments": [comment(2, post=8)]}), encoding="utf-8")
        with self.assertRaises(ValueError):
            load_comments(self.content, {7, 8})
        (self.directory / "8.yaml").unlink()
        for files in (["7.yaml", "7.yaml"], ["../7.yaml"], ["99.yaml"]):
            (self.directory / "index.yaml").write_text(yaml_text({"version": 1, "files": files, "count": 1}), encoding="utf-8")
            with self.subTest(files=files), self.assertRaises((ValueError, FileNotFoundError)):
                load_comments(self.content, {7})

    def test_reply_cycles_missing_parents_and_cross_document_ids_fail(self):
        for values in ([comment(1, parent=1)], [comment(1, parent=2), comment(2, parent=1)], [comment(1, parent=99)]):
            with self.assertRaises(ValueError):
                validate_thread(values, 7)
        self.write_sources({7: [comment()], 8: [comment(post=8)]})
        with self.assertRaises(ValueError):
            load_comments(self.content, {7, 8})

    def test_sanitizer_retains_text_tex_code_and_safe_markup(self):
        original = comment()["content"]["rendered"]
        self.assertEqual(sanitize_comment_html(original), original)
        result = sanitize_comment_html('<p onclick="bad()">safe <a href="javascript:bad()">label</a><script>bad()</script><iframe src="https://example.com/">bad</iframe></p>')
        self.assertEqual(result, "<p>safe <a>label</a></p>")
        result = sanitize_comment_html('<a href="https://example.com/a" style="display:none">link</a>')
        self.assertIn('rel="nofollow noopener noreferrer"', result)
        self.assertNotIn("style=", result)
        with self.assertRaises(ValueError):
            sanitize_comment_html('<img src="https://example.com/new.png" onerror="bad()">')

    def test_inventory_excludes_code_dollars_and_preserves_exact_formulas(self):
        value = comment()
        value["content"]["rendered"] = '<p>$x_i$ 与 $$a\\times b$$<br>继续</p><pre><code>$not_math$</code></pre>'
        stats = inventory_comments([value])
        self.assertEqual([x["original"] for x in stats["formulas"]], ["$x_i$", r"$$a\times b$$"])
        self.assertEqual(stats["image_urls"], [])
        self.assertEqual(stats["unclosed_math_comment_ids"], [])

    def test_empty_index_is_valid_and_snapshot_import_refuses_overwrite(self):
        self.write_sources({})
        loaded = load_comments(self.content, {7}, project_root=self.root)
        self.assertEqual(loaded["by_post"], {7: []})
        snapshot = {"comments": [comment()], "count": 1, "scope_post_ids": [7]}
        with self.assertRaises(FileExistsError):
            write_new_snapshot(snapshot, self.content, self.root / "original.json")


if __name__ == "__main__":
    unittest.main(verbosity=2)
