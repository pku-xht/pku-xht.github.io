"""Load the registered historical public comments and render safe comment HTML.

Only display fields are accepted. WordPress accounts, email addresses, IPs,
user-agent strings, avatars, cookies and moderation credentials are not sources.
"""
import hashlib
import html
import re
from collections import Counter
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from blog_sources import _yaml, load_blog


ROOT = Path(__file__).resolve().parents[1]
COMMENT_FIELDS = {"id", "post", "parent", "author_name", "author_url", "date", "date_gmt", "content", "link", "type", "status"}
ALLOWED_TAGS = set("p br strong em b i u s del code pre blockquote ul ol li dl dt dd a sup sub span div abbr acronym q cite hr h1 h2 h3 h4 h5 h6 table thead tbody tr th td".split())
BLOCKED_TAGS = set("script style iframe object embed form input button select option textarea svg math link meta base video audio source canvas noscript".split())
VOID_TAGS = {"br", "hr"}


def safe_comment_url(value, allow_local=False):
    """Return a safe display URL, or None; never emit executable URL schemes."""
    if not isinstance(value, str) or not value or any(ord(c) < 32 or c.isspace() for c in value) or "\\" in value:
        return None
    try:
        parts = urlsplit(value)
        if parts.username or parts.password:
            return None
        if parts.scheme in {"http", "https"} and parts.hostname:
            return value
        if allow_local and not parts.scheme and not parts.netloc and value.startswith(("/", "#")):
            return value
    except ValueError:
        return None
    return None


def validate_comment(value, post_ids=None):
    """Validate public fields without accepting or copying any private metadata."""
    if not isinstance(value, dict) or set(value) != COMMENT_FIELDS:
        raise ValueError("A comment must contain exactly the approved public display fields")
    for field in ("id", "post", "parent"):
        if type(value[field]) is not int or value[field] < (0 if field == "parent" else 1):
            raise ValueError(f"Comment {field} must be a valid integer")
    if post_ids is not None and value["post"] not in post_ids:
        raise ValueError("Comment belongs to a document outside the approved public collection")
    if value["status"] != "approved":
        raise ValueError("Unapproved comments are outside this public archive")
    if not isinstance(value["type"], str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value["type"]):
        raise ValueError("Comment type must be explicit public metadata")
    if not isinstance(value["author_name"], str) or not isinstance(value["author_url"], str):
        raise ValueError("Comment author name and URL must be text")
    if value["author_url"] and safe_comment_url(value["author_url"]) is None:
        raise ValueError("Comment author URL is not safe public HTTP(S)")
    if safe_comment_url(value["link"]) is None:
        raise ValueError("Comment source link is not safe public HTTP(S)")
    for field in ("date", "date_gmt"):
        if not isinstance(value[field], str):
            raise ValueError("Comment timestamps must preserve their original strings")
        try:
            parsed = datetime.fromisoformat(value[field])
        except ValueError as error:
            raise ValueError("Comment timestamp is not valid ISO text") from error
        if parsed.tzinfo is not None:
            raise ValueError("WordPress comment timestamps use separate local and GMT fields")
    if not isinstance(value["content"], dict) or set(value["content"]) != {"rendered"} or not isinstance(value["content"]["rendered"], str):
        raise ValueError("Only the original public rendered comment HTML is accepted")
    return value


def validate_thread(comments, post_id):
    by_id = {}
    for comment in comments:
        validate_comment(comment, {post_id})
        if comment["id"] in by_id:
            raise ValueError("Duplicate public comment ID")
        by_id[comment["id"]] = comment
    for comment in comments:
        visited, current = set(), comment
        while current["parent"]:
            if current["id"] in visited:
                raise ValueError("Public comment reply cycle")
            visited.add(current["id"])
            if current["parent"] not in by_id:
                raise ValueError("Reply parent is not present in this public document archive; do not fetch non-public parents")
            current = by_id[current["parent"]]


class SafeCommentHTML(HTMLParser):
    def __init__(self, link_resolver=None):
        super().__init__(convert_charrefs=True)
        self.parts, self.stack, self.blocked = [], [], []
        self.link_resolver = link_resolver

    def handle_starttag(self, tag, attrs):
        if self.blocked:
            if tag in BLOCKED_TAGS and tag not in {"input", "embed", "link", "meta", "base", "source"}:
                self.blocked.append(tag)
            return
        if tag in BLOCKED_TAGS:
            if tag not in {"input", "embed", "link", "meta", "base", "source"}:
                self.blocked.append(tag)
            return
        if tag == "img":
            raise ValueError("Comment images require an explicit public-resource review before rendering")
        if tag not in ALLOWED_TAGS:
            return
        original, safe = dict(attrs), {}
        if tag == "a":
            url = safe_comment_url(original.get("href", ""), allow_local=True)
            if url and self.link_resolver:
                url = self.link_resolver(url)
            url = safe_comment_url(url, allow_local=True)
            if url:
                safe["href"] = url
                if url.startswith(("http:", "https:")):
                    safe.update(target="_blank", rel="nofollow noopener noreferrer")
        if tag in {"abbr", "acronym", "q", "blockquote"} and "title" in original:
            safe["title"] = original["title"]
        if tag == "code":
            language = re.search(r"(?:^|\s)(language-[A-Za-z0-9_+-]+)(?:\s|$)", original.get("class", ""))
            if language:
                safe["class"] = language.group(1)
        if tag == "ol" and re.fullmatch(r"-?\d+", original.get("start", "")):
            safe["start"] = original["start"]
        if tag in {"td", "th"}:
            for name in ("colspan", "rowspan"):
                if re.fullmatch(r"[1-9]\d{0,3}", original.get(name, "")):
                    safe[name] = original[name]
        attributes = "".join(f' {key}="{html.escape(value, quote=True)}"' for key, value in safe.items())
        self.parts.append(f"<{tag}{attributes}>")
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if self.blocked:
            if tag == self.blocked[-1]:
                self.blocked.pop()
            return
        if tag in self.stack:
            while self.stack:
                closing = self.stack.pop()
                self.parts.append(f"</{closing}>")
                if closing == tag:
                    break

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_data(self, data):
        if not self.blocked:
            self.parts.append(html.escape(data, quote=False))

    def result(self):
        self.close()
        while self.stack:
            self.parts.append(f"</{self.stack.pop()}>")
        return "".join(self.parts)


def sanitize_comment_html(value, link_resolver=None):
    parser = SafeCommentHTML(link_resolver)
    parser.feed(value)
    return parser.result()


def load_comments(content_root=None, post_ids=None, project_root=None):
    """Load registered nonempty archives; every other scoped document gets []."""
    content_root = Path(content_root if content_root is not None else ROOT / "content/blog").resolve()
    project_root = Path(project_root if project_root is not None else ROOT).resolve()
    if post_ids is None:
        blog = load_blog(content_root, project_root=project_root)
        post_ids = [p["id"] for p in blog["posts"] + blog["pages"]]
    post_ids = set(post_ids)
    if any(type(post_id) is not int or post_id <= 0 for post_id in post_ids):
        raise ValueError("Public comment scope must contain positive document IDs")
    directory = content_root / "comments"
    index_path = directory / "index.yaml"
    index_bytes = index_path.read_bytes()
    index = _yaml(index_bytes.decode("utf-8-sig"), index_path)
    if not isinstance(index, dict) or set(index) != {"version", "files", "count"} or type(index["version"]) is not int or index["version"] != 1:
        raise ValueError("Comment index must contain version: 1, files and count")
    if not isinstance(index["files"], list) or type(index["count"]) is not int or index["count"] < 0:
        raise ValueError("Comment index files/count are invalid")
    registered, by_post, sources, all_ids = set(), {post_id: [] for post_id in post_ids}, {}, set()
    for member in index["files"]:
        if not isinstance(member, str) or not re.fullmatch(r"[1-9]\d*\.yaml", member):
            raise ValueError("Comment index members must be document-ID YAML files")
        path = (directory / member).resolve()
        if path.parent != directory or path in registered:
            raise ValueError("Duplicate or out-of-directory comment archive")
        registered.add(path)
        raw = path.read_bytes()
        document = _yaml(raw.decode("utf-8-sig"), path)
        if not isinstance(document, dict) or set(document) != {"version", "post_id", "comments"} or type(document["version"]) is not int or document["version"] != 1:
            raise ValueError("Comment archive must contain version: 1, post_id and comments")
        post_id = document["post_id"]
        if type(post_id) is not int or post_id not in post_ids or path.name != f"{post_id}.yaml":
            raise ValueError("Comment archive belongs outside the approved public collection")
        comments = document["comments"]
        if not isinstance(comments, list) or not comments:
            raise ValueError("Only nonempty comment archives are registered")
        validate_thread(comments, post_id)
        for comment in comments:
            if comment["id"] in all_ids:
                raise ValueError("Public comment IDs must be globally unique")
            all_ids.add(comment["id"])
        by_post[post_id] = sorted(comments, key=lambda c: (c["date_gmt"], c["id"]))
        try:
            source_file = path.relative_to(project_root).as_posix()
        except ValueError:
            source_file = path.relative_to(content_root).as_posix()
        sources[post_id] = {"source_file": source_file, "source_sha256": hashlib.sha256(raw).hexdigest(), "count": len(comments)}
    actual = {path.resolve() for path in directory.rglob("*.yaml") if path != index_path}
    if actual != registered:
        raise ValueError("Missing or unregistered formal comment YAML archives")
    if len(all_ids) != index["count"]:
        raise ValueError("Comment index total does not match formal archives")
    try:
        index_file = index_path.relative_to(project_root).as_posix()
    except ValueError:
        index_file = index_path.relative_to(content_root).as_posix()
    return {"source_format": "public-comments-yaml", "by_post": by_post, "sources": sources,
            "index_file": index_file, "index_sha256": hashlib.sha256(index_bytes).hexdigest(),
            "count": len(all_ids), "types": dict(Counter(c["type"] for values in by_post.values() for c in values))}
