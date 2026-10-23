"""Load the blog's registered Markdown files and render their preserved TeX.

All runtime packages are vendored, pure Python, and loaded without installing
anything. Original WordPress snapshots are intentionally outside this module.
"""
import hashlib
import html
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit


PROJECT_ROOT = Path(__file__).resolve().parents[1]
VENDOR = Path(__file__).resolve().parent / "vendor/python"
SOURCE_FORMAT = "markdown-yaml"
_MARKDOWN = None
_YAML = None
_YAML_LOADER = None
_HTML_TAG = re.compile(r'''<(/?)([A-Za-z][A-Za-z0-9:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>''')


def _dependencies():
    global _MARKDOWN, _YAML, _YAML_LOADER
    if _MARKDOWN is not None:
        return _MARKDOWN, _YAML, _YAML_LOADER
    vendor = str(VENDOR)
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    try:
        import yaml
        from markdown_it import MarkdownIt
    except ImportError as error:
        raise RuntimeError("Blog dependencies are missing from tools/vendor/python") from error

    class UniqueSafeLoader(yaml.SafeLoader):
        def construct_mapping(self, node, deep=False):
            self.flatten_mapping(node)
            mapping = {}
            for key_node, value_node in node.value:
                key = self.construct_object(key_node, deep=deep)
                try:
                    duplicate = key in mapping
                except TypeError as error:
                    raise ValueError("YAML mapping keys must be scalar values") from error
                if duplicate:
                    raise ValueError(f"Duplicate YAML key: {key!r}")
                mapping[key] = self.construct_object(value_node, deep=deep)
            return mapping

    UniqueSafeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, UniqueSafeLoader.construct_mapping)
    _MARKDOWN = MarkdownIt("commonmark", {"html": True, "linkify": False, "typographer": False, "breaks": False}).enable("table")
    _YAML = yaml
    _YAML_LOADER = UniqueSafeLoader
    return _MARKDOWN, _YAML, _YAML_LOADER


def _yaml(text, location):
    _, yaml, loader = _dependencies()
    try:
        return yaml.load(text, Loader=loader)
    except (yaml.YAMLError, ValueError) as error:
        raise ValueError(f"Invalid YAML in {location}: {error}") from error


def _tokens(tokens):
    for token in tokens:
        yield token
        if token.children:
            yield from _tokens(token.children)


def _escaped(source, position):
    previous = position - 1
    while previous >= 0 and source[previous] == "\\":
        previous -= 1
    return (position - 1 - previous) % 2 == 1


def _mask_math(source, markdown):
    # Block token maps identify fenced/indented code, including code in lists.
    # A formula is consumed from its opening delimiter before any interior code
    # range is visited, so indented TeX inside $$ remains one exact expression.
    offsets = [0]
    for line in source.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    code_ranges = sorted((offsets[token.map[0]], offsets[min(token.map[1], len(offsets) - 1)]) for token in _tokens(markdown.parse(source)) if token.type in {"fence", "code_block"} and token.map)
    marker_prefix = "BLOGMATH" + hashlib.sha256(source.encode("utf-8")).hexdigest()[:20] + "X"
    while marker_prefix in source:
        marker_prefix += "X"
    protected, pieces = {}, []
    start = position = range_index = 0
    while position < len(source):
        while range_index < len(code_ranges) and position >= code_ranges[range_index][1]:
            range_index += 1
        if range_index < len(code_ranges) and code_ranges[range_index][0] <= position < code_ranges[range_index][1]:
            position = code_ranges[range_index][1]
            continue
        if source.startswith("<!--", position):
            closing = source.find("-->", position + 4)
            position = len(source) if closing < 0 else closing + 3
            continue
        if source[position] == "<":
            tag = _HTML_TAG.match(source, position)
            if tag:
                position = tag.end()
                if not tag.group(1) and tag.group(2).lower() in {"pre", "code"}:
                    closing = re.search(r"</" + re.escape(tag.group(2)) + r"\s*>", source[position:], re.I)
                    position = len(source) if closing is None else position + closing.end()
                continue
        if source[position] == "`" and not _escaped(source, position):
            opening = re.match(r"`+", source[position:]).group(0)
            closing = re.search(r"(?<!`)" + re.escape(opening) + r"(?!`)", source[position + len(opening):])
            if closing:
                position += len(opening) + closing.end()
                continue
            position += len(opening)
            continue
        if source[position] == "$" and _escaped(source, position):
            marker = marker_prefix + str(len(protected)) + "END"
            protected[marker] = (source[position - 1:position + 1], True)
            pieces.extend([source[start:position - 1], marker])
            position = start = position + 1
            continue
        if source[position] != "$":
            position += 1
            continue
        delimiter = "$$" if source.startswith("$$", position) else "$"
        closing = position + len(delimiter)
        while True:
            closing = source.find(delimiter, closing)
            if closing < 0:
                raise ValueError(f"Unclosed TeX delimiter near {source[max(0, position - 25):position + 100]!r}")
            if not _escaped(source, closing):
                break
            closing += len(delimiter)
        end = closing + len(delimiter)
        marker = marker_prefix + str(len(protected)) + "END"
        protected[marker] = (source[position:end], False)
        pieces.extend([source[start:position], marker])
        position = start = end
    pieces.append(source[start:])
    return "".join(pieces), protected


def render_markdown(text):
    """Render CommonMark + tables + real HTML without interpreting TeX syntax.

    Code is excluded from formula masking. Math found inside a raw HTML block
    retains that HTML's entities and br tags; native Markdown math is escaped
    as literal HTML text, preserving every TeX character and newline.
    """
    if not isinstance(text, str):
        raise TypeError("Markdown body must be text")
    markdown, _, _ = _dependencies()
    masked, protected = _mask_math(text, markdown)
    tokens = markdown.parse(masked)
    raw_html = set()
    for token in _tokens(tokens):
        if token.type in {"html_block", "html_inline"}:
            raw_html.update(marker for marker in protected if marker in token.content)
    rendered = markdown.renderer.render(tokens, markdown.options, {})
    for marker, (original, literal_dollar) in protected.items():
        if marker in raw_html:
            replacement = original
        elif literal_dollar:
            replacement = '<span data-blog-literal-dollar="1">$</span>'
        else:
            replacement = html.escape(original, quote=False)
        rendered = rendered.replace(marker, replacement)
    return rendered


def _taxonomy(value, field, location):
    if not isinstance(value, list):
        raise ValueError(f"{location}: {field} must be a list of id/name mappings")
    result, seen = [], set()
    for entry in value:
        if not isinstance(entry, dict) or type(entry.get("id")) is not int or entry["id"] <= 0 or not isinstance(entry.get("name"), str) or not entry["name"].strip():
            raise ValueError(f"{location}: invalid {field} entry: {entry!r}")
        if entry["id"] in seen:
            raise ValueError(f"{location}: duplicate {field} id {entry['id']}")
        seen.add(entry["id"])
        result.append({"id": entry["id"], "name": entry["name"]})
    return result


def _timestamp(value, field, location):
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{location}: {field} must be an ISO timestamp with +08:00") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(hours=8):
        raise ValueError(f"{location}: {field} must include the original +08:00 timezone")
    return parsed.replace(tzinfo=None).isoformat(), parsed.astimezone(timezone.utc).replace(tzinfo=None).isoformat()


def load_resources(source_dir=None):
    """Load the canonical public-resource map; file bytes are checked at build."""
    source_dir = Path(source_dir if source_dir is not None else PROJECT_ROOT / "content/blog")
    path = source_dir / "resources.yaml"
    value = _yaml(path.read_text(encoding="utf-8"), path)
    if isinstance(value, dict):
        if type(value.get("version")) is not int or value["version"] != 1:
            raise ValueError(f"{path}: expected version: 1")
        value = value.get("resources")
    if not isinstance(value, list):
        raise ValueError(f"{path}: resources must be a list")
    seen = set()
    for entry in value:
        if not isinstance(entry, dict) or not isinstance(entry.get("original_url"), str):
            raise ValueError(f"{path}: each resource needs an original_url mapping")
        original = urlsplit(entry["original_url"])
        if original.scheme not in {"http", "https"} or not original.hostname or original.username or original.password:
            raise ValueError(f"{path}: resource original_url must be a public HTTP URL")
        local = entry.get("path", "")
        if not isinstance(local, str) or not local.startswith("/blog/media/") or ".." in PurePosixPath(local).parts or "\\" in local:
            raise ValueError(f"{path}: resource path must stay inside /blog/media/")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise ValueError(f"{path}: resource needs a lowercase SHA-256 hash")
        if entry["original_url"] in seen:
            raise ValueError(f"{path}: duplicate original resource URL: {entry['original_url']}")
        seen.add(entry["original_url"])
    return value


def read_document(path, expected_type=None):
    """Read one Markdown file; source hashes cover the actual UTF-8 file bytes."""
    path = Path(path)
    raw = path.read_bytes()
    try:
        source = raw.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError(f"{path}: source is not valid UTF-8") from error
    lines = source.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"{path}: Markdown source needs YAML front matter")
    closing = next((index for index in range(1, len(lines)) if lines[index].strip() == "---"), None)
    if closing is None:
        raise ValueError(f"{path}: YAML front matter is not closed")
    metadata = _yaml("".join(lines[1:closing]), path)
    if not isinstance(metadata, dict):
        raise ValueError(f"{path}: YAML front matter must be a mapping")
    required = {"id", "type", "title", "date", "modified", "slug", "original_url", "categories", "tags"}
    missing = sorted(required - metadata.keys())
    if missing:
        raise ValueError(f"{path}: missing front matter fields: {', '.join(missing)}")
    if type(metadata["id"]) is not int or metadata["id"] <= 0 or path.name != f"{metadata['id']}.md":
        raise ValueError(f"{path}: positive id must match the Markdown filename")
    if metadata["type"] not in {"post", "page"} or (expected_type and metadata["type"] != expected_type):
        raise ValueError(f"{path}: unexpected document type {metadata['type']!r}")
    for field in ["title", "slug", "original_url"]:
        if not isinstance(metadata[field], str) or not metadata[field].strip():
            raise ValueError(f"{path}: {field} must be nonempty text")
    original = urlsplit(metadata["original_url"])
    if original.scheme not in {"http", "https"} or not original.hostname or original.username or original.password or any(ord(ch) < 32 for ch in metadata["original_url"]):
        raise ValueError(f"{path}: original_url must be a public HTTP URL")
    if "summary" in metadata and not isinstance(metadata["summary"], str):
        raise ValueError(f"{path}: summary must be text")
    date, date_gmt = _timestamp(metadata["date"], "date", path)
    modified, modified_gmt = _timestamp(metadata["modified"], "modified", path)
    categories = _taxonomy(metadata["categories"], "categories", path)
    tags = _taxonomy(metadata["tags"], "tags", path)
    legacy_anchors = metadata.get("legacy_anchors", {})
    if not isinstance(legacy_anchors, dict) or any(not isinstance(key, str) or not key or not isinstance(value, str) or not value.strip() for key, value in legacy_anchors.items()):
        raise ValueError(f"{path}: legacy_anchors must map fragments to heading text")
    if metadata["type"] == "page" and categories:
        raise ValueError(f"{path}: historical pages must not have article categories")
    body = "".join(lines[closing + 1:])
    try:
        content_html = render_markdown(body)
    except (ValueError, RuntimeError) as error:
        raise ValueError(f"{path}: {error}") from error
    record = {"id": metadata["id"], "type": metadata["type"], "title": metadata["title"], "date": date, "date_gmt": date_gmt, "modified": modified, "modified_gmt": modified_gmt, "slug": metadata["slug"], "link": metadata["original_url"], "status": "publish", "protected": False, "categories": [c["id"] for c in categories], "tags": [tag["id"] for tag in tags], "category_terms": categories, "tag_terms": tags, "legacy_anchors": legacy_anchors, "content_html": content_html, "content_sha256": hashlib.sha256(content_html.encode("utf-8")).hexdigest(), "source_file": path.as_posix(), "source_sha256": hashlib.sha256(raw).hexdigest()}
    if "summary" in metadata:
        record["summary"] = metadata["summary"]
    return record


def load_blog(content_root=None, project_root=None):
    """Load exactly the documents registered by content/blog/collection.yaml."""
    content_root = Path(content_root if content_root is not None else PROJECT_ROOT / "content/blog").resolve()
    project_root = Path(project_root if project_root is not None else PROJECT_ROOT).resolve()
    manifest_path = content_root / "collection.yaml"
    manifest = _yaml(manifest_path.read_text(encoding="utf-8"), manifest_path)
    if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1:
        raise ValueError(f"{manifest_path}: expected version: 1")
    registered, groups = set(), {"posts": [], "pages": []}
    for group, document_type in [("posts", "post"), ("pages", "page")]:
        members = manifest.get(group)
        if not isinstance(members, list):
            raise ValueError(f"{manifest_path}: {group} must be a file list")
        for member in members:
            if not isinstance(member, str) or not re.fullmatch(group + r"/[1-9]\d*\.md", member) or PurePosixPath(member).is_absolute():
                raise ValueError(f"{manifest_path}: invalid {group} member: {member!r}")
            path = (content_root / member).resolve()
            try:
                path.relative_to(content_root)
            except ValueError as error:
                raise ValueError(f"{manifest_path}: member escapes content root: {member}") from error
            if path in registered:
                raise ValueError(f"{manifest_path}: duplicate Markdown member: {member}")
            registered.add(path)
            if not path.is_file():
                raise ValueError(f"{manifest_path}: registered Markdown file is missing: {member}")
            record = read_document(path, expected_type=document_type)
            try:
                record["source_file"] = path.relative_to(project_root).as_posix()
            except ValueError:
                record["source_file"] = path.relative_to(content_root).as_posix()
            groups[group].append(record)
    actual = {path.resolve() for path in content_root.rglob("*.md") if path.is_file()}
    if actual != registered:
        extra = sorted(str(path.relative_to(content_root)) for path in actual - registered)
        raise ValueError(f"{manifest_path}: unregistered Markdown files: {', '.join(extra)}")
    documents = groups["posts"] + groups["pages"]
    if len({post["id"] for post in documents}) != len(documents):
        raise ValueError(f"{manifest_path}: document ids must be globally unique")
    taxonomies = {}
    for field, terms in [("categories", "category_terms"), ("tags", "tag_terms")]:
        combined = {}
        for post in documents:
            for term in post[terms]:
                previous = combined.get(term["id"])
                if previous and previous["name"] != term["name"]:
                    raise ValueError(f"Conflicting {field} name for id {term['id']}: {previous['name']!r} / {term['name']!r}")
                combined.setdefault(term["id"], {**term, "count": 0})["count"] += 1
        taxonomies[field] = list(combined.values())
    return {"source_format": SOURCE_FORMAT, "source": content_root.as_posix(), "visibility": "public-repository-source", "count": len(groups["posts"]), "resources": load_resources(content_root), **groups, **taxonomies}
