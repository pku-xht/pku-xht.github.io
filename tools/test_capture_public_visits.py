import io
import tempfile
from types import SimpleNamespace
import unittest
from pathlib import Path
from unittest.mock import patch

import capture_public_visits as capture


class FakeResponse:
    status = 200

    def __init__(self, body):
        from email.message import Message
        self.headers = Message()
        self.headers['Content-Type'] = 'text/html; charset=utf-8'
        self.body = io.BytesIO(body)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, size):
        return self.body.read(size)


class TestCapture(unittest.TestCase):
    def test_only_one_plain_paragraph_is_accepted(self):
        self.assertEqual(capture.parse_visits('<p>Visits: 123</p>'), 123)
        for text in ('<p>text</p>', '<p>Visits: 1</p><p>Visits: 2</p>',
                     '<p>Visits: <b>3</b></p>', '<p>Visits: -1</p>',
                     '<p>Visits: 9007199254740992</p>'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                capture.parse_visits(text)

    def test_fetch_success_and_failures_do_not_invent_zero(self):
        class Opener:
            def __init__(self, body):
                self.body = body

            def open(self, request, timeout):
                self.asserted_timeout = timeout
                return FakeResponse(self.body)

        for body, expected in [(b'<p>Visits: 7</p>', {'document': '46', 'base': 7}),
                               (b'<p>no marker</p>', {'document': '46', 'error': 'ValueError'})]:
            with patch.object(capture, 'build_opener', return_value=Opener(body)):
                self.assertEqual(capture.capture_one(('46', 'https://www.xht37.com/example/')), expected)

    def test_registry_and_output_guard(self):
        self.assertEqual(len(capture.document_urls()), 212)
        with self.assertRaises(ValueError):
            capture.validate_output(capture.ROOT / 'fictional-output.json')
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(capture.validate_output(Path(directory) / 'out.json'), (Path(directory) / 'out.json').resolve())

    def test_explicit_private_archive_requires_no_remotes_and_ignored_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output_dir = root / 'tmp' / 'visits-cutover-2026-10-31'
            output_dir.mkdir(parents=True)
            output = output_dir / 'out.json'
            state = {'ignored': False, 'remote': False}
            def fake_git(args, **kwargs):
                if 'rev-parse' in args:
                    return SimpleNamespace(returncode=0, stdout=str(root))
                if 'remote' in args:
                    return SimpleNamespace(returncode=0, stdout='origin\n' if state['remote'] else '')
                return SimpleNamespace(returncode=0 if state['ignored'] else 1, stdout='')
            with patch.object(capture, 'PRIVATE_ARCHIVE', root), patch.object(capture, 'PRIVATE_OUTPUT', output_dir), patch.object(capture.subprocess, 'run', side_effect=fake_git), patch.object(capture.subprocess, 'check_output', return_value=''):
                with self.assertRaises(ValueError):
                    capture.validate_output(output, True)
                state['ignored'] = True
                self.assertEqual(capture.validate_output(output, True), output)
                with self.assertRaises(ValueError):
                    capture.validate_output(root / 'outside.json', True)
                state['remote'] = True
                with self.assertRaises(ValueError):
                    capture.validate_output(output, True)


if __name__ == '__main__':
    unittest.main()
