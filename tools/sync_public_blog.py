"""Snapshot anonymously visible WordPress content and its referenced public assets.

This tool never signs in, accepts credentials, or exports authenticated content.
Generated pages are built separately with build_blog.py.
"""
import argparse
import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit, urlunsplit, unquote
from urllib.request import Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.xht37.com/"
HOSTS = {"www.xht37.com", "xht37.com"}
OPENER = build_opener()  # No CookieProcessor, credentials, or authenticated session.
MAX_ASSET_BYTES = 99 * 1024 * 1024


def save_json(path, data):
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def request(url):
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or parts.username or parts.password:
        raise ValueError("Unexpected public URL")
    url = urlunsplit((parts.scheme, parts.netloc, quote(parts.path, safe="/%:@"), parts.query, ""))
    return OPENER.open(Request(url, headers={"User-Agent": "xht37-public-blog-migration/1.0", "Accept": "*/*"}), timeout=30)


def fetch_collection(kind):
    records, seen, query_urls = [], set(), []
    page, expected_total, expected_pages = 1, None, None
    while expected_pages is None or page <= expected_pages:
        params = {"context": "view", "per_page": 100, "page": page}
        if kind in {"posts", "pages"}:
            params.update(status="publish", orderby="date", order="desc")
        url = BASE + "index.php?rest_route=/wp/v2/" + kind + "&" + urlencode(params)
        with request(url) as response:
            total = int(response.headers["X-WP-Total"])
            pages = int(response.headers["X-WP-TotalPages"])
            items = json.load(response)
        if expected_total is None:
            expected_total, expected_pages = total, max(1, pages)
        if total != expected_total or max(1, pages) != expected_pages:
            raise ValueError("Public collection changed during snapshot: " + kind)
        if not isinstance(items, list):
            raise ValueError("Expected public collection list: " + kind)
        for item in items:
            if item["id"] in seen:
                raise ValueError("Repeated ID, possibly a swallowed page parameter: " + kind)
            if kind in {"posts", "pages"}:
                if item["status"] != "publish" or item["content"].get("protected", True):
                    raise ValueError("Non-public/protected record in anonymous response; nothing saved")
            seen.add(item["id"])
        records.extend(items)
        query_urls.append(url)
        print(f"{kind} page {page}/{expected_pages}: {len(items)} records", flush=True)
        page += 1
    if len(records) != expected_total:
        raise ValueError("Public collection count mismatch: " + kind)
    return records, query_urls


def normalize(item, kind):
    value = {key: item[key] for key in ("id", "date", "date_gmt", "modified", "modified_gmt", "slug", "link", "status")}
    value.update(type=kind, categories=item.get("categories", []), tags=item.get("tags", []),
                 title=item["title"]["rendered"], content_html=item["content"]["rendered"],
                 content_sha256=hashlib.sha256(item["content"]["rendered"].encode("utf-8")).hexdigest(),
                 protected=False)
    return value


class Assets(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.references = {}
        self.owner = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        url, kind = None, None
        if tag == "img":
            url, kind = attrs["src"], "image"
        elif tag == "a":
            candidate = attrs.get("href", "")
            parts = urlsplit(candidate)
            if parts.hostname in HOSTS and parts.path.startswith("/wp-content/uploads/"):
                url, kind = candidate, "attachment"
        if url:
            record = self.references.setdefault(url, {"kind": kind, "referenced_by": []})
            if self.owner not in record["referenced_by"]:
                record["referenced_by"].append(self.owner)


def asset_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"): return "png"
    if data.startswith(b"\xff\xd8\xff"): return "jpg"
    if data.startswith((b"GIF87a", b"GIF89a")): return "gif"
    if data.startswith(b"%PDF-"): return "pdf"
    if data.startswith(b"PK\x03\x04"): return "zip"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP": return "webp"
    if b"<svg" in data[:1500] and b"<html" not in data[:1500].lower(): return "svg"
    raise ValueError("Asset is not a recognized original image/PDF/ZIP")


def sync_assets(records):
    parser = Assets()
    for record in records:
        parser.owner = f'{record["type"]}:{record["id"]}'
        parser.feed(record["content_html"])
    manifest_path = ROOT / "migration/sources/media.json"
    previous = {row["original_url"]: row for row in json.loads(manifest_path.read_text(encoding="utf-8"))}
    paths = {row["path"].casefold(): url for url, row in previous.items()}
    tasks = []
    for index, (url, reference) in enumerate(parser.references.items(), 1):
        old = previous.get(url)
        if old:
            data = (ROOT / old["path"].lstrip("/")).read_bytes()
            if hashlib.sha256(data).hexdigest() != old["sha256"]:
                raise ValueError("Existing source asset changed locally: " + old["path"])
            tasks.append((url, reference, old, old["path"]))
        else:
            parts = urlsplit(url)
            filename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", unquote(parts.path.rsplit("/", 1)[-1])).strip(". ")
            if not filename or len(filename) > 150:
                filename = hashlib.sha256(url.encode()).hexdigest()[:16] + Path(filename).suffix
            path = "/blog/media/" + filename
            if path.casefold() in paths and paths[path.casefold()] != url:
                path = "/blog/media/" + hashlib.sha256(url.encode()).hexdigest()[:10] + "-" + filename
            paths[path.casefold()] = url
            tasks.append((url, reference, None, path))

    def download(task):
        url, reference, old, path = task
        if old:
            row = dict(old)
        else:
            parts = urlsplit(url)
            download_url = urlunsplit(("https" if parts.hostname in HOSTS else parts.scheme, parts.netloc, parts.path, parts.query, ""))
            for attempt in range(3):
                try:
                    with request(download_url) as response:
                        if int(response.headers.get("Content-Length", "0")) > MAX_ASSET_BYTES:
                            raise ValueError("Public asset exceeds the repository file limit: " + url)
                        data = response.read(MAX_ASSET_BYTES + 1)
                    break
                except (OSError, TimeoutError):
                    if attempt == 2:
                        raise
                    time.sleep(attempt + 1)
            if len(data) > MAX_ASSET_BYTES:
                raise ValueError("Public asset exceeds the repository file limit: " + url)
            asset_type(data)
            local = ROOT / path.lstrip("/")
            if local.exists() and local.read_bytes() != data:
                raise ValueError("Refusing to overwrite a different local asset: " + path)
            if not local.exists():
                local.write_bytes(data)
            row = {"original_url": url, "download_url": download_url, "path": path,
                   "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        row.update(reference)
        print(f'asset ready: {row["path"]} ({row["bytes"]} bytes)', flush=True)
        return row

    with ThreadPoolExecutor(max_workers=4) as executor:
        manifest = list(executor.map(download, tasks))
    save_json(manifest_path, manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checked-on", default=date.today().isoformat())
    parser.add_argument("--assets-only", action="store_true", help="Resume asset downloads from the already checked public snapshot")
    args = parser.parse_args()
    date.fromisoformat(args.checked_on)
    target = ROOT / f"migration/sources/public-{args.checked_on}.json"
    if args.assets_only:
        snapshot = json.loads(target.read_text(encoding="utf-8"))
        assert snapshot["visibility"] == "anonymous-public-only"
        records = snapshot["posts"] + snapshot["pages"]
        assert all(p["status"] == "publish" and not p["protected"] for p in records)
        assert all(hashlib.sha256(p["content_html"].encode()).hexdigest() == p["content_sha256"] for p in records)
        manifest = sync_assets(records)
        print(json.dumps({"posts": len(snapshot["posts"]), "pages": len(snapshot["pages"]), "assets": len(manifest)}, ensure_ascii=False))
        return
    posts, post_queries = fetch_collection("posts")
    pages, page_queries = fetch_collection("pages")
    categories, _ = fetch_collection("categories")
    tags, _ = fetch_collection("tags")
    snapshot = {"source": BASE, "query": post_queries + page_queries, "checked_on": args.checked_on,
                "visibility": "anonymous-public-only", "count": len(posts),
                "posts": [normalize(item, "post") for item in posts],
                "pages": [normalize(item, "page") for item in pages],
                "categories": [{key: item[key] for key in ("id", "name", "slug", "count")} for item in categories],
                "tags": [{key: item[key] for key in ("id", "name", "slug", "count")} for item in tags]}
    if len({p["id"] for p in snapshot["posts"] + snapshot["pages"]}) != len(posts) + len(pages):
        raise ValueError("Overlapping post/page IDs")
    save_json(target, snapshot)
    manifest = sync_assets(snapshot["posts"] + snapshot["pages"])
    print(json.dumps({"posts": len(posts), "pages": len(pages), "assets": len(manifest)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
