"""Safety checks for the native Markdown candidate boundary."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import adopt_native_blog as adoption
import check_native_blog as checker


class NativePublicBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.archive = Path(self.temp.name)
        (self.archive / "documents").mkdir()
        self.record = {"version": 1, "id": 1, "type": "post", "status": "publish", "visibility": "public", "title": "example", "markdown": "# test\n", "sha256": hashlib.sha256(b"# test\n").hexdigest(), "captured_at": "2026-10-28T16:22:31.046Z", "source_url": "https://www.xht37.com/wp-admin/post.php?post=1&action=edit", "editor_heading": "编辑文章", "status_label": "已发布", "visibility_label": "公开"}
        self.inventory = {1: {"title": "example"}}

    def tearDown(self):
        self.temp.cleanup()

    def write_record(self):
        (self.archive / "documents/1.json").write_text(json.dumps(self.record), encoding="utf-8")

    def test_exact_raw_and_hash(self):
        self.write_record()
        raw, title, provenance = adoption.read_public(self.archive, 1, "post", self.inventory)
        self.assertEqual((raw, title), ("# test\n", "example"))
        self.assertEqual(provenance["json_sha256"], hashlib.sha256((self.archive / "documents/1.json").read_bytes()).hexdigest())
        self.record["markdown"] += "tampered"
        self.write_record()
        with self.assertRaises(ValueError):
            adoption.read_public(self.archive, 1, "post", self.inventory)

    def test_reject_private_and_wrong_identity(self):
        for key, value in (("visibility", "private"), ("status", "private"), ("id", 2), ("type", "page")):
            with self.subTest(key=key):
                original = self.record[key]
                self.record[key] = value
                self.write_record()
                with self.assertRaises(ValueError):
                    adoption.read_public(self.archive, 1, "post", self.inventory)
                self.record[key] = original

    def test_reject_unverified_editor_context(self):
        for key, value in (("source_url", "https://www.xht37.com/wp-admin/post.php?post=2&action=edit"), ("source_url", "https://user@www.xht37.com/wp-admin/post.php?post=1&action=edit"), ("source_url", "https://www.xht37.com/wp-admin/post.php?post=1&action=edit&extra=1"), ("editor_heading", "编辑页面"), ("status_label", "私密"), ("visibility_label", "私密"), ("captured_at", "invalid")):
            with self.subTest(key=key, value=value):
                original = self.record[key]
                self.record[key] = value
                self.write_record()
                with self.assertRaises(ValueError):
                    adoption.read_public(self.archive, 1, "post", self.inventory)
                self.record[key] = original

    def test_published_sticky_is_public(self):
        self.record["visibility_label"] = "公开、置顶"
        self.write_record()
        self.assertEqual(adoption.read_public(self.archive, 1, "post", self.inventory)[2]["visibility_label"], "公开、置顶")
        self.record["visibility"] = "protected"
        self.write_record()
        with self.assertRaises(ValueError):
            adoption.read_public(self.archive, 1, "post", self.inventory)

    def test_925_fails_closed_on_unknown_source(self):
        with self.assertRaises(ValueError):
            adoption.maintained_body(925, "unverified link")

    def test_only_dash_title_equivalence(self):
        evidence = adoption.title_equivalence(194, "A – B", "A – B", "A - B")
        self.assertEqual(evidence["captured_title"], "A - B")
        with self.assertRaises(ValueError):
            adoption.title_equivalence(194, "A – B", "A – B", "A - C")

    def test_formal_check_reads_public_snapshot_and_detects_changes(self):
        prefix = "---\nid: 1\ntype: post\ntitle: example\n---\n"
        body = "# raw\n"
        path = self.archive / "content/blog/posts/1.md"
        path.parent.mkdir(parents=True)
        path.write_bytes((prefix + body).encode("utf-8"))
        provenance = {key: self.record[key] for key in ("captured_at", "source_url", "editor_heading", "status_label", "visibility_label")}
        provenance["json_sha256"] = "a" * 64
        snapshot = {"version": 1, "complete": True, "documents": [{"id": 1, "type": "post", "status": "publish", "visibility": "public", "title": "example", "markdown": body, "native_sha256": adoption.digest(body), "body_sha256": adoption.digest(body), "header_sha256": adoption.digest(prefix), "title_equivalence": None, "patches": [], "provenance": provenance}]}
        snapshot_path = self.archive / "snapshot.json"
        snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
        with mock.patch.object(adoption, "ROOT", self.archive), mock.patch.object(adoption, "public_documents", return_value={1: ("post", "posts/1.md")}), mock.patch.object(adoption, "header", return_value=prefix):
            checker.formal_check(snapshot_path)
            with mock.patch.object(adoption, "read_public", return_value=(body, "example", provenance)):
                checker.formal_check(snapshot_path, self.archive)
            with mock.patch.object(adoption, "read_public", return_value=(body, "example", {**provenance, "json_sha256": "b" * 64})):
                with self.assertRaises(ValueError):
                    checker.formal_check(snapshot_path, self.archive)
            path.write_text(prefix + "# changed\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                checker.formal_check(snapshot_path)
            path.write_bytes((prefix + body).encode("utf-8"))
            snapshot["documents"][0]["visibility"] = "private"
            snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
            with self.assertRaises(ValueError):
                checker.formal_check(snapshot_path)

    def test_apply_rolls_back_and_preserves_intervening_edit(self):
        for preserve in (False, True):
            with self.subTest(preserve=preserve), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                candidate = root / "candidate"
                entries = {}
                for identity in (1, 2):
                    member = f"posts/{identity}.md"
                    current = root / "content/blog" / member
                    current.parent.mkdir(parents=True, exist_ok=True)
                    current.write_bytes(b"original")
                    proposed = candidate / member
                    proposed.parent.mkdir(parents=True, exist_ok=True)
                    proposed.write_bytes(b"candidate")
                    entries[identity] = {"path": member, "current_source_sha256": hashlib.sha256(b"original").hexdigest(), "candidate_source_sha256": hashlib.sha256(b"candidate").hexdigest()}
                calls = []
                def failing_replace(source, target):
                    calls.append(target)
                    if len(calls) == 2:
                        if preserve:
                            (root / "content/blog/posts/1.md").write_bytes(b"user edit")
                        raise OSError("simulated failure")
                    Path(target).write_bytes(Path(source).read_bytes())
                    Path(source).unlink()
                with mock.patch.object(adoption, "ROOT", root), mock.patch.object(checker.os, "replace", side_effect=failing_replace):
                    with self.assertRaises(RuntimeError):
                        checker.apply_candidates(candidate, entries)
                self.assertEqual((root / "content/blog/posts/1.md").read_bytes(), b"user edit" if preserve else b"original")
                journal = json.loads((candidate / "apply-journal/journal.json").read_text(encoding="utf-8"))
                self.assertEqual(journal["documents"][0]["state"], "rollback-skipped-current-changed" if preserve else "rolled-back", journal)

    def test_apply_rejects_changed_candidate_before_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current = root / "content/blog/posts/1.md"
            candidate = root / "candidate"
            proposed = candidate / "posts/1.md"
            current.parent.mkdir(parents=True)
            proposed.parent.mkdir(parents=True)
            current.write_bytes(b"original")
            proposed.write_bytes(b"changed candidate")
            entries = {1: {"path": "posts/1.md", "current_source_sha256": hashlib.sha256(b"original").hexdigest(), "candidate_source_sha256": hashlib.sha256(b"candidate").hexdigest()}}
            with mock.patch.object(adoption, "ROOT", root), self.assertRaises(RuntimeError):
                checker.apply_candidates(candidate, entries)
            self.assertEqual(current.read_bytes(), b"original")


if __name__ == "__main__":
    unittest.main()
