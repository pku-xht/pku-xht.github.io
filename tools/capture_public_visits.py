"""Capture public legacy Visits markers into an explicitly external file."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ARCHIVE = Path(r'D:\xht37-private-archive')
PRIVATE_OUTPUT = PRIVATE_ARCHIVE / 'tmp' / 'visits-cutover-2026-10-31'
LIMIT = 8 * 1024 * 1024
MARKER = re.compile(r"\s*Visits:\s*([0-9]+)\s*\Z")


class VisitsParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paragraph = None
        self.counts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'p':
            if self.paragraph is not None:
                raise ValueError('nested paragraph')
            self.paragraph = []
        elif self.paragraph is not None:
            self.paragraph.append('\x00')

    def handle_data(self, data):
        if self.paragraph is not None:
            self.paragraph.append(data)

    def handle_endtag(self, tag):
        if tag == 'p' and self.paragraph is not None:
            match = MARKER.fullmatch(''.join(self.paragraph))
            if match:
                self.counts.append(int(match.group(1)))
            self.paragraph = None


def parse_visits(html):
    parser = VisitsParser()
    parser.feed(html)
    parser.close()
    if len(parser.counts) != 1 or parser.counts[0] > 9007199254740991:
        raise ValueError('expected one valid Visits paragraph')
    return parser.counts[0]


def document_urls():
    registry = json.loads((ROOT / 'services/blog-api/data/public-documents.json').read_text(encoding='utf-8'))
    expected = {str(row['id']) for row in registry['documents']}
    batch = json.loads((ROOT / 'migration/public-batch.json').read_text(encoding='utf-8'))
    rows = batch['posts'] + batch['pages']
    urls = {}
    for row in rows:
        identity, url = str(row['id']), row['original_url']
        parts = urlsplit(url)
        if identity in urls or not re.fullmatch(r'[1-9][0-9]*', identity):
            raise ValueError('duplicate or invalid document ID')
        if (parts.scheme != 'https' or parts.netloc != 'www.xht37.com' or not parts.path.startswith('/')
                or parts.query or parts.fragment or not url.isascii() or re.search(r'[\x00-\x20\x7f]|%(?![0-9a-fA-F]{2})', url)):
            raise ValueError('invalid legacy URL')
        urls[identity] = url
    if len(expected) != len(registry['documents']) or set(urls) != expected or len(set(urls.values())) != len(urls):
        raise ValueError('legacy URLs do not match the public registry')
    return urls


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def capture_one(item):
    identity, url = item
    try:
        request = Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; public visits capture)'})
        with build_opener(NoRedirect()).open(request, timeout=20) as response:
            if response.status != 200 or response.headers.get_content_type() != 'text/html':
                raise ValueError('unexpected status or content type')
            body = response.read(LIMIT + 1)
            if len(body) > LIMIT:
                raise ValueError('page too large')
            charset = response.headers.get_content_charset() or 'utf-8'
            count = parse_visits(body.decode(charset, errors='strict'))
        return {'document': identity, 'base': count}
    except Exception as error:
        code = 'http_' + str(error.code) if isinstance(error, HTTPError) else type(error).__name__
        return {'document': identity, 'error': code}


def validate_output(path, private_archive_output=False):
    path = path.resolve()
    if not path.parent.is_dir() or path.exists():
        raise ValueError('output parent must exist and output must not exist')
    # Protect every worktree in this repository, including linked worktrees.
    text = subprocess.check_output(['git', '-C', str(ROOT), 'worktree', 'list', '--porcelain'], text=True, encoding='utf-8')
    roots = [Path(line[9:]).resolve() for line in text.splitlines() if line.startswith('worktree ')]
    if any(path.is_relative_to(root) for root in roots):
        raise ValueError('output must be outside all public repository worktrees')
    # The explicitly selected private archive exception requires all safeguards.
    if private_archive_output:
        if not path.is_relative_to(PRIVATE_OUTPUT.resolve()):
            raise ValueError('private output must be within the designated private temporary directory')
        git = ['git', '-C', str(path.parent)]
        top = subprocess.run(git + ['rev-parse', '--show-toplevel'], capture_output=True, text=True, encoding='utf-8')
        remotes = subprocess.run(git + ['remote'], capture_output=True, text=True, encoding='utf-8')
        ignored = subprocess.run(git + ['check-ignore', '-q', '--', str(path)], capture_output=True)
        if (top.returncode or Path(top.stdout.strip()).resolve() != PRIVATE_ARCHIVE.resolve()
                or remotes.returncode or remotes.stdout.strip() or ignored.returncode):
            raise ValueError('private archive must be the expected repository, have no remotes, and ignore output')
        return path
    # Reject other repositories by default rather than accidentally storing data in one.
    result = subprocess.run(['git', '-C', str(path.parent), 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    if result.returncode == 0:
        raise ValueError('output must be outside Git repositories')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--private-archive-output', action='store_true', help='allow the designated ignored private archive temporary directory')
    args = parser.parse_args()
    output = validate_output(args.output, args.private_archive_output)
    urls = document_urls()
    started = datetime.now(timezone.utc).isoformat()
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(capture_one, urls.items()))
    finished = datetime.now(timezone.utc).isoformat()
    errors = [row for row in rows if 'error' in row]
    result = {'started_at': started, 'finished_at': finished, 'document_bases': [row for row in rows if 'base' in row], 'errors': errors}
    with output.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=True, indent=2)
        stream.write('\n')
    print(json.dumps({'documents': len(urls), 'captured': len(result['document_bases']), 'errors': len(errors)}))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
