"""Build a review-only candidate from verified public WordPress Markdown.

The private archive is input only. Never enumerate it into the output: only IDs
present in both the maintained collection and public registry are opened.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools/vendor/python"))
import yaml

ARCHIVE = Path(r"D:\xht37-private-archive\native\2026-10-29")
BASELINE = "476c57a"
OLD_925 = '<a class="wp-editor-md-post-content-link" href="https://www.xht37.com/zroi-19-csp-s-模拟赛十联测-day1-题解/#lwptoc2">这题</a>'


def title_equivalence(identity, current, inventory, native):
    titles = (current, inventory, native)
    if not all(isinstance(title, str) for title in titles):
        raise ValueError(f"Invalid title for {identity}")
    if len(set(titles)) == 1:
        return None
    def normalize(title):
        return title.replace("–", "-").replace("’", "'").replace("…", "...")
    if len({normalize(title) for title in titles}) != 1:
        raise ValueError(f"Title mismatch for {identity}")
    return {"captured_title": native, "current_title": current, "inventory_title": inventory,
            "rule": "U+2013 to hyphen, U+2019 to apostrophe, U+2026 to three periods"}


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate_provenance(identity, kind, provenance):
    keys = {"captured_at", "source_url", "editor_heading", "status_label", "visibility_label", "json_sha256"}
    if not isinstance(provenance, dict) or set(provenance) != keys:
        raise ValueError(f"Invalid provenance fields for {identity}")
    if not isinstance(provenance["source_url"], str):
        raise ValueError(f"Invalid editor URL for {identity}")
    url = urlsplit(provenance["source_url"])
    if (url.scheme, url.netloc, url.path, url.fragment) != ("https", "www.xht37.com", "/wp-admin/post.php", "") or sorted(parse_qsl(url.query, keep_blank_values=True)) != sorted([("post", str(identity)), ("action", "edit")]):
        raise ValueError(f"Invalid editor URL for {identity}")
    if (provenance["editor_heading"], provenance["status_label"]) != ("编辑文章" if kind == "post" else "编辑页面", "已发布") or provenance["visibility_label"] not in {"公开", "公开、置顶"}:
        raise ValueError(f"Invalid editor labels for {identity}")
    try:
        timestamp = datetime.fromisoformat(provenance["captured_at"].replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError(f"Invalid capture timestamp for {identity}") from error
    if timestamp.tzinfo is None or not isinstance(provenance["json_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", provenance["json_sha256"]):
        raise ValueError(f"Invalid capture evidence for {identity}")


def public_documents():
    collection = yaml.safe_load((ROOT / "content/blog/collection.yaml").read_text(encoding="utf-8"))
    registry = json.loads((ROOT / "services/blog-api/data/public-documents.json").read_text(encoding="utf-8"))
    records = {}
    for group, kind in (("posts", "post"), ("pages", "page")):
        for member in collection[group]:
            if not re.fullmatch(group + r"/[1-9]\d*\.md", member):
                raise ValueError("Invalid collection path")
            identity = int(Path(member).stem)
            if identity in records:
                raise ValueError("Duplicate collection ID")
            records[identity] = (kind, member)
    registry_records = {}
    for entry in registry["documents"]:
        identity = int(entry["id"])
        if identity in registry_records:
            raise ValueError("Duplicate registry ID")
        registry_records[identity] = entry["kind"]
    if {i: kind for i, (kind, _) in records.items()} != registry_records:
        raise ValueError("Collection and public registry disagree")
    if len(records) != 212 or sum(kind == "post" for kind, _ in records.values()) != 211 or records.get(215, (None,))[0] != "page":
        raise ValueError("The audited collection must contain 211 posts and page 215")
    return records


def verify_maintained_history():
    """Fail closed if a later source edit has not been explicitly reconciled."""
    paths = subprocess.check_output(
        ["git", "diff", "--name-only", BASELINE, "--", "content/blog/posts", "content/blog/pages"],
        cwd=ROOT, text=True, encoding="utf-8").splitlines()
    if paths != ["content/blog/posts/925.md"]:
        raise ValueError("Maintained sources changed since the audited baseline; reconcile history first")
    old = subprocess.check_output(["git", "show", f"{BASELINE}:content/blog/posts/925.md"], cwd=ROOT).decode("utf-8")
    current = (ROOT / "content/blog/posts/925.md").read_bytes().decode("utf-8")
    if old.count(OLD_925) != 1 or old.replace(OLD_925, "这题") != current:
        raise ValueError("The audited 925 maintenance edit changed; reconcile it first")


def inventory_public(archive, records):
    inventory = json.loads((archive / "inventory.json").read_text(encoding="utf-8"))
    if inventory.get("version") != 1:
        raise ValueError("Unsupported inventory version")
    found = {}
    for item in inventory["documents"]:
        identity = item["id"]
        if identity in found:
            raise ValueError("Duplicate inventory ID")
        found[identity] = item
    for identity, (kind, _) in records.items():
        item = found.get(identity)
        if not item or (item.get("type"), item.get("status"), item.get("visibility")) != (kind, "publish", "public"):
            raise ValueError(f"Public inventory mismatch for {identity}")
    return found


def read_public(archive, identity, kind, inventory):
    path = archive / "documents" / f"{identity}.json"
    if not path.is_file():
        return None
    raw_json = path.read_bytes()
    record = json.loads(raw_json.decode("utf-8"))
    if (record.get("version"), record.get("id"), record.get("type"), record.get("status"), record.get("visibility")) != (1, identity, kind, "publish", "public"):
        raise ValueError(f"Public document identity or visibility mismatch for {identity}")
    native_title = record.get("title")
    raw = record.get("markdown")
    if not isinstance(raw, str) or "\r" in raw or digest(raw) != record.get("sha256"):
        raise ValueError(f"Raw Markdown hash or line ending mismatch for {identity}")
    provenance = {key: record.get(key) for key in ("captured_at", "source_url", "editor_heading", "status_label", "visibility_label")}
    provenance["json_sha256"] = hashlib.sha256(raw_json).hexdigest()
    validate_provenance(identity, kind, provenance)
    return raw, native_title, provenance


def header(member, identity, kind):
    text = (ROOT / "content/blog" / member).read_bytes().decode("utf-8")
    match = re.match(r"\A---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    if not match:
        raise ValueError(f"Invalid maintained front matter for {identity}")
    metadata = yaml.safe_load(match.group(1))
    if metadata.get("id") != identity or metadata.get("type") != kind:
        raise ValueError(f"Maintained identity mismatch for {identity}")
    return text[:match.end()]


def maintained_body(identity, raw):
    if identity == 925:
        before = "[这题](https://www.xht37.com/zroi-19-csp-s-模拟赛十联测-day1-题解/#lwptoc2)"
        if digest(raw) != "26fb4b1b2359641a8b9fbbfc525026f750a160ef4a7b4a785418c30af4380054" or raw.count(before) != 1:
            raise ValueError("Document 925 original or maintenance patch context changed")
        body = raw.replace(before, "这题", 1)
        return body, [{"kind": "remove-orphan-link", "before": before, "after": "这题", "before_sha256": digest(raw), "after_sha256": digest(body)}]
    return raw, []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, default=ARCHIVE)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--partial", action="store_true", help="export available verified public samples only")
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        raise ValueError("Output already exists; choose a fresh directory")
    if output == (ROOT / "content/blog").resolve() or (ROOT / "content/blog").resolve() in output.parents:
        raise ValueError("Candidate output cannot be placed in the formal source directory")
    records = public_documents()
    verify_maintained_history()
    inventory = inventory_public(args.archive, records)
    pending, missing, rejected = [], [], []
    for identity, (kind, member) in records.items():
        try:
            result = read_public(args.archive, identity, kind, inventory)
            if result is not None:
                raw, native_title, provenance = result
                body, patches = maintained_body(identity, raw)
                prefix = header(member, identity, kind)
                current_title = yaml.safe_load(prefix[4:-4])["title"]
                title_evidence = title_equivalence(identity, current_title, inventory[identity].get("title"), native_title)
        except ValueError as error:
            if not args.partial:
                raise
            rejected.append({"id": identity, "reason": str(error)})
            continue
        if result is None:
            missing.append(identity)
            continue
        current_hash = hashlib.sha256((ROOT / "content/blog" / member).read_bytes()).hexdigest()
        evidence = {"id": identity, "path": member, "native_sha256": digest(raw), "body_sha256": digest(body), "header_sha256": digest(prefix), "current_source_sha256": current_hash, "candidate_source_sha256": digest(prefix + body), "title_equivalence": title_evidence, "patches": patches}
        snapshot = {"id": identity, "type": kind, "status": "publish", "visibility": "public", "title": native_title, "markdown": raw, "provenance": provenance, **{key: evidence[key] for key in ("native_sha256", "body_sha256", "header_sha256", "title_equivalence", "patches")}}
        pending.append((identity, member, prefix + body, evidence, snapshot))
    if missing and not args.partial:
        raise ValueError(f"Missing {len(missing)} public documents; no output written")
    output.mkdir(parents=True)
    for _, member, source, _, _ in pending:
        path = output / member
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(source.encode("utf-8"))
    evidence = {"version": 1, "complete": not missing and not rejected, "rejected": rejected, "documents": [entry for _, _, _, entry, _ in pending]}
    (output / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    snapshot = {"version": 1, "complete": evidence["complete"], "documents": [entry for _, _, _, _, entry in pending]}
    (output / "native-public.json").write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Verified public candidates: {len(pending)}; missing: {len(missing)}; rejected: {len(rejected)}; output: {output}")
    for item in rejected:
        print(f"  {item['id']}: {item['reason']}")


if __name__ == "__main__":
    main()
