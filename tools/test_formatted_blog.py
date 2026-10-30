"""Synthetic tests for independent source equivalence checks."""
import unittest

from check_formatted_blog import compare_bodies


class SemanticComparisonTest(unittest.TestCase):
    def test_recorded_equivalences(self):
        compare_bodies('first\nsecond $\\or \\Q \\[*\\]$\n- a\n - b\n',
                       'first\\\nsecond $\\lor \\mathbb{Q} [*]$\n- a\n  - b\n')
        compare_bodies('$\\N, \\Z, \\R$\n', '$\\mathbb{N}, \\mathbb{Z}, \\mathbb{R}$\n')

    def test_reject_content_structure_and_code_changes(self):
        for old, new in [('hello world\n', 'hello other\n'),
                         ('[x](https://a)\n', '[x](https://b)\n'),
                         ('# heading\n', '## heading\n'),
                         ('```\nx\n```\n', '```\nx\\\n```\n'),
                         ('$x$\n', '$y$\n')]:
            with self.subTest(old=old), self.assertRaises(ValueError):
                compare_bodies(old, new)

    def test_quoted_display_and_real_greater_than(self):
        old = '> $$\n> x > y \\\\ z\n> $$\n'
        compare_bodies(old, '> $$ x > y \\\\ z $$\n')
        with self.assertRaises(ValueError):
            compare_bodies(old, '> $$ x y \\\\ z $$\n')
        with self.assertRaises(ValueError):
            compare_bodies('$$\nx > y\n$$\n', '$$ x y $$\n')

    def test_quote_code_and_comments_are_not_folded(self):
        with self.assertRaises(ValueError):
            compare_bodies('> ```\n> $$\n> x\n> $$\n> ```\n',
                           '> ```\n> $$ x $$\n> ```\n')
        with self.assertRaises(ValueError):
            compare_bodies('> $$\n> x % comment\n> y\n> $$\n',
                           '> $$ x % comment y $$\n')


if __name__ == '__main__':
    unittest.main()
