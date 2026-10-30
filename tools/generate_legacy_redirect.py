"""Generate the legacy redirect allowlist from registered public sources."""
import argparse
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit

from blog_sources import load_blog

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'services/legacy-redirect/routes.json'
HOSTS = {'www.xht37.com', 'xht37.com'}


def generate():
    blog = load_blog()
    snapshot = json.loads((ROOT / 'migration/sources/public-2026-10-23.json').read_text(encoding='utf-8'))
    paths, queries = {}, {}

    def add(path, target):
        path = unquote(path, errors='strict')
        if not path.startswith('/') or any(c in path for c in '?#\\%') or any(ord(c) < 32 or ord(c) == 127 for c in path):
            raise ValueError(f'Unsafe path {path!r}')
        if not target.startswith('/blog/') or any(c in target for c in '?#\\%') or any(ord(c) < 32 or ord(c) == 127 for c in target) or '..' in target.split('/'):
            raise ValueError(f'Unsafe target {target!r}')
        # The Worker applies the same trailing-slash normalization.
        key = path.rstrip('/') or '/'
        if key == '/' or key in paths and paths[key] != target:
            raise ValueError(f'Conflicting path {key!r}')
        paths[key] = target

    for group, kind in [('posts', 'post'), ('pages', 'page')]:
        for doc in blog[group]:
            url = urlsplit(doc['link'])
            if url.hostname not in HOSTS or url.query or url.fragment:
                raise ValueError('Unexpected document URL')
            target = f'/blog/{group}/{doc["id"]}/'
            add(url.path, target)
            queries[f'{"p" if kind == "post" else "page_id"}={doc["id"]}'] = target

    for group, prefix in [('categories', 'category'), ('tags', 'tag')]:
        old = {term['id']: term for term in snapshot[group]}
        for term in blog[group]:
            item = old.get(term['id'])
            if not item or item['name'] != term['name'] or not item.get('slug'):
                raise ValueError(f'Missing original slug for {group} {term["id"]}')
            add(f'/{prefix}/{item["slug"]}/', f'/blog/{group}/{term["id"]}/')

    for resource in blog['resources']:
        url = urlsplit(resource['original_url'])
        if url.hostname in HOSTS:
            if url.query or url.fragment:
                raise ValueError('Resource query needs explicit handling')
            add(url.path, resource['path'])
    return json.dumps({'paths': dict(sorted(paths.items())), 'queries': dict(sorted(queries.items()))}, ensure_ascii=False, indent=2) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = generate()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding='utf-8') != result:
            raise SystemExit('Legacy redirect routes are stale; regenerate them.')
        print('Legacy redirect routes are current.')
    else:
        OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT.write_bytes(result.encode('utf-8'))
        print(f'Wrote {OUTPUT.relative_to(ROOT)}')
