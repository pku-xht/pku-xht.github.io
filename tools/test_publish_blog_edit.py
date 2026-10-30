"""Exercise editor publication safety in isolated, local-only Git repositories.

No test pushes to a remote or contacts GitHub. The remote-advance test uses a
temporary bare repository solely for the read-only ls-remote preflight.
"""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import publish_blog_edit as publisher


REFERENCE = "refs/heads/codex/article-edit/11111111-1111-4111-8111-111111111111"
FRONTMATTER = """---
id: 7
type: post
title: 测试文章
date: '2020-01-02T08:00:00+08:00'
modified: '2020-01-02T08:00:00+08:00'
slug: example
original_url: https://www.xht37.com/example/
categories: []
tags: []
---

"""
ORIGINAL = FRONTMATTER + "## 正文\n\n原来内容。\n"
UPDATED = FRONTMATTER.replace("title: 测试文章", "title: 修改后的文章") + "## 正文\n\n新内容与 $x_i$。\n"


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="blog-editor-git-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout"
        self.root.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Local publisher test")
        self.git("config", "user.email", "publisher-test@example.invalid")
        self.git("config", "core.autocrlf", "false")
        self.write("content/blog/posts/7.md", ORIGINAL)
        self.write("content/blog/collection.yaml", "version: 1\nposts:\n- posts/7.md\npages: []\n")
        self.write("blog/posts/7/index.html", "<p>原来内容。</p>\n")
        self.write("migration/public-batch.json", '{"version":1}\n')
        self.write("unrelated.txt", "原有记录\n")
        self.base = self.commit("Original source and generated page")

    def git(self, *arguments):
        return subprocess.run(["git", *arguments], cwd=self.root, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode("utf-8").strip()

    def write(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(value)

    def commit(self, message):
        self.git("add", "--all")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def candidate(self, value=UPDATED, other=None):
        self.git("checkout", "-b", "proposal")
        self.write("content/blog/posts/7.md", value)
        if other:
            self.write(*other)
        candidate = self.commit("Proposed public article edit")
        self.git("checkout", "main")
        return candidate

    def prepare(self, candidate):
        return publisher.prepare_proposal(self.root, candidate, REFERENCE)

    def assert_rejected(self, candidate, code):
        before = self.git("rev-parse", "HEAD")
        old_source = (self.root / "content/blog/posts/7.md").read_bytes()
        with self.assertRaises(publisher.PublishError) as caught:
            self.prepare(candidate)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(self.git("rev-parse", "HEAD"), before)
        self.assertEqual((self.root / "content/blog/posts/7.md").read_bytes(), old_source)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_valid_proposal_changes_working_source_without_committing_or_changing_url(self):
        candidate = self.candidate()
        state = self.prepare(candidate)
        self.assertEqual(state["source_path"], "content/blog/posts/7.md")
        self.assertEqual(state["document"], "7")
        self.assertFalse(state["already_applied"])
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)
        self.assertEqual((self.root / state["source_path"]).read_text(encoding="utf-8"), UPDATED)
        self.assertEqual(self.git("diff", "--name-only"), state["source_path"])

    def test_unregistered_and_outside_paths_are_rejected(self):
        self.git("checkout", "-b", "proposal")
        self.write("unrelated.txt", "不能由编辑器修改\n")
        candidate = self.commit("Outside article path")
        self.git("checkout", "main")
        self.assert_rejected(candidate, "invalid_path")

    def test_multiple_files_or_workflow_changes_are_rejected_before_source_write(self):
        candidate = self.candidate(other=(".github/workflows/evil.yml", "on: push\n"))
        self.assert_rejected(candidate, "invalid_candidate")

    def test_changed_document_sha_is_a_conflict(self):
        candidate = self.candidate()
        self.write("content/blog/posts/7.md", ORIGINAL + "\n另一个编辑者的修改。\n")
        self.commit("Concurrent same-document edit")
        self.assert_rejected(candidate, "source_conflict")

    def test_unrelated_main_advances_are_preserved(self):
        candidate = self.candidate()
        self.write("unrelated.txt", "main 上更新后的记录\n")
        advanced = self.commit("Unrelated main update")
        state = self.prepare(candidate)
        self.assertEqual(state["base_head"], advanced)
        self.assertEqual((self.root / "unrelated.txt").read_text(encoding="utf-8"), "main 上更新后的记录\n")
        self.assertEqual(self.git("diff", "--name-only"), "content/blog/posts/7.md")

    def test_invalid_yaml_never_modifies_main_source(self):
        candidate = self.candidate(UPDATED.replace("tags: []", "tags: [invalid"))
        self.assert_rejected(candidate, "invalid_source")

    def test_changed_identity_or_original_url_is_rejected(self):
        for before, after in (("id: 7", "id: 8"), ("slug: example", "slug: changed"), ("https://www.xht37.com/example/", "https://example.invalid/changed/")):
            with self.subTest(field=before):
                branch = "proposal-" + str(len(self.git("branch").splitlines()))
                self.git("checkout", "-b", branch)
                self.write("content/blog/posts/7.md", UPDATED.replace(before, after))
                candidate = self.commit("Invalid identity")
                self.git("checkout", "main")
                self.assert_rejected(candidate, "invalid_source")

    def test_dirty_checkout_is_never_overwritten(self):
        candidate = self.candidate()
        self.write("unrelated.txt", "尚未保存的用户修改\n")
        with self.assertRaises(publisher.PublishError) as caught:
            self.prepare(candidate)
        self.assertEqual(caught.exception.code, "dirty_checkout")
        self.assertEqual((self.root / "content/blog/posts/7.md").read_text(encoding="utf-8"), ORIGINAL)
        self.assertEqual((self.root / "unrelated.txt").read_text(encoding="utf-8"), "尚未保存的用户修改\n")

    def test_source_and_generated_page_are_committed_together(self):
        candidate = self.candidate()
        state = self.prepare(candidate)
        self.write("blog/posts/7/index.html", "<p>新内容与公式。</p>\n")
        self.write("blog/posts/7/exit/index.html", "<p>文章编辑</p>\n")
        self.write("blog/editor/editor.js", '"use strict";\n')
        self.write("blog/visits-config.js", 'window.SITE_VISITS_CONFIG = {};\n')
        self.write("migration/public-batch.json", '{"version":2}\n')
        revision = publisher.commit_build(self.root, state)
        self.assertNotEqual(revision, self.base)
        self.assertEqual(self.git("show", "-s", "--format=%P", revision), self.base)
        self.assertEqual(set(self.git("diff-tree", "--no-commit-id", "--name-only", "-r", revision).splitlines()), {
            "content/blog/posts/7.md", "blog/posts/7/index.html", "blog/posts/7/exit/index.html", "blog/editor/editor.js", "blog/visits-config.js", "migration/public-batch.json",
        })
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_generated_visits_config_path_is_exact(self):
        source = "content/blog/posts/7.md"
        self.assertTrue(publisher.allowed_output("blog/visits-config.js", source))
        self.assertFalse(publisher.allowed_output("blog/visits-config.js.extra", source))
        self.assertFalse(publisher.allowed_output("index.html", source))

    def test_unexpected_build_output_cannot_be_staged_or_committed(self):
        candidate = self.candidate()
        state = self.prepare(candidate)
        self.write("services/blog-api/src/worker.mjs", "throw new Error('must never publish');\n")
        with self.assertRaises(publisher.PublishError) as caught:
            publisher.commit_build(self.root, state)
        self.assertEqual(caught.exception.code, "unexpected_change")
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), "")

    def test_duplicate_event_recognizes_the_identical_source_without_reapplying_it(self):
        candidate = self.candidate()
        state = self.prepare(candidate)
        self.write("blog/posts/7/index.html", "<p>新内容。</p>\n")
        first = publisher.commit_build(self.root, state)
        duplicate = self.prepare(candidate)
        self.assertTrue(duplicate["already_applied"])
        self.assertEqual(duplicate["base_head"], first)
        self.assertEqual(publisher.commit_build(self.root, duplicate), first)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_delayed_successful_duplicate_preserves_a_later_same_document_edit(self):
        candidate = self.candidate()
        state = self.prepare(candidate)
        self.write("blog/posts/7/index.html", "<p>A 已发布。</p>\n")
        publisher.commit_build(self.root, state)
        later_source = UPDATED + "\nB 后来发布的新内容。\n"
        self.write("content/blog/posts/7.md", later_source)
        latest_main = self.commit("A later same-document edit B")
        api = FakeAPI([{"statuses": [{"context": "blog-publish", "state": "success"}]}])

        with patch.object(publisher, "git", side_effect=AssertionError("A successful duplicate must not fetch or modify Git")), \
                patch.object(publisher.subprocess, "run", side_effect=AssertionError("A successful duplicate must not rebuild")), \
                patch.object(publisher, "push_build", side_effect=AssertionError("A successful duplicate must not push")):
            duplicate = publisher.run_publication(
                self.root, candidate, REFERENCE, api,
                "https://github.com/pku-xht/pku-xht.github.io/actions/runs/456",
            )

        self.assertEqual(duplicate["stage"], "published")
        self.assertTrue(duplicate["already_published"])
        self.assertIsNone(duplicate["saved_commit"])
        self.assertEqual(api.calls, [("GET", "/commits/" + candidate + "/status", None)])
        self.assertEqual(self.git("rev-parse", "HEAD"), latest_main)
        self.assertEqual((self.root / "content/blog/posts/7.md").read_text(encoding="utf-8"), later_source)
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_remote_advance_stops_before_any_push_and_retains_its_update(self):
        candidate = self.candidate()
        state = self.prepare(candidate)
        self.write("blog/posts/7/index.html", "<p>新内容。</p>\n")
        proposed = publisher.commit_build(self.root, state)
        self.write("unrelated.txt", "发布期间又提交了其他资料\n")
        advanced = self.commit("Another writer advanced main")
        # A local bare clone is a read-only stand-in for ls-remote; no push is run.
        remote = Path(self.temporary.name) / "remote.git"
        subprocess.run(["git", "clone", "--bare", str(self.root), str(remote)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.git("remote", "add", "origin", str(remote))
        # The cloned main is newer than the editor's base. The preflight must
        # reject this race even though a local proposed commit already exists.
        real_git = publisher.git
        calls = []
        def audited_git(root, *arguments, **keywords):
            calls.append(arguments)
            if "push" in arguments:
                self.fail("No git push may run after the remote preflight conflict")
            return real_git(root, *arguments, **keywords)
        with patch.object(publisher, "git", audited_git), self.assertRaises(publisher.PublishError) as caught:
            publisher.push_build(self.root, state, proposed)
        self.assertEqual(caught.exception.code, "remote_advanced")
        self.assertFalse(any("push" in command for command in calls))
        self.assertEqual(subprocess.run(["git", "--git-dir", str(remote), "rev-parse", "refs/heads/main"], check=True, capture_output=True, text=True).stdout.strip(), advanced)
        self.assertEqual(subprocess.run(["git", "--git-dir", str(remote), "show", "refs/heads/main:unrelated.txt"], check=True, capture_output=True, text=True, encoding="utf-8").stdout, "发布期间又提交了其他资料\n")

    def test_invalid_candidate_ref_cannot_select_arbitrary_git_revisions(self):
        candidate = self.candidate()
        for reference in ("refs/heads/main", "refs/heads/codex/article-edit/../../main", REFERENCE + "\n"):
            with self.subTest(reference=reference), self.assertRaises(publisher.PublishError) as caught:
                publisher.prepare_proposal(self.root, candidate, reference)
            self.assertEqual(caught.exception.code, "invalid_ref")


class FakeAPI:
    def __init__(self, responses=()):
        self.responses = iter(responses)
        self.calls = []

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        return next(self.responses, None)


class StatusTests(unittest.TestCase):
    def test_only_the_latest_fixed_context_success_skips_publication(self):
        revision = "a" * 40
        for statuses in (
            [],
            [{"context": "another-check", "state": "success"}],
            [{"context": "blog-publish", "state": "pending"}],
            [{"context": "blog-publish", "state": "failure"}, {"context": "blog-publish", "state": "success"}],
        ):
            with self.subTest(statuses=statuses):
                api = FakeAPI([{"statuses": statuses}])
                with patch.object(publisher, "git", return_value=b" M unrelated.txt\0") as git_call, self.assertRaises(publisher.PublishError) as caught:
                    publisher.run_publication(Path.cwd(), revision, REFERENCE, api,
                                              "https://github.com/pku-xht/pku-xht.github.io/actions/runs/123")
                self.assertEqual(caught.exception.code, "dirty_checkout")
                git_call.assert_called_once()
                self.assertEqual(api.calls[1][2]["state"], "pending")

    def test_invalid_or_unavailable_prior_status_never_writes_a_replacement(self):
        revision = "a" * 40
        for response in (None, {}, {"statuses": None}, {"statuses": [None]},
                         {"statuses": [{"context": "blog-publish", "state": "unknown"}]},
                         {"statuses": [{"context": "blog-publish", "state": []}]}):
            with self.subTest(response=response):
                api = FakeAPI([response])
                with patch.object(publisher, "git", side_effect=AssertionError("Invalid status must stop before Git")), self.assertRaises(publisher.PublishError) as caught:
                    publisher.run_publication(Path.cwd(), revision, REFERENCE, api,
                                              "https://github.com/pku-xht/pku-xht.github.io/actions/runs/123")
                self.assertEqual(caught.exception.code, "publication_status_invalid")
                self.assertEqual(api.calls, [("GET", "/commits/" + revision + "/status", None)])
        api = FakeAPI()
        with patch.object(api, "request", side_effect=RuntimeError("Transport unavailable")) as request_call, \
                patch.object(publisher, "git", side_effect=AssertionError("Unknown status must stop before Git")), \
                self.assertRaises(publisher.PublishError) as caught:
            publisher.run_publication(Path.cwd(), revision, REFERENCE, api,
                                      "https://github.com/pku-xht/pku-xht.github.io/actions/runs/123")
        self.assertEqual(caught.exception.code, "publication_status_unavailable")
        request_call.assert_called_once_with("GET", "/commits/" + revision + "/status")

    def test_status_contract_is_fixed_and_contains_no_source_or_credentials(self):
        api = FakeAPI()
        revision = "a" * 40
        publisher.set_status(api, revision, "pending", "正在校验并构建文章。", "https://github.com/pku-xht/pku-xht.github.io/actions/runs/123")
        method, path, data = api.calls[0]
        self.assertEqual((method, path), ("POST", "/statuses/" + revision))
        self.assertEqual(data, {"state": "pending", "context": "blog-publish", "description": "正在校验并构建文章。", "target_url": "https://github.com/pku-xht/pku-xht.github.io/actions/runs/123"})

    def test_a_built_different_revision_is_not_publication_success(self):
        revision = "a" * 40
        api = FakeAPI([[], {"status": "queued"}, [{"commit": "b" * 40, "status": "built"}]])
        with self.assertRaises(publisher.PublishError) as caught:
            publisher.wait_for_pages(api, revision, timeout=0, monotonic=lambda: 1, sleep=lambda _: None)
        self.assertEqual(caught.exception.code, "pages_timeout")

    def test_only_the_saved_revision_reaching_built_succeeds(self):
        revision = "a" * 40
        api = FakeAPI([[], {"status": "queued"}, [{"commit": revision, "status": "building"}], [{"commit": revision, "status": "built"}]])
        publisher.wait_for_pages(api, revision, monotonic=lambda: 1, sleep=lambda _: None)
        self.assertEqual(api.calls[1], ("POST", "/pages/builds", {}))
        self.assertEqual(len(api.calls), 4)

    def test_pages_failure_is_reported_as_saved_but_unpublished(self):
        revision = "a" * 40
        api = FakeAPI([[], {"status": "queued"}, [{"commit": revision, "status": "errored", "error": {"message": "not logged"}}]])
        with self.assertRaises(publisher.PublishError) as caught:
            publisher.wait_for_pages(api, revision, monotonic=lambda: 1, sleep=lambda _: None)
        self.assertEqual(caught.exception.code, "pages_failed")
        self.assertTrue(str(caught.exception).startswith("正文已保存"))

    def test_a_retry_does_not_mistake_the_previous_failed_build_for_the_new_request(self):
        revision = "a" * 40
        previous = {"id": 1, "commit": revision, "status": "errored"}
        api = FakeAPI([[previous], {"status": "queued"}, [previous], [{"id": 2, "commit": revision, "status": "built"}, previous]])
        publisher.wait_for_pages(api, revision, monotonic=lambda: 1, sleep=lambda _: None)
        self.assertEqual(len(api.calls), 4)

    def test_an_already_published_identical_commit_needs_no_second_build(self):
        revision = "a" * 40
        api = FakeAPI([[{"id": 1, "commit": revision, "status": "built"}]])
        publisher.wait_for_pages(api, revision, monotonic=lambda: 1, sleep=lambda _: None)
        self.assertEqual(api.calls, [("GET", "/pages/builds?per_page=30", None)])


if __name__ == "__main__":
    unittest.main()
