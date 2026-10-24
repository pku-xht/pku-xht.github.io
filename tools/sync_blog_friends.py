"""Import only the 25 approved anonymous sidebar friend links, never targets.

The entire HTTP response is used only in memory. Only the 友情链接 aside is
retained as public evidence, and maintained YAML is never overwritten.
"""
import argparse
import hashlib
import json
import sys
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from blog_friends import ROOT, SOURCE_URL, extract_friend_container

sys.path.insert(0, str(ROOT / "tools/vendor/python"))
import yaml

EXPECTED_COUNT = 25
MAX_BYTES = 4_000_000


class _OldSiteRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        target = urlsplit(newurl)
        if target.scheme not in {"http", "https"} or target.hostname not in {"xht37.com", "www.xht37.com"} or target.username or target.password:
            raise ValueError("Anonymous friend-link request redirected away from the old site")
        return super().redirect_request(request, response, code, message, headers, newurl)


def fetch_friends():
    request = Request(SOURCE_URL, headers={"User-Agent": "xht37-public-blog-migration/1.0"})
    # No CookieProcessor, authorization header, browser session or target visits.
    with build_opener(_OldSiteRedirects()).open(request, timeout=30) as response:
        final_url = response.geturl()
        raw = response.read(MAX_BYTES + 1)
        encoding = response.headers.get_content_charset() or "utf-8"
        if response.status != 200 or len(raw) > MAX_BYTES:
            raise ValueError("Unexpected or oversized old-site public homepage response")
    container, links = extract_friend_container(raw.decode(encoding))
    if len(links) != EXPECTED_COUNT:
        raise ValueError(f"Approved scope contains {EXPECTED_COUNT} friend links; observed {len(links)}, no files written")
    return container, links, final_url


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checked-on", required=True, help="Public source check date, YYYY-MM-DD")
    parser.add_argument("--destination", type=Path, default=ROOT / "content/blog/friends.yaml")
    parser.add_argument("--snapshot-dir", type=Path, default=ROOT / "migration/sources")
    args = parser.parse_args()
    if date.fromisoformat(args.checked_on).isoformat() != args.checked_on:
        raise ValueError("checked-on must use YYYY-MM-DD")
    html_path = args.snapshot_dir / f"friends-public-{args.checked_on}.html"
    json_path = args.snapshot_dir / f"friends-public-{args.checked_on}.json"
    for target in [args.destination, html_path, json_path]:
        if target.exists():
            raise FileExistsError(f"Refusing to overwrite maintained friend links or public evidence: {target}")
    container, links, final_url = fetch_friends()
    encoded = container.encode("utf-8")
    snapshot = {"source": SOURCE_URL, "fetched_url": final_url, "checked_on": args.checked_on, "visibility": "anonymous-public-only", "scope": "sidebar-friend-links-only", "container": "aside containing h4.widget-title=友情链接 and ul.widget-links", "count": len(links), "html_file": html_path.name, "html_sha256": hashlib.sha256(encoded).hexdigest(), "links": links}
    # All extraction and validation completes before any output is created.
    for directory in {args.destination.parent, args.snapshot_dir}:
        directory.mkdir(parents=True, exist_ok=True)
    with args.destination.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(yaml.safe_dump({"version": 1, "links": links}, allow_unicode=True, sort_keys=False))
    with html_path.open("xb") as handle:
        handle.write(encoded)
    with json_path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"count": len(links), "source": SOURCE_URL, "first": links[0]["name"], "last": links[-1]["name"], "html_sha256": snapshot["html_sha256"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
