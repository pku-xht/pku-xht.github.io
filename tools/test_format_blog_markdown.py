import unittest
from format_blog_markdown import format_document, format_markdown


class FormatterTests(unittest.TestCase):
    def test_math_and_code(self):
        source = (r'$\or \and \Q \* \[ \] \text{^} a–b$' + '\n\n'
                  + r'`$\or \* \Q$` and [link](https://example.org/$\Q)' + '\n\n'
                  + '```tex\n' + r'$\or \and \Q \* \[ \] \text{^} –$' + '\n```\n')
        expected = (r'$\lor \land \mathbb{Q} * [ ] \text{\textasciicircum} a-b$' + '\n\n'
                    + r'`$\or \* \Q$` and [link](https://example.org/$\Q)' + '\n\n'
                    + '```tex\n' + r'$\or \and \Q \* \[ \] \text{^} –$' + '\n```\n')
        self.assertEqual(format_markdown(source), expected)

    def test_parity_and_multiline(self):
        source = '$' + r'\\* \\\* \\or \or' + '$\n\n' + 'first\nsecond\n\n`one\ntwo`\n'
        expected = '$' + r'\\* \\* \\or \lor' + '$\n\nfirst\\\nsecond\n\n`one\ntwo`\n'
        self.assertEqual(format_markdown(source), expected)

    def test_container_display_and_lists(self):
        source = '- parent\n - child\n - child 2\n\n> first\n> second\n\n$$\na+\nb\n$$\n\nafter\nline\n'
        expected = '- parent\n  - child\n  - child 2\n\n> first\\\n> second\n\n$$\na+\nb\n$$\n\nafter\\\nline\n'
        result = format_markdown(source)
        self.assertEqual(result, expected)
        self.assertEqual(format_markdown(result), result)

    def test_table_hardbreak_yaml(self):
        body = '| a | b |\n|---|---|\n| [x](https://e.test/a) | y |\n\nfirst  \nsecond\\\nthird\n'
        yaml = '---\r\ntitle: Example\r\n---\r\n'
        self.assertEqual(format_document(yaml + body), yaml + body)

    def test_nested_container_and_display_math(self):
        source = '> intro\n> $$\n> a +\n> b\n> $$\n> ending\n\n- parent\n  - child\n    continued\n'
        expected = '> intro\n> $$ a + b $$\n> ending\n\n- parent\n  - child\\\n    continued\n'
        result = format_markdown(source)
        self.assertEqual(result, expected)
        self.assertEqual(format_markdown(result), result)

    def test_quoted_formula_preserves_tex_and_guard(self):
        source = '> > $$\n> > \\begin{cases}\n> > a & b \\\\\n> > c & d\n> > \\end{cases}\n> > $$\n'
        result = format_markdown(source)
        self.assertEqual(result, '> > $$ \\begin{cases} a & b \\\\ c & d \\end{cases} $$\n')
        self.assertEqual(format_markdown(result), result)
        from blog_sources import _dependencies, _mask_math
        _, pieces = _mask_math(result, _dependencies()[0])
        math = next(original for original, literal in pieces.values() if not literal)
        self.assertNotIn('>', math)
        for tex in (r'a % comment', r'\verb|a b|', r'\begin{verbatim} a'):
            with self.subTest(tex=tex), self.assertRaises(ValueError):
                format_markdown('> $$\n> ' + tex + '\n> $$\n')
        self.assertEqual(format_markdown('> $$\n> a \\% b\n> $$\n'), '> $$ a \\% b $$\n')
        with self.assertRaises(ValueError):
            format_markdown('> > $$\n> a\n> > $$\n')

    def test_number_sets_parity_and_idempotence(self):
        source = '$' + r'\N \Z \R \\N \\\Z \Name' + '$\n'
        expected = '$' + r'\mathbb{N} \mathbb{Z} \mathbb{R} \\N \\\mathbb{Z} \Name' + '$\n'
        result = format_markdown(source)
        self.assertEqual(result, expected)
        self.assertEqual(format_markdown(result), result)

    def test_indented_code_and_inline_math(self):
        source = '    $\\or$\n    a\n\ntext $x$\nnext\n'
        self.assertEqual(format_markdown(source), '    $\\or$\n    a\n\ntext $x$\\\nnext\n')


if __name__ == '__main__':
    unittest.main()
