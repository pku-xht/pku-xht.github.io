"""Validate one editor proposal before atomically publishing its Markdown and HTML.

This file is executed from the trusted main checkout, never the candidate branch.
Candidates contain one registered public Markdown file; they cannot supply code,
configuration, resources, or the workflow used to validate them. Runtime secrets
are read only from the runner's environment and are never included in output.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from blog_sources import _yaml, read_document


REPOSITORY = "pku-xht/pku-xht.github.io"
STATUS_CONTEXT = "blog-publish"
SHA = re.compile(r"[0-9a-f]{40}\Z")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CANDIDATE_REF = re.compile(r"refs/heads/codex/article-edit/(?P<request>" + UUID + r")\Z")
SOURCE_PATH = re.compile(r"content/blog/(?P<group>posts|pages)/(?P<id>[1-9][0-9]*)\.md\Z")
MAX_SOURCE_BYTES = 1024 * 1024
GENERATED_PATHS = (
    re.compile(r"blog/(?:index\.html|archive/index\.html|friends/index\.html)\Z"),
    re.compile(r"blog/(?:posts|pages)/[1-9][0-9]*/(?:index\.html|exit/index\.html)\Z"),
    re.compile(r"blog/categories/[1-9][0-9]*/index\.html\Z"),
    re.compile(r"blog/tags/(?:index\.html|[1-9][0-9]*/index\.html)\Z"),
    re.compile(r"blog/comment/(?:index\.html|admin\.js|admin\.css)\Z"),
    re.compile(r"blog/editor/editor\.(?:js|css)\Z"),
)


class PublishError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def git(root, *arguments, input_bytes=None):
    result = subprocess.run(
        ["git", "-c", "core.quotepath=false", *arguments], cwd=root,
        input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if result.returncode:
        # Git's raw output may contain credential-helper or remote diagnostics.
        # Keep it out of public Actions logs and status descriptions.
        raise PublishError("git_failed", "Git 操作未完成，请查看仓库状态后重试。")
    return result.stdout


def _oid(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise PublishError("invalid_revision", "候选版本标识无效。")
    return value


def _tree_blob(root, revision, path):
    raw = git(root, "ls-tree", "-z", _oid(revision), "--", path)
    rows = raw.rstrip(b"\0").split(b"\0") if raw else []
    if len(rows) != 1:
        raise PublishError("invalid_path", "候选文章必须是已登记的现有文件。")
    try:
        header, actual_path = rows[0].split(b"\t", 1)
        mode, kind, identifier = header.decode("ascii").split(" ")
        actual_path = actual_path.decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise PublishError("invalid_path", "候选文件记录无效。") from error
    if mode != "100644" or kind != "blob" or actual_path != path:
        raise PublishError("invalid_path", "文章必须是普通 Markdown 文件，不能是符号链接。")
    return _oid(identifier)


def _registered_sources(root):
    manifest = root / "content/blog/collection.yaml"
    try:
        value = _yaml(manifest.read_text(encoding="utf-8"), manifest)
        if not isinstance(value, dict) or value.get("version") != 1:
            raise ValueError("Invalid collection")
        sources = {}
        for group, kind in (("posts", "post"), ("pages", "page")):
            if not isinstance(value.get(group), list):
                raise ValueError("Invalid collection group")
            for member in value[group]:
                if not isinstance(member, str) or not re.fullmatch(group + r"/[1-9][0-9]*\.md", member):
                    raise ValueError("Invalid collection path")
                path = "content/blog/" + member
                if path in sources:
                    raise ValueError("Duplicate collection path")
                sources[path] = kind
        if not sources:
            raise ValueError("Empty collection")
        return sources
    except (ValueError, OSError) as error:
        raise PublishError("invalid_collection", "正式文章清单未通过校验。") from error


def prepare_proposal(root, candidate_sha, candidate_ref):
    """Apply a valid single-file proposal to a clean main checkout, without commit.

    A proposal's parent is the version against which the owner edited. Unrelated
    changes on main are retained. A changed source blob is a conflict unless the
    identical proposal has already been applied by an earlier duplicate event.
    Invalid Markdown is validated in a temporary file before touching the source.
    """
    root = Path(root).resolve()
    candidate_sha = _oid(candidate_sha)
    reference = CANDIDATE_REF.fullmatch(candidate_ref)
    if not reference:
        raise PublishError("invalid_ref", "候选分支名称无效。")
    actual_root = Path(git(root, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    if actual_root != root:
        raise PublishError("invalid_root", "必须从正式仓库根目录执行。")
    if git(root, "status", "--porcelain=v1", "-z"):
        raise PublishError("dirty_checkout", "工作区存在未提交修改，停止发布以保护现有文件。")
    base_head = _oid(git(root, "rev-parse", "HEAD").decode().strip())
    if git(root, "cat-file", "-t", candidate_sha).strip() != b"commit":
        raise PublishError("invalid_revision", "候选版本必须是一个提交。")
    parents = git(root, "show", "-s", "--format=%P", candidate_sha).decode().split()
    if len(parents) != 1:
        raise PublishError("invalid_candidate", "候选修改必须有且只有一个基线提交。")
    parent = _oid(parents[0])
    changes = git(root, "diff-tree", "-r", "--no-commit-id", "--no-renames", "--name-status", "-z", parent, candidate_sha).split(b"\0")
    if changes and not changes[-1]:
        changes.pop()
    if len(changes) != 2 or changes[0] != b"M":
        raise PublishError("invalid_candidate", "候选提交只能修改一篇现有的公开文章或页面。")
    try:
        source_path = changes[1].decode("utf-8")
    except UnicodeDecodeError as error:
        raise PublishError("invalid_path", "候选路径无效。") from error
    source_match = SOURCE_PATH.fullmatch(source_path)
    sources = _registered_sources(root)
    if not source_match or source_path not in sources:
        raise PublishError("invalid_path", "编辑器只能修改正式清单中登记的文章或页面。")
    original_blob = _tree_blob(root, parent, source_path)
    candidate_blob = _tree_blob(root, candidate_sha, source_path)
    current_blob = _tree_blob(root, base_head, source_path)
    if current_blob not in {original_blob, candidate_blob}:
        raise PublishError("source_conflict", "文章已被其他修改更新，请重新载入后保存。")
    source_file = root / source_path
    if source_file.is_symlink() or any(path.is_symlink() for path in source_file.parents if path != root and root in path.parents):
        raise PublishError("invalid_path", "文章路径不能包含符号链接。")
    try:
        source_file.resolve().relative_to(root)
    except ValueError as error:
        raise PublishError("invalid_path", "文章路径超出正式仓库。") from error
    raw = git(root, "cat-file", "blob", candidate_blob)
    if not raw or len(raw) > MAX_SOURCE_BYTES:
        raise PublishError("invalid_source", "文章为空或超过编辑器大小限制。")
    try:
        baseline = read_document(source_file, expected_type=sources[source_path])
        with tempfile.TemporaryDirectory(prefix="blog-proposal-validation-") as directory:
            temporary_source = Path(directory) / source_file.name
            temporary_source.write_bytes(raw)
            proposed = read_document(temporary_source, expected_type=sources[source_path])
        if any(proposed[key] != baseline[key] for key in ("id", "type", "slug", "link")):
            raise ValueError("The document identity and URL must stay stable")
    except (ValueError, OSError, RuntimeError) as error:
        raise PublishError("invalid_source", "文章的 Markdown 或元数据未通过校验，文章标识与 URL 必须保持。") from error
    already_applied = current_blob == candidate_blob
    if not already_applied:
        source_file.write_bytes(raw)
    return {
        "version": 1, "request_id": reference.group("request"),
        "candidate_sha": candidate_sha, "candidate_ref": candidate_ref,
        "source_path": source_path, "document": source_match.group("id"),
        "base_head": base_head, "base_source_sha": original_blob,
        "source_sha": candidate_blob, "already_applied": already_applied,
        "saved_commit": None, "stage": "prepared",
    }


def allowed_output(path, source_path):
    return path in {source_path, "migration/public-batch.json"} or any(pattern.fullmatch(path) for pattern in GENERATED_PATHS)


def changed_outputs(root, source_path):
    """Return only explicitly maintained source/generated paths; reject the rest."""
    output = git(root, "status", "--porcelain=v1", "--untracked-files=all", "-z")
    paths = []
    for row in output.split(b"\0"):
        if not row:
            continue
        try:
            status, path = row[:2].decode("ascii"), row[3:].decode("utf-8")
        except UnicodeDecodeError as error:
            raise PublishError("unexpected_change", "构建产生了无法识别的文件修改。") from error
        if len(row) < 4 or row[2:3] != b" " or status not in {" M", " D", "??"} or not allowed_output(path, source_path):
            raise PublishError("unexpected_change", "构建修改了许可范围以外的文件，停止发布。")
        absolute = Path(root) / path
        if absolute.is_symlink() or (absolute.exists() and not absolute.is_file()):
            raise PublishError("unexpected_change", "构建输出必须是普通文件。")
        paths.append(path)
    return sorted(paths)


def commit_build(root, state):
    """Stage the exact audited paths and make one source-plus-generated commit."""
    if _oid(git(root, "rev-parse", "HEAD").decode().strip()) != state["base_head"]:
        raise PublishError("checkout_changed", "构建期间工作版本发生变化，停止发布。")
    actual_blob = git(root, "hash-object", "--", state["source_path"]).decode().strip()
    if actual_blob != state["source_sha"]:
        raise PublishError("source_changed", "构建期间文章内容发生变化，停止发布。")
    paths = changed_outputs(root, state["source_path"])
    if not paths:
        return state["base_head"]
    git(root, "add", "--", *paths)
    staged = git(root, "diff", "--cached", "--name-only", "-z").split(b"\0")
    staged = sorted(path.decode("utf-8") for path in staged if path)
    if staged != paths:
        raise PublishError("unexpected_change", "暂存文件与已校验的输出不一致。")
    for path in staged:
        mode = git(root, "ls-files", "-s", "--", path).split(b" ", 1)[0]
        # Deleted generated paths have no stage entry.
        if mode not in {b"", b"100644"}:
            raise PublishError("unexpected_change", "暂存输出包含非普通文件。")
    git(root, "-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-m", "Update blog article " + state["document"],
        "-m", "Blog-Edit-Request: " + state["request_id"] + "\nBlog-Edit-Candidate: " + state["candidate_sha"])
    return _oid(git(root, "rev-parse", "HEAD").decode().strip())


def push_build(root, state, commit):
    """Never force main: a concurrent external update must be retained."""
    remote = git(root, "ls-remote", "--exit-code", "origin", "refs/heads/main").split()
    if not remote or remote[0].decode("ascii") != state["base_head"]:
        raise PublishError("remote_advanced", "仓库出现并发更新，正式文章未覆盖，请重新保存。")
    if commit != state["base_head"]:
        try:
            git(root, "push", "origin", commit + ":refs/heads/main")
        except PublishError as error:
            raise PublishError("push_unconfirmed", "正式提交未确认，请查看构建记录后重试。") from error
    return commit


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class GitHubAPI:
    def __init__(self, token):
        if not isinstance(token, str) or not token or any(character.isspace() for character in token):
            raise PublishError("token_missing", "发布服务缺少 GitHub 授权。")
        self.token = token
        self.opener = build_opener(_NoRedirect)

    def request(self, method, path, body=None):
        if not path.startswith("/") or path.startswith("//") or ".." in path or "\\" in path:
            raise PublishError("invalid_api_path", "发布接口路径无效。")
        request = Request("https://api.github.com/repos/" + REPOSITORY + path, method=method, headers={
            "Authorization": "Bearer " + self.token,
            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "xht37-blog-editor-publisher", "Content-Type": "application/json",
        }, data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"))
        try:
            with self.opener.open(request, timeout=30) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError("oversized API response")
            return json.loads(raw) if raw else None
        except (HTTPError, URLError, ValueError, OSError) as error:
            raise PublishError("github_api_failed", "GitHub 发布接口暂未完成请求。") from error


def set_status(api, candidate_sha, state, description, run_url):
    if state not in {"pending", "success", "failure", "error"}:
        raise PublishError("invalid_status", "发布状态无效。")
    if not re.fullmatch(r"https://github\.com/" + re.escape(REPOSITORY) + r"/actions/runs/[1-9][0-9]*", run_url):
        raise PublishError("invalid_run_url", "发布记录地址无效。")
    api.request("POST", "/statuses/" + _oid(candidate_sha), {
        "state": state, "context": STATUS_CONTEXT, "description": description[:140], "target_url": run_url,
    })


def wait_for_pages(api, commit, timeout=480, interval=5, monotonic=time.monotonic, sleep=time.sleep):
    """Only the exact saved commit reaching built constitutes publication."""
    commit = _oid(commit)
    previous = api.request("GET", "/pages/builds?per_page=30")
    if not isinstance(previous, list):
        raise PublishError("pages_invalid_response", "正文已保存，网站发布状态暂时无法确认。")
    if any(isinstance(row, dict) and row.get("commit") == commit and row.get("status") == "built" for row in previous):
        return
    failed_builds = {row.get("url") or row.get("id") for row in previous
                     if isinstance(row, dict) and row.get("commit") == commit and row.get("status") == "errored"}
    api.request("POST", "/pages/builds", {})
    deadline = monotonic() + timeout
    while True:
        rows = api.request("GET", "/pages/builds?per_page=30")
        if not isinstance(rows, list):
            raise PublishError("pages_invalid_response", "正文已保存，网站发布状态暂时无法确认。")
        for row in rows:
            if not isinstance(row, dict) or row.get("commit") != commit:
                continue
            if row.get("status") == "built":
                return
            if row.get("status") == "errored":
                if (row.get("url") or row.get("id")) in failed_builds:
                    continue
                raise PublishError("pages_failed", "正文已保存，网站发布失败，请重试。")
            break
        if monotonic() >= deadline:
            raise PublishError("pages_timeout", "正文已保存，网站发布尚未确认完成，请查看构建记录。")
        sleep(interval)


def _save_state(path, state):
    if path:
        Path(path).write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_publication(root, candidate_sha, candidate_ref, api, run_url, state_file=None, pages_timeout=480):
    """The workflow entry point; local tests exercise the pure preparation pieces."""
    root = Path(root).resolve()
    candidate_sha = _oid(candidate_sha)
    if not CANDIDATE_REF.fullmatch(candidate_ref):
        raise PublishError("invalid_ref", "候选分支名称无效。")
    state = {"version": 1, "candidate_sha": candidate_sha, "stage": "preparing", "saved_commit": None}
    # A delayed duplicate may arrive after a later edit has changed this source.
    # Keep an already successful candidate successful, without reapplying it.
    # This read must precede the try block: an unavailable/invalid preflight must
    # not overwrite a possibly successful status with a new failure either.
    try:
        previous = api.request("GET", "/commits/" + candidate_sha + "/status")
    except PublishError:
        raise
    except Exception as error:
        raise PublishError("publication_status_unavailable", "暂时无法核实此前发布状态，请稍后重试。") from error
    if not isinstance(previous, dict) or not isinstance(previous.get("statuses"), list) or any(
        not isinstance(row, dict) or not isinstance(row.get("context"), str)
        or not isinstance(row.get("state"), str)
        or row.get("state") not in {"pending", "success", "failure", "error"}
        for row in previous["statuses"]
    ):
        raise PublishError("publication_status_invalid", "此前发布状态无效，停止重复发布。")
    latest = next((row for row in previous["statuses"] if row["context"] == STATUS_CONTEXT), None)
    if latest and latest["state"] == "success":
        state.update(stage="published", already_published=True)
        _save_state(state_file, state)
        return state
    try:
        set_status(api, candidate_sha, "pending", "正在校验并构建文章。", run_url)
        if git(root, "status", "--porcelain=v1", "-z"):
            raise PublishError("dirty_checkout", "工作区存在未提交修改，停止发布。")
        git(root, "fetch", "--no-tags", "origin", candidate_sha)
        git(root, "fetch", "--no-tags", "origin", "refs/heads/main")
        latest_main = _oid(git(root, "rev-parse", "FETCH_HEAD").decode().strip())
        git(root, "checkout", "--detach", latest_main)
        state = prepare_proposal(root, candidate_sha, candidate_ref)
        state["stage"] = "building"
        _save_state(state_file, state)
        for arguments in (
            [sys.executable, "-S", "-X", "utf8", "tools/build_blog.py"],
            [sys.executable, "-S", "-X", "utf8", "tools/check_blog.py"],
        ):
            result = subprocess.run(arguments, cwd=root)
            if result.returncode:
                raise PublishError("build_failed", "生成或校验失败，正式文章未更新。")
        commit = commit_build(root, state)
        state["stage"] = "pushing"
        _save_state(state_file, state)
        state["saved_commit"] = push_build(root, state, commit)
        state["stage"] = "publishing"
        _save_state(state_file, state)
        wait_for_pages(api, commit, timeout=pages_timeout)
        state["stage"] = "published"
        _save_state(state_file, state)
        set_status(api, candidate_sha, "success", "文章已更新并发布。", run_url)
        return state
    except Exception as error:
        if isinstance(error, PublishError):
            description, code = str(error), error.code
        else:
            description, code = "发布未完成，请查看构建记录后重试。", "publication_failed"
        if state.get("saved_commit") and not description.startswith("正文已保存"):
            description = "正文已保存，网站发布未确认完成，请查看构建记录。"
        state.update(stage="failed", error=code, message=description)
        _save_state(state_file, state)
        try:
            set_status(api, candidate_sha, "failure", description, run_url)
        except Exception:
            # A status API failure must never expose the token or turn a failed
            # publication into a reported success.
            pass
        raise PublishError(code, description) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "publish"))
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--candidate-ref", required=True)
    parser.add_argument("--state-file")
    parser.add_argument("--pages-timeout", type=int, default=480)
    arguments = parser.parse_args()
    try:
        if arguments.mode == "prepare":
            result = prepare_proposal(arguments.root, arguments.candidate_sha, arguments.candidate_ref)
            _save_state(arguments.state_file, result)
        else:
            if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY or not re.fullmatch(r"[1-9][0-9]*", os.environ.get("GITHUB_RUN_ID", "")):
                raise PublishError("invalid_runner", "发布只能在指定仓库的 Actions 任务中运行。")
            run_url = "https://github.com/" + REPOSITORY + "/actions/runs/" + os.environ["GITHUB_RUN_ID"]
            result = run_publication(arguments.root, arguments.candidate_sha, arguments.candidate_ref,
                                     GitHubAPI(os.environ.get("GITHUB_TOKEN")), run_url,
                                     arguments.state_file, arguments.pages_timeout)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except PublishError as error:
        print(json.dumps({"error": error.code, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
