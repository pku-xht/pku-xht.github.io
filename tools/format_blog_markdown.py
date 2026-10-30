"""Format registered public blog sources without changing code or link targets."""
import argparse
import re
from pathlib import Path

import blog_sources as blog


def _ranges(source, markdown):
    offsets = [0]
    for line in source.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    ranges = [(offsets[t.map[0]], offsets[min(t.map[1], len(offsets) - 1)])
              for t in blog._tokens(markdown.parse(source))
              if t.type in {'fence', 'code_block', 'html_block'} and t.map]
    # Inline code, HTML comments/tags, and link destinations are never formulas.
    pattern = re.compile(r'(`+)([\s\S]*?)(?<!`)\1(?!`)|<!--[\s\S]*?(?:-->|$)|<[^>\n]*>|\]\((?:\\.|[^()\n]|\([^()\n]*\))*\)')
    ranges.extend((m.start(), m.end()) for m in pattern.finditer(source))
    return sorted(ranges)


def _math_ranges(source, markdown):
    offsets = [0]
    for line in source.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    protected = [(offsets[t.map[0]], offsets[min(t.map[1], len(offsets) - 1)])
                 for t in blog._tokens(markdown.parse(source))
                 if t.type in {'fence', 'code_block', 'html_block'} and t.map]
    result = []
    i = 0
    while i < len(source):
        covered = next(((a, b) for a, b in protected if a <= i < b), None)
        if covered:
            i = covered[1]
            continue
        if source[i] == '`' and not blog._escaped(source, i):
            opening = re.match(r'`+', source[i:]).group()
            closing = re.search(r'(?<!`)' + re.escape(opening) + r'(?!`)', source[i + len(opening):])
            if closing:
                i += len(opening) + closing.end()
                continue
        if source.startswith('](', i):
            link = re.match(r'\]\((?:\\.|[^()\n]|\([^()\n]*\))*\)', source[i:])
            if link:
                i += link.end()
                continue
        if source[i] == '<':
            tag = re.match(r'<[^>\n]*>', source[i:])
            if tag:
                i += tag.end()
                continue
        if source[i] != '$' or blog._escaped(source, i):
            i += 1
            continue
        delim = '$$' if source.startswith('$$', i) else '$'
        end = i + len(delim)
        while True:
            end = source.find(delim, end)
            if end < 0:
                raise ValueError('Unclosed math delimiter')
            if not blog._escaped(source, end):
                break
            end += len(delim)
        result.append((i, end + len(delim), delim == '$$'))
        i = end + len(delim)
    return result


def _math(text):
    def unescape(match):
        slashes, char = match.groups()
        return slashes[:-1] + char if len(slashes) % 2 else match.group(0)
    text = re.sub(r'(\\+)([*\[\]])', unescape, text)
    def command(match):
        slashes, command = match.groups()
        return slashes[:-1] + {'or': r'\lor', 'and': r'\land', 'Q': r'\mathbb{Q}', 'N': r'\mathbb{N}', 'Z': r'\mathbb{Z}', 'R': r'\mathbb{R}'}[command] if len(slashes) % 2 else match.group(0)
    text = re.sub(r'(\\+)(or|and|Q|N|Z|R)(?![A-Za-z])', command, text)
    text = re.sub(r'(\\+)text\{\^\}', lambda m: m.group(1)[:-1] + r'\text{\textasciicircum}' if len(m.group(1)) % 2 else m.group(0), text)
    return text.replace('–', '-')



def _normalize_quoted_display(source, markdown):
    """Move quote prefixes outside multiline TeX; refuse unsafe line folding."""
    for a, b, display in reversed(_math_ranges(source, markdown)):
        formula = source[a:b]
        if not display or '\n' not in formula:
            continue
        line_start = source.rfind('\n', 0, a) + 1
        prefix = source[line_start:a]
        if not re.fullmatch(r'[ \t]*(?:>[ \t]?)+[ \t]*', prefix):
            continue
        depth = prefix.count('>')
        fragments = formula[2:-2].split('\n')
        for index in range(1, len(fragments)):
            match = re.match(r'^[ \t]*(?:>[ \t]?)+', fragments[index])
            if not match or match.group().count('>') != depth:
                raise ValueError('Inconsistent blockquote depth in display math')
            fragments[index] = fragments[index][match.end():]
        if source[b:source.find('\n', b) if '\n' in source[b:] else len(source)].strip():
            raise ValueError('Display math closing delimiter has trailing text')
        tex = '\n'.join(fragments)
        if any(char == '%' and not blog._escaped(tex, i) for i, char in enumerate(tex)):
            raise ValueError('Cannot fold display math containing a TeX comment')
        if re.search(r'(?<!\\)(?:\\\\)*\\(?:verb\*?|begin\s*\{(?:verbatim\*?|lstlisting)\})', tex):
            raise ValueError('Cannot fold display math containing verbatim TeX')
        replacement = '$$' + ' '.join(fragments) + '$$'
        source = source[:a] + replacement + source[b:]
    return source


def _normalize_lists(source, markdown):
    protected = _ranges(source, markdown)
    lines = source.splitlines(keepends=True)
    offset = 0
    in_list = False
    for i, line in enumerate(lines):
        if any(a <= offset < b for a, b in protected):
            in_list = False
        else:
            match = re.match(r'^( ?)[*+-][ \t]+', line)
            if match:
                if match.group(1) and in_list:
                    lines[i] = ' ' + line
                in_list = in_list or not match.group(1)
            else:
                in_list = False
        offset += len(line)
    return ''.join(lines)


def format_markdown(body):
    if not isinstance(body, str):
        raise TypeError('Markdown body must be text')
    markdown, _, _ = blog._dependencies()
    source = body.replace('\r\n', '\n').replace('\r', '\n')
    source = _normalize_lists(source, markdown)
    source = _normalize_quoted_display(source, markdown)
    ranges = _math_ranges(source, markdown)
    for a, b, _ in reversed(ranges):
        source = source[:a] + _math(source[a:b]) + source[b:]
    ranges = _math_ranges(source, markdown)
    # Preserve offsets and line maps while concealing TeX from Markdown parsing.
    chars = list(source)
    for a, b, _ in ranges:
        for i in range(a, b):
            if chars[i] != '\n':
                chars[i] = 'x'
    masked = ''.join(chars)
    lines = source.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    protected = _ranges(source, markdown)
    add = set()
    for token in markdown.parse(masked):
        if token.type != 'paragraph_open' or not token.map:
            continue
        start, end = token.map
        for n in range(start, min(end - 1, len(lines) - 1)):
            line = lines[n]
            pos = offsets[n + 1] - 1
            if not line.endswith('\n') or not line.strip() or not lines[n + 1].strip():
                continue
            if any(a <= pos < b for a, b in protected):
                continue
            # Never introduce a break inside or at a display formula boundary.
            if any((a <= pos < b) or (display and a < offsets[n + 2] and b > offsets[n]) for a, b, display in ranges):
                continue
            content = line[:-1]
            if content.endswith('  ') or (len(content) - len(content.rstrip('\\'))) % 2:
                continue
            add.add(n)
    result = ''.join((line[:-1] + '\\\n') if i in add else line for i, line in enumerate(lines))
    return result.rstrip('\n') + '\n'


def format_document(text):
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].lstrip('\ufeff').strip() != '---':
        raise ValueError('Missing YAML front matter')
    closing = next((i for i in range(1, len(lines)) if lines[i].strip() == '---'), None)
    if closing is None:
        raise ValueError('Unclosed YAML front matter')
    return ''.join(lines[:closing + 1]) + format_markdown(''.join(lines[closing + 1:]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write', action='store_true', help='write registered public sources')
    args = parser.parse_args()
    # load_blog validates the exact collection and its public repository boundary.
    data = blog.load_blog()
    changed = []
    for record in data['posts'] + data['pages']:
        path = blog.PROJECT_ROOT / record['source_file']
        original = path.read_bytes().decode('utf-8')
        result = format_document(original)
        if result != original:
            changed.append((path, result))
    # Complete all parsing before writing any file, so an error cannot leave a partial batch.
    if args.write:
        for path, result in changed:
            path.write_bytes(result.encode('utf-8'))
    for path, _ in changed:
        print(path.relative_to(blog.PROJECT_ROOT).as_posix())
    print(f'{len(changed)} of {len(data["posts"]) + len(data["pages"])} registered public documents differ')
    return 0 if args.write or not changed else 1


if __name__ == '__main__':
    raise SystemExit(main())
