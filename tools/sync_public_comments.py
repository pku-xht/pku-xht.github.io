"""Import approved public comments attached only to the maintained public collection.

Anonymous, read-only HTTP requests; no login, cookies, author account IDs,
avatars, email/IP/user-agent fields, or requests for hidden documents.
Existing formal archives and dated snapshots are never overwritten.
"""
import argparse
import json
import re
from collections import Counter, defaultdict
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from blog_comments import COMMENT_FIELDS, validate_comment, validate_thread
from blog_sources import _dependencies, load_blog


ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.xht37.com/index.php?rest_route=/wp/v2/comments"
FIELDS = "id,post,parent,author_name,author_url,date,date_gmt,content,link,type,status"
class NoCommentRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError("Unexpected comment API redirect; no alternate or hidden route was fetched")


OPENER = build_opener(NoCommentRedirects())  # No CookieProcessor or authentication handler.


def request(url):
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "www.xht37.com" or parts.username or parts.password:
        raise ValueError("Unexpected comment API URL")
    query = parse_qs(parts.query, keep_blank_values=True)
    if parts.path != "/index.php" or query.get("rest_route") != ["/wp/v2/comments"] or query.get("status") != ["approve"] or query.get("context") != ["view"]:
        raise ValueError("Only the anonymous approved-comment endpoint is allowed")
    if len(query.get("post", [])) != 1 or not re.fullmatch(r"[1-9]\d*(?:,[1-9]\d*)*", query["post"][0]):
        raise ValueError("Every comment API request needs an explicit public-document scope")
    return OPENER.open(Request(url, headers={"User-Agent": "xht37-public-comment-migration/1.0", "Accept": "application/json"}), timeout=30)


def query_url(post_ids, page=1, per_page=100, types=None):
    if not post_ids or any(type(post_id) is not int or post_id <= 0 for post_id in post_ids):
        raise ValueError("A nonempty explicit public-document scope is required")
    values = {"post": ",".join(str(post_id) for post_id in sorted(set(post_ids))),
              "status": "approve", "context": "view", "per_page": per_page,
              "page": page, "orderby": "id", "order": "asc", "_fields": FIELDS}
    if types is not None:
        values["type"] = types
    return BASE + "&" + urlencode(values)


def probe_type_coverage(post_ids, request_fn=request):
    url = query_url(post_ids, per_page=1, types="")
    try:
        with request_fn(url) as response:
            items = json.load(response)
            if not isinstance(items, list):
                raise ValueError("Expected a scoped public comment list")
            for item in items:
                validate_comment(item, set(post_ids))
        return "", {"query": url, "http_status": 200, "api_types": "all approved public types"}
    except HTTPError as error:
        if error.code not in {401, 403}:
            raise
        metadata = json.load(error)
        return None, {"query": url, "http_status": error.code, "error_code": metadata.get("code"),
                      "api_types": "comment only; pingback/trackback require separate public-view evidence"}


def fetch_approved_comments(post_ids, types=None, request_fn=request):
    scope, records, queries, pagination, seen = set(post_ids), [], [], [], set()
    page, expected_total, expected_pages = 1, None, None
    while expected_pages is None or page <= expected_pages:
        url = query_url(scope, page=page, types=types)
        with request_fn(url) as response:
            total = int(response.headers["X-WP-Total"])
            pages = max(1, int(response.headers["X-WP-TotalPages"]))
            items = json.load(response)
        if expected_total is None:
            expected_total, expected_pages = total, pages
        if total != expected_total or pages != expected_pages:
            raise ValueError("Public comment collection changed during pagination; nothing saved")
        if not isinstance(items, list):
            raise ValueError("Expected a scoped public comment list")
        for item in items:
            # Reject unexpected fields, rather than retaining or printing private data.
            if not isinstance(item, dict) or set(item) != COMMENT_FIELDS:
                raise ValueError("Anonymous response did not contain exactly the requested public display fields")
            validate_comment(item, scope)
            if item["id"] in seen:
                raise ValueError("Repeated comment ID; possible swallowed pagination parameter")
            if types is None and item["type"] != "comment":
                raise ValueError("Unexpected type in the API's default comment collection")
            seen.add(item["id"])
            records.append(item)
        queries.append(url)
        pagination.append({"page": page, "received": len(items), "x_wp_total": total, "x_wp_total_pages": pages})
        print(f"public comments page {page}/{pages}: {len(items)} approved records", flush=True)
        page += 1
    if len(records) != expected_total:
        raise ValueError("Public comment total and unique-ID count disagree")
    grouped = defaultdict(list)
    for item in records:
        grouped[item["post"]].append(item)
    for post_id, comments in grouped.items():
        validate_thread(comments, post_id)
    return sorted(records, key=lambda c: (c["post"], c["date_gmt"], c["id"])), queries, pagination


def _escaped(value, position):
    previous = position - 1
    while previous >= 0 and value[previous] == "\\":
        previous -= 1
    return (position - previous - 1) % 2 == 1


class CommentInventory(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags, self.attributes = Counter(), Counter()
        self.image_urls, self.attachment_urls, self.formulas, self.unclosed = [], [], [], []
        self.run, self.code_depth, self.comment_id, self.dollars = [], 0, None, 0

    def flush(self):
        text = "".join(self.run)
        self.run.clear()
        position = 0
        while position < len(text):
            if text[position] != "$" or _escaped(text, position):
                position += 1
                continue
            delimiter = "$$" if text.startswith("$$", position) else "$"
            closing = text.find(delimiter, position + len(delimiter))
            while closing >= 0 and _escaped(text, closing):
                closing = text.find(delimiter, closing + len(delimiter))
            if closing < 0:
                self.unclosed.append(self.comment_id)
                break
            self.formulas.append({"comment_id": self.comment_id, "original": text[position:closing + len(delimiter)]})
            position = closing + len(delimiter)

    def handle_starttag(self, tag, attrs):
        self.tags[tag] += 1
        self.attributes.update(name for name, _ in attrs)
        values = dict(attrs)
        if tag == "img":
            self.image_urls.append(values.get("src", ""))
        if tag == "a":
            url = values.get("href", "")
            if "/wp-content/uploads/" in url or re.search(r"\.(pdf|zip|rar|7z|mp3|mp4)(?:[?#]|$)", url, re.I):
                self.attachment_urls.append(url)
        if tag in {"code", "pre"}:
            self.flush()
            self.code_depth += 1
        elif tag == "br" and not self.code_depth:
            self.run.append("\n")
        else:
            self.flush()

    def handle_endtag(self, tag):
        if tag in {"code", "pre"}:
            self.code_depth = max(0, self.code_depth - 1)
        if tag != "br":
            self.flush()

    def handle_data(self, value):
        if not self.code_depth:
            self.run.append(value)
            self.dollars += value.count("$")


def inventory_comments(comments):
    inventory = CommentInventory()
    for comment in comments:
        inventory.comment_id = comment["id"]
        inventory.feed(comment["content"]["rendered"])
        inventory.flush()
    inventory.close()
    return {"comments": len(comments), "posts_with_comments": len({c["post"] for c in comments}),
            "replies": sum(c["parent"] != 0 for c in comments), "types": dict(Counter(c["type"] for c in comments)),
            "html_tags": dict(inventory.tags), "html_attributes": dict(inventory.attributes),
            "image_urls": inventory.image_urls, "attachment_urls": inventory.attachment_urls,
            "dollar_characters_outside_code": inventory.dollars, "formulas": inventory.formulas,
            "unclosed_math_comment_ids": sorted(set(inventory.unclosed))}


def yaml_text(value):
    _, yaml, _ = _dependencies()
    class Dumper(yaml.SafeDumper):
        pass
    def represent_string(dumper, text):
        return dumper.represent_scalar("tag:yaml.org,2002:str", text, style="|" if "\n" in text else None)
    Dumper.add_representer(str, represent_string)
    return yaml.dump(value, Dumper=Dumper, allow_unicode=True, sort_keys=False, width=1000)


def write_new_snapshot(snapshot, content_root, snapshot_path):
    directory = content_root / "comments"
    grouped = defaultdict(list)
    scope = set(snapshot["scope_post_ids"])
    if snapshot["count"] != len(snapshot["comments"]):
        raise ValueError("Comment snapshot count does not match its records")
    for item in snapshot["comments"]:
        validate_comment(item, scope)
        grouped[item["post"]].append(item)
    for post_id, comments in grouped.items():
        validate_thread(comments, post_id)
    files = [f"{post_id}.yaml" for post_id in sorted(grouped)]
    targets = [(directory / name, yaml_text({"version": 1, "post_id": int(name[:-5]), "comments": grouped[int(name[:-5])]})) for name in files]
    targets.append((directory / "index.yaml", yaml_text({"version": 1, "files": files, "count": len(snapshot["comments"])})))
    targets.append((snapshot_path, json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n"))
    if any(path.exists() for path, _ in targets):
        raise FileExistsError("Refusing to overwrite maintained comment sources or an existing original snapshot")
    for path, text in targets:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checked-on", default=date.today().isoformat())
    parser.add_argument("--inventory-only", action="store_true", help="Report the scoped public count and HTML inventory without writing files")
    args = parser.parse_args()
    date.fromisoformat(args.checked_on)
    blog = load_blog()
    scope = sorted(p["id"] for p in blog["posts"] + blog["pages"])
    snapshot_path = ROOT / f"migration/sources/comments-public-{args.checked_on}.json"
    if not args.inventory_only and ((ROOT / "content/blog/comments/index.yaml").exists() or snapshot_path.exists()):
        raise FileExistsError("Maintained comment sources already exist; no network import was performed")
    types, coverage = probe_type_coverage(scope)
    comments, queries, pagination = fetch_approved_comments(scope, types=types)
    stats = inventory_comments(comments)
    snapshot = {"source": "https://www.xht37.com/", "checked_on": args.checked_on,
                "visibility": "approved-public-comments-for-migrated-content", "scope_post_ids": scope,
                "query": queries, "pagination": pagination, "type_coverage": coverage,
                "count": len(comments), "comments": comments, "inventory": stats}
    print(json.dumps({"scope_documents": len(scope), "comments": len(comments), "type_coverage": coverage,
                      "inventory": stats}, ensure_ascii=False), flush=True)
    if not args.inventory_only:
        write_new_snapshot(snapshot, ROOT / "content/blog", snapshot_path)


if __name__ == "__main__":
    main()
