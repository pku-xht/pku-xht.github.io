"""Audit formatted public sources against the pre-format Git baseline.

This does not call the formatter for equivalence: it permits only listed TeX
synonyms, the legacy one-space list indentation and explicit line breaks.
"""
import argparse
import re
import subprocess

import adopt_native_blog as adoption
import blog_sources as blog

BASELINE = '9b13223'


def canonical_math(value):
    # Apply only recorded equivalences; preserve all other formula characters.
    value = re.sub(r'(\\+)([*\[\]])', lambda m: m.group(1)[:-1] + m.group(2) if len(m.group(1)) % 2 else m.group(0), value)
    value = re.sub(r'(?<!\\)\\(?:or|lor)(?![A-Za-z])', r'\\lor', value)
    value = re.sub(r'(?<!\\)\\(?:and|land)(?![A-Za-z])', r'\\land', value)
    value = re.sub(r'(?<!\\)\\Q(?![A-Za-z])', lambda m: r'\mathbb{Q}', value)
    value = re.sub(r'(\\+)([NZR])(?![A-Za-z])',
                   lambda m: m.group(1)[:-1] + r'\mathbb{' + m.group(2) + '}' if len(m.group(1)) % 2 else m.group(0), value)
    value = value.replace(r'\text{^}', r'\text{\textasciicircum}')
    return value.replace('–', '-')


def concealed(source, markdown):
    masked, formulas = blog._mask_math(source, markdown)
    canonical = []
    for index, (marker, (value, escaped)) in enumerate(formulas.items()):
        canonical.append((escaped, value if escaped else canonical_math(value)))
        # Keep multiline formula lines nonempty, so masking does not create
        # artificial paragraph boundaries in the independent block parse.
        masked = masked.replace(marker, f'MATHAUDIT{index}END' + '\nx' * value.count('\n'))
    return masked, canonical


def block_lines(source, markdown):
    protected = set()
    for token in blog._tokens(markdown.parse(source)):
        if token.type in {'fence', 'code_block', 'html_block'} and token.map:
            protected.update(range(*token.map))
    return protected


def paragraph_break_lines(source, markdown):
    lines = set()
    for token in markdown.parse(source):
        if token.type == 'paragraph_open' and token.map:
            lines.update(range(token.map[0], token.map[1] - 1))
    return lines


def normalize_quoted_display(source, markdown):
    """Independently normalize only multiline TeX in real quote containers."""
    lines = source.splitlines(keepends=True)
    protected = block_lines(source, markdown)
    quote_lines = set()
    for token in markdown.parse(source):
        if token.type == 'blockquote_open' and token.map:
            quote_lines.update(range(*token.map))
    result = []
    i = 0
    opening = re.compile(r'^([ \t]*(?:>[ \t]?)+[ \t]*)\$\$(.*)$')
    quote = re.compile(r'^[ \t]*(?:>[ \t]?)+')
    while i < len(lines):
        line = lines[i].rstrip('\n')
        match = opening.match(line) if i in quote_lines and i not in protected else None
        if not match or '$$' in match.group(2):
            result.append(lines[i])
            i += 1
            continue
        depth = match.group(1).count('>')
        pieces = [match.group(2)]
        end = i + 1
        while end < len(lines) and end in quote_lines and end not in protected:
            part = lines[end].rstrip('\n')
            prefix = quote.match(part)
            if not prefix or prefix.group().count('>') != depth:
                break
            part = part[prefix.end():]
            if '$$' in part:
                if not part.endswith('$$') or part.count('$$') != 1:
                    break
                pieces.append(part[:-2])
                tex = '\n'.join(pieces)
                if (re.search(r'(?<!\\)(?:\\\\)*%', tex) or
                        re.search(r'(?<!\\)(?:\\\\)*\\(?:verb\*?|begin\s*\{(?:verbatim\*?|lstlisting)\})', tex)):
                    break
                result.append(match.group(1) + '$$' + ' '.join(pieces) + '$$' + ('\n' if lines[end].endswith('\n') else ''))
                i = end + 1
                break
            pieces.append(part)
            end += 1
        else:
            end = -1
        if i != end + 1:
            result.append(lines[i])
            i += 1
    return ''.join(result)


def compare_bodies(before, after):
    markdown, _, _ = blog._dependencies()
    before = normalize_quoted_display(before, markdown)
    after = normalize_quoted_display(after, markdown)
    old, old_math = concealed(before, markdown)
    new, new_math = concealed(after, markdown)
    if old_math != new_math:
        raise ValueError('formula content or order changed')
    old_lines, new_lines = old.splitlines(), new.splitlines()
    # Formatting may normalize only final empty lines.
    while old_lines and not old_lines[-1]: old_lines.pop()
    while new_lines and not new_lines[-1]: new_lines.pop()
    if len(old_lines) != len(new_lines):
        raise ValueError('line count changed')
    protected = block_lines(before, markdown) | block_lines(after, markdown)
    paragraphs = paragraph_break_lines(old, markdown)
    list_active = False
    for i, (a, b) in enumerate(zip(old_lines, new_lines)):
        original_a = a
        marker = re.match(r'^( ?)[*+-][ \t]+', a)
        if marker:
            if marker.group(1) and list_active:
                a = ' ' + a
            list_active = list_active or not marker.group(1)
        else:
            list_active = False
        if (a != b and i in paragraphs and b == a + '\\' and
                not a.endswith('  ') and (len(a) - len(a.rstrip('\\'))) % 2 == 0):
            a += '\\'
        if a != b or (i in protected and original_a != b):
            raise ValueError(f'unapproved text, code or structure change on line {i + 1}')
    if not after.endswith('\n'):
        raise ValueError('missing final newline')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', default=BASELINE, help='Git revision before formatting')
    args = parser.parse_args()
    records = adoption.public_documents()
    from format_blog_markdown import format_document
    for identity, (_, member) in records.items():
        path = 'content/blog/' + member
        before = subprocess.check_output(['git', 'show', f'{args.baseline}:{path}'], cwd=adoption.ROOT).decode('utf-8')
        after = (adoption.ROOT / path).read_bytes().decode('utf-8')
        prefix = adoption.header(member, identity, records[identity][0])
        if not before.startswith(prefix) or not after.startswith(prefix):
            raise ValueError(f'{identity}: metadata differs from baseline')
        if format_document(after) != after:
            raise ValueError(f'{identity}: formatter is not idempotent')
        try:
            compare_bodies(before[len(prefix):], after[len(prefix):])
        except ValueError as error:
            raise ValueError(f'{identity}: {error}') from error
    print(f'Independently compared {len(records)} formatted documents with {args.baseline}; metadata and idempotence verified')


if __name__ == '__main__':
    main()
