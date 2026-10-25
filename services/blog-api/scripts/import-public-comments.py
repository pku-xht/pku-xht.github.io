"""Build the one-time, public-comment D1 import without network or credentials.

The registered YAML remains immutable public evidence. Runtime moderation lives
only in D1; import batch/ID hashes prevent subsequent imports reviving deletions.
"""
import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT / "tools"))
from blog_comments import load_comments, sanitize_comment_html
from blog_sources import load_blog
from build_blog import local_target, normal_path

BATCH = "public-comments-2026-10-25"


class PlainComment(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, value):
        self.parts.append(value)

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"p", "pre", "div", "blockquote", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def generate():
    collection = load_blog(project_root=PROJECT)
    documents = collection["posts"] + collection["pages"]
    archive = load_comments(post_ids=[row["id"] for row in documents], project_root=PROJECT)
    routes = {"": "/blog/"}
    for document in documents:
        route = f'/blog/{"posts" if document["type"] == "post" else "pages"}/{document["id"]}/'
        routes[normal_path(document["link"])] = route
        routes[document["type"] + ":" + str(document["id"])] = route
    media = {}
    for resource in collection["resources"]:
        media[resource["original_url"]] = resource
        if resource.get("download_url"):
            media[resource["download_url"]] = resource

    rows = []
    for comments in archive["by_post"].values():
        for comment in comments:
            rendered = sanitize_comment_html(comment["content"]["rendered"], lambda value: local_target(value, routes, media))
            parser = PlainComment()
            parser.feed(rendered)
            parser.close()
            body = "".join(parser.parts).strip()
            if not body or len(body) > 10000 or not comment["author_name"].strip() or len(comment["author_name"].strip()) > 40:
                raise ValueError(f'Public comment {comment["id"]} does not fit the verified display limits')
            stamp = datetime.fromisoformat(comment["date_gmt"]).replace(tzinfo=timezone.utc)
            rows.append({
                "id": f'wp-{comment["id"]}', "document": str(comment["post"]),
                "nickname": comment["author_name"], "author_url": comment["author_url"],
                "body": body, "body_html": rendered,
                "parent_id": f'wp-{comment["parent"]}' if comment["parent"] else None,
                "created_at": stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "content_hash": digest(comment),
            })
    rows.sort(key=lambda row: (row["created_at"], int(row["id"][3:])))
    manifest_hash = digest(rows)
    manifest = {"version": 1, "batch_id": BATCH, "manifest_hash": manifest_hash, "comments": rows}
    quote = lambda value: "'" + value.replace("'", "''") + "'"
    sql = (
        "-- Public, previously approved comments only; generated offline from registered YAML.\n"
        "-- One INSERT plus its trigger atomically imports rows and a persistent batch marker.\n"
        "-- Reruns preserve later moderation/deletion; differing hashes fail closed.\n"
        "INSERT INTO comment_import_batches(batch_id, manifest_hash, payload) VALUES (\n"
        f"{quote(BATCH)}, {quote(manifest_hash)}, {quote(canonical(rows))})\n"
        "ON CONFLICT(batch_id) DO UPDATE SET manifest_hash = CASE\n"
        "  WHEN comment_import_batches.manifest_hash = excluded.manifest_hash\n"
        "  THEN comment_import_batches.manifest_hash ELSE NULL END;\n"
    )
    return {"unified-comments.json": json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "unified-comments.sql": sql}, rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--check", action="store_true", help="Verify existing public import assets without writing")
    arguments = parser.parse_args()
    outputs, rows = generate()
    if not arguments.check:
        arguments.out.mkdir(parents=True, exist_ok=True)
    for filename, value in outputs.items():
        destination = arguments.out / filename
        if arguments.check:
            if destination.read_bytes() != value.encode("utf-8"):
                raise ValueError(f"Stale public comment import asset: {filename}")
        else:
            with destination.open("w", encoding="utf-8", newline="\n") as stream:
                stream.write(value)
    print(json.dumps({"comments": len(rows), "replies": sum(row["parent_id"] is not None for row in rows), "batch_id": BATCH, "network_requests": 0, "visits_enabled": False, "checked": arguments.check}))


if __name__ == "__main__":
    main()
