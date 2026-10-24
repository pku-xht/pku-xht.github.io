"""Load the maintained public friend links and check their narrow archive."""
import argparse
import hashlib
import json
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from blog_sources import _yaml

ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://www.xht37.com/"
DEFAULT_SOURCE = ROOT / "content/blog/friends.yaml"
DEFAULT_SNAPSHOT = ROOT / "migration/sources/friends-public-2026-10-25.json"
VOID = set("area base br col embed hr img input link meta param source track wbr".split())


def validate_friends(links, location="friend links"):
    """Validate order-preserving name/URL records without visiting any target."""
    if not isinstance(links, list) or not links:
        raise ValueError(f"{location}: links must be a nonempty list")
    result, names, urls = [], set(), set()
    for item in links:
        if not isinstance(item, dict) or set(item) != {"name", "url"}:
            raise ValueError(f"{location}: each link must contain exactly name and url")
        name, url = item["name"], item["url"]
        if not isinstance(name, str) or not name.strip() or name != name.strip() or any(ord(char) < 32 for char in name):
            raise ValueError(f"{location}: link name must be nonempty plain text")
        if not isinstance(url, str) or not url or any(char.isspace() or ord(char) < 32 for char in url) or "\\" in url:
            raise ValueError(f"{location}: link URL must be an HTTP URL without whitespace")
        try:
            parts = urlsplit(url)
            port = parts.port
        except ValueError as error:
            raise ValueError(f"{location}: invalid URL: {url!r}") from error
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
            raise ValueError(f"{location}: link URL must use public http/https: {url!r}")
        canonical = urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, parts.query, parts.fragment))
        if name.casefold() in names or canonical in urls:
            raise ValueError(f"{location}: duplicate name or URL: {name!r}")
        names.add(name.casefold())
        urls.add(canonical)
        result.append({"name": name, "url": url})
    return result


def load_friends(path=None):
    """Read only the formal YAML source; no snapshot or network dependency."""
    path = Path(path if path is not None else DEFAULT_SOURCE)
    value = _yaml(path.read_text(encoding="utf-8"), path)
    if not isinstance(value, dict) or set(value) != {"version", "links"} or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError(f"{path}: expected version: 1 and links")
    return validate_friends(value["links"], path)


@dataclass
class _Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    start: int = 0
    end: int = 0


class _Document(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.source = source
        self.line_starts = [0]
        for index, char in enumerate(source):
            if char == "\n":
                self.line_starts.append(index + 1)
        self.root = _Node("root")
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def source_offset(self):
        line, column = self.getpos()
        return self.line_starts[line - 1] + column

    def handle_starttag(self, tag, attrs):
        start = self.source_offset()
        node = _Node(tag, dict(attrs), start=start, end=start + len(self.get_starttag_text()))
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.stack.pop()

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack[index].end = self.source.index(">", self.source_offset()) + 1
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def _nodes(node):
    if isinstance(node, _Node):
        yield node
        for child in node.children:
            yield from _nodes(child)


def _text(node):
    if isinstance(node, str):
        return node
    return "".join(_text(child) for child in node.children)


def extract_friend_container(source):
    """Return only the titled public sidebar widget and its ordered links."""
    root = _Document(source).root
    widgets = []
    for node in _nodes(root):
        if node.tag != "aside":
            continue
        headings = [child for child in _nodes(node) if child.tag == "h4" and "widget-title" in child.attrs.get("class", "").split()]
        if any(" ".join(_text(heading).split()) == "友情链接" for heading in headings):
            widgets.append(node)
    if len(widgets) != 1:
        raise ValueError(f"Expected one 友情链接 sidebar widget, found {len(widgets)}")
    widget = widgets[0]
    lists = [node for node in _nodes(widget) if node.tag == "ul" and "widget-links" in node.attrs.get("class", "").split()]
    if len(lists) != 1:
        raise ValueError("The friend-link widget must contain exactly one widget-links list")
    rows = [child for child in lists[0].children if isinstance(child, _Node)]
    if not rows or any(row.tag != "li" for row in rows):
        raise ValueError("The friend-link list contains unexpected row markup")
    links = []
    for row in rows:
        anchors = [node for node in _nodes(row) if node.tag == "a"]
        if len(anchors) != 1 or "href" not in anchors[0].attrs:
            raise ValueError("Every friend-link row must contain one named link")
        links.append({"name": " ".join(_text(anchors[0]).split()), "url": anchors[0].attrs["href"]})
    if not source[widget.start:widget.end].endswith("</aside>"):
        raise ValueError("The friend-link sidebar widget was not fully closed")
    return source[widget.start:widget.end], validate_friends(links, "public friend-link widget")


def check_friends_snapshot(path=None, snapshot_path=None):
    """Compare the formal ordered list with the saved public widget evidence."""
    snapshot_path = Path(snapshot_path if snapshot_path is not None else DEFAULT_SNAPSHOT)
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    if snapshot.get("source") != SOURCE_URL or snapshot.get("visibility") != "anonymous-public-only" or snapshot.get("scope") != "sidebar-friend-links-only":
        raise ValueError(f"{snapshot_path}: unrecognized public friend-link evidence")
    html_file = snapshot.get("html_file", "")
    if not isinstance(html_file, str) or Path(html_file).name != html_file or not html_file.endswith(".html"):
        raise ValueError(f"{snapshot_path}: html_file must be a neighboring HTML filename")
    html_path = snapshot_path.parent / html_file
    raw = html_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != snapshot.get("html_sha256"):
        raise ValueError(f"{html_path}: public sidebar HTML digest changed")
    container, parsed = extract_friend_container(raw.decode("utf-8"))
    if container != raw.decode("utf-8"):
        raise ValueError(f"{html_path}: evidence must contain only the friend-link widget")
    archived = validate_friends(snapshot.get("links"), snapshot_path)
    current = load_friends(path)
    if type(snapshot.get("count")) is not int or snapshot["count"] != len(parsed) or archived != parsed or current != parsed:
        raise ValueError(f"{snapshot_path}: friend-link names, URLs, count or order differ")
    return {"count": len(current), "source": SOURCE_URL, "snapshot": snapshot_path.relative_to(ROOT).as_posix() if snapshot_path.is_relative_to(ROOT) else snapshot_path.as_posix()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--original-snapshot", action="store_true")
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    args = parser.parse_args()
    if args.original_snapshot:
        report = check_friends_snapshot(args.source, args.snapshot)
    else:
        report = {"count": len(load_friends(args.source)), "source": args.source.as_posix()}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
