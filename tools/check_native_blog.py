"""Independently verify review candidates against the verified native archive."""
import argparse
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

import adopt_native_blog as adoption


def independently_apply_patches(identity, raw, patches):
    """Verify and apply recorded edits without calling the adoption transform."""
    if not isinstance(patches, list):
        raise ValueError(f"Invalid patch list for {identity}")
    if identity != 925 and patches:
        raise ValueError(f"Unexpected maintenance patch for {identity}")
    if identity == 925:
        before = "[这题](https://www.xht37.com/zroi-19-csp-s-模拟赛十联测-day1-题解/#lwptoc2)"
        raw_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        if raw_hash != "26fb4b1b2359641a8b9fbbfc525026f750a160ef4a7b4a785418c30af4380054" or raw.count(before) != 1:
            raise ValueError("925 raw source or patch context mismatch")
        body = raw.replace(before, "这题", 1)
        body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
        expected = [{"kind": "remove-orphan-link", "before": before, "after": "这题", "before_sha256": raw_hash, "after_sha256": body_hash}]
        if patches != expected:
            raise ValueError("925 patch evidence mismatch")
        return body
    return raw


def formal_check(snapshot_path, capture_archive=None, formatted=False, source_ref=None):
    records = adoption.public_documents()
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if set(snapshot) != {"version", "complete", "documents"} or snapshot.get("version") != 1 or snapshot.get("complete") is not True or not isinstance(snapshot.get("documents"), list):
        raise ValueError("Formal snapshot must be complete")
    entries = {}
    for item in snapshot.get("documents", []):
        if not isinstance(item, dict) or set(item) != {"id", "type", "status", "visibility", "title", "markdown", "native_sha256", "body_sha256", "header_sha256", "title_equivalence", "patches", "provenance"}:
            raise ValueError("Unexpected fields in public snapshot")
        identity = item.get("id")
        if identity not in records or identity in entries:
            raise ValueError("Duplicate or unauthorized snapshot ID")
        entries[identity] = item
    if set(entries) != set(records):
        raise ValueError("Snapshot does not match the public collection")
    for identity, (kind, member) in records.items():
        item = entries[identity]
        raw = item.get("markdown")
        if (item.get("type"), item.get("status"), item.get("visibility")) != (kind, "publish", "public") or not isinstance(raw, str) or "\r" in raw or adoption.digest(raw) != item.get("native_sha256"):
            raise ValueError(f"Invalid native snapshot for {identity}")
        adoption.validate_provenance(identity, kind, item.get("provenance"))
        if capture_archive is not None:
            capture = adoption.read_public(capture_archive, identity, kind, None)
            if capture is None or capture != (raw, item.get("title"), item.get("provenance")):
                raise ValueError(f"Capture archive mismatch for {identity}")
        body = independently_apply_patches(identity, raw, item.get("patches"))
        if adoption.digest(body) != item.get("body_sha256"):
            raise ValueError(f"Patched body hash mismatch for {identity}")
        prefix = adoption.header(member, identity, kind)
        if adoption.digest(prefix) != item.get("header_sha256"):
            raise ValueError(f"Maintained metadata changed for {identity}")
        current_title = adoption.yaml.safe_load(prefix[4:-4])["title"]
        title_evidence = item.get("title_equivalence")
        inventory_title = title_evidence.get("inventory_title") if isinstance(title_evidence, dict) else current_title
        if adoption.title_equivalence(identity, current_title, inventory_title, item.get("title")) != title_evidence:
            raise ValueError(f"Title evidence mismatch for {identity}")
        if formatted:
            from format_blog_markdown import format_markdown
            body = format_markdown(body)
        path = "content/blog/" + member
        current = (subprocess.check_output(["git", "show", f"{source_ref}:{path}"], cwd=adoption.ROOT)
                   if source_ref else (adoption.ROOT / path).read_bytes())
        if current != (prefix + body).encode("utf-8"):
            raise ValueError(f"Formal source differs from snapshot for {identity}")
    print(f"Verified {len(entries)} {'formatted' if formatted else 'native'} documents against public native snapshot" + (f" at {source_ref}" if source_ref else ""))


def apply_candidates(candidate, entries):
    """Prepare all writes, recheck the worktree, then replace with guarded rollback."""
    journal_dir = candidate / "apply-journal"
    journal_dir.mkdir()
    backups = journal_dir / "backups"
    backups.mkdir()
    journal = {"version": 1, "status": "preparing", "documents": []}
    journal_path = journal_dir / "journal.json"
    staged = []
    replaced = []

    def save():
        journal_path.write_text(json.dumps(journal, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    try:
        for identity, entry in entries.items():
            current = adoption.ROOT / "content/blog" / entry["path"]
            original = current.read_bytes()
            if hashlib.sha256(original).hexdigest() != entry.get("current_source_sha256"):
                raise ValueError(f"Current source changed since candidate generation: {identity}")
            replacement = (candidate / entry["path"]).read_bytes()
            if hashlib.sha256(replacement).hexdigest() != entry.get("candidate_source_sha256"):
                raise ValueError(f"Candidate changed before staging: {identity}")
            backup = backups / f"{identity}.md"
            backup.write_bytes(original)
            fd, temporary = tempfile.mkstemp(prefix=".native-", dir=current.parent)
            staged.append(temporary)
            with os.fdopen(fd, "wb") as output:
                output.write(replacement)
            journal["documents"].append({"id": identity, "path": entry["path"], "backup": f"backups/{identity}.md", "original_sha256": hashlib.sha256(original).hexdigest(), "candidate_sha256": hashlib.sha256(replacement).hexdigest(), "state": "staged"})
        journal["status"] = "staged"
        save()
        for item in journal["documents"]:
            current = adoption.ROOT / "content/blog" / item["path"]
            if hashlib.sha256(current.read_bytes()).hexdigest() != item["original_sha256"]:
                raise ValueError(f"Current source changed after staging: {item['id']}")
        journal["status"] = "replacing"
        save()
        for item, temporary in zip(journal["documents"], staged):
            current = adoption.ROOT / "content/blog" / item["path"]
            if hashlib.sha256(current.read_bytes()).hexdigest() != item["original_sha256"]:
                raise ValueError(f"Current source changed during apply: {item['id']}")
            os.replace(temporary, current)
            replaced.append(item)
            item["state"] = "replaced"
            save()
        journal["status"] = "applied"
        save()
    except Exception as error:
        for item in reversed(replaced):
            current = adoption.ROOT / "content/blog" / item["path"]
            try:
                if hashlib.sha256(current.read_bytes()).hexdigest() != item["candidate_sha256"]:
                    item["state"] = "rollback-skipped-current-changed"
                    continue
                original = (journal_dir / item["backup"]).read_bytes()
                if hashlib.sha256(original).hexdigest() != item["original_sha256"]:
                    raise ValueError("Backup hash mismatch")
                fd, temporary = tempfile.mkstemp(prefix=".native-rollback-", dir=current.parent)
                staged.append(temporary)
                with os.fdopen(fd, "wb") as output:
                    output.write(original)
                os.replace(temporary, current)
                item["state"] = "rolled-back"
            except Exception as rollback_error:
                item["state"] = "rollback-failed"
                item["rollback_error"] = str(rollback_error)
        journal["status"] = "failed"
        journal["error"] = str(error)
        states = ", ".join(f"{item['id']}:{item['state']}" for item in replaced) or "no files replaced"
        try:
            save()
            journal_status = f"journal: {journal_path}"
        except Exception as journal_error:
            journal_status = f"journal save failed: {journal_error}"
        raise RuntimeError(f"Apply failed; recovery: {states}; {journal_status}") from error
    finally:
        for temporary in staged:
            if os.path.exists(temporary):
                os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, default=adoption.ARCHIVE)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--partial", action="store_true")
    parser.add_argument("--formal", action="store_true")
    parser.add_argument("--formatted", action="store_true", help="compare formal bodies with deterministic formatting of verified native bodies")
    parser.add_argument("--source-ref", help="compare against documents at a local Git revision")
    parser.add_argument("--snapshot", type=Path, default=adoption.ROOT / "migration/sources/native-public-2026-10-29.json")
    parser.add_argument("--capture-archive", type=Path, help="also compare public snapshot provenance to the local capture archive")
    parser.add_argument("--apply", action="store_true", help="apply a fully verified candidate after checking current source hashes")
    args = parser.parse_args()
    if args.formal:
        if args.candidate or args.partial or args.apply:
            parser.error("--formal cannot be combined with candidate options")
        formal_check(args.snapshot, args.capture_archive, args.formatted, args.source_ref)
        return
    if args.capture_archive or args.formatted or args.source_ref:
        parser.error("--capture-archive, --formatted and --source-ref require --formal")
    if not args.candidate:
        parser.error("--candidate is required unless --formal is used")
    if args.apply and args.partial:
        parser.error("--apply requires a complete candidate")
    candidate = args.candidate.resolve()
    records = adoption.public_documents()
    adoption.verify_maintained_history()
    inventory = adoption.inventory_public(args.archive, records)
    evidence = json.loads((candidate / "evidence.json").read_text(encoding="utf-8"))
    if evidence.get("version") != 1 or not isinstance(evidence.get("documents"), list):
        raise ValueError("Invalid candidate evidence")
    entries = {}
    for entry in evidence["documents"]:
        identity = entry.get("id")
        if identity in entries or identity not in records:
            raise ValueError("Duplicate or unauthorized candidate ID")
        entries[identity] = entry
    if not args.partial and (set(entries) != set(records) or evidence.get("complete") is not True):
        raise ValueError("Candidate does not cover the complete public collection")
    if evidence.get("complete") is not (set(entries) == set(records)):
        raise ValueError("Evidence completeness flag is incorrect")
    snapshot = json.loads((candidate / "native-public.json").read_text(encoding="utf-8"))
    if snapshot.get("version") != 1 or snapshot.get("complete") != evidence.get("complete"):
        raise ValueError("Snapshot completeness mismatch")
    snapshot_entries = {}
    for item in snapshot.get("documents", []):
        identity = item.get("id")
        if identity in snapshot_entries or identity not in entries:
            raise ValueError("Unexpected snapshot ID")
        snapshot_entries[identity] = item
    if set(snapshot_entries) != set(entries):
        raise ValueError("Snapshot and evidence IDs disagree")
    expected_paths = set()
    for identity, entry in entries.items():
        kind, member = records[identity]
        if entry.get("path") != member:
            raise ValueError(f"Candidate path mismatch for {identity}")
        result = adoption.read_public(args.archive, identity, kind, inventory)
        if result is None:
            raise ValueError(f"Original missing for {identity}")
        raw, native_title, provenance = result
        body, patches = adoption.maintained_body(identity, raw)
        prefix = adoption.header(member, identity, kind)
        current_title = adoption.yaml.safe_load(prefix[4:-4])["title"]
        title_evidence = adoption.title_equivalence(identity, current_title, inventory[identity].get("title"), native_title)
        if entry.get("native_sha256") != adoption.digest(raw) or entry.get("body_sha256") != adoption.digest(body) or entry.get("title_equivalence") != title_evidence or entry.get("patches") != patches:
            raise ValueError(f"Evidence mismatch for {identity}")
        if entry.get("header_sha256") != adoption.digest(prefix):
            raise ValueError(f"Candidate header mismatch for {identity}")
        snap = snapshot_entries[identity]
        if snap != {"id": identity, "type": kind, "status": "publish", "visibility": "public", "title": native_title, "markdown": raw, "provenance": provenance, **{key: entry[key] for key in ("native_sha256", "body_sha256", "header_sha256", "title_equivalence", "patches")}}:
            raise ValueError(f"Public snapshot mismatch for {identity}")
        if independently_apply_patches(identity, raw, patches) != body:
            raise ValueError(f"Independent patch verification failed for {identity}")
        expected = (prefix + body).encode("utf-8")
        if entry.get("candidate_source_sha256") != hashlib.sha256(expected).hexdigest():
            raise ValueError(f"Candidate source hash mismatch for {identity}")
        path = candidate / member
        if path.read_bytes() != expected:
            raise ValueError(f"Candidate bytes differ for {identity}")
        expected_paths.add(path.resolve())
    if {p.resolve() for p in candidate.rglob("*.md")} != expected_paths:
        raise ValueError("Unexpected Markdown in candidate")
    if args.apply:
        apply_candidates(candidate, entries)
        print(f"Applied {len(entries)} verified candidates")
    print(f"Verified {len(entries)} candidate documents; complete: {evidence['complete']}")


if __name__ == "__main__":
    main()
