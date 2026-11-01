import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from prepare_visit_history import MAX_SAFE, prepare, read_export


class PrepareHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'export.csv'
        self.baseline = self.root / 'baseline.json'
        self.baseline.write_text(json.dumps({'site_base': 12, 'captured_at': '2026-10-30T17:00:00Z', 'document_bases': ['not exported']}), encoding='utf-8')
        self.write_rows('3,2026-11-01 12:00:00,2026-11-01,9\n2,2026-10-31 12:00:00,2026-10-31,10\n1,2026-10-29 12:00:00,2026-10-29,7\n')

    def write_rows(self, rows, header='ID,last_visit,last_counter,visit\n', path=None):
        (path or self.source).write_text(header + rows, encoding='utf-8')

    def test_unordered_gaps_cutover_and_total(self):
        result, summary = prepare(self.source, self.baseline, 26)
        self.assertEqual(result['items'], [
            {'date': '2026-10-29', 'visits': 7, 'partial': True},
            {'date': '2026-10-30', 'visits': None, 'partial': False},
            {'date': '2026-10-31', 'visits': 5, 'partial': True},
        ])
        self.assertEqual(summary['normalized_total'], 12)
        self.assertEqual(summary['missing_days'], 1)
        self.assertEqual(result['version'], 1)
        self.assertNotIn('document_bases', result)

    def test_duplicate_and_header_rejected(self):
        self.write_rows('1,2026-10-31 12:00:00,2026-10-31,1\n2,2026-10-31 13:00:00,2026-10-31,1\n')
        with self.assertRaises(ValueError):
            read_export(self.source, 2)
        self.write_rows('', header='ID,visit,last_counter,last_visit\n')
        with self.assertRaises(ValueError):
            read_export(self.source, 0)

    def test_legacy_zero_last_visit_uses_validated_daily_bucket_without_losing_count(self):
        before, _ = prepare(self.source, self.baseline, 26)
        self.source.write_text(self.source.read_text(encoding='utf-8').replace('2026-10-29 12:00:00', '0000-00-00 00:00:00'), encoding='utf-8')
        after, _ = prepare(self.source, self.baseline, 26)
        self.assertEqual(before, after)

    def test_invalid_values_and_dates(self):
        for row in [
            f'1,2026-10-31 12:00:00,2026-10-31,{MAX_SAFE + 1}\n',
            '1,2026-10-30 12:00:00,2026-10-31,1\n',
            '1,2026-10-31,2026-10-31,1\n',
            '0,2026-10-31 12:00:00,2026-10-31,1\n',
            '1,2026-10-31 12:00:00,2026-10-31,=1+1\n',
        ]:
            with self.subTest(row=row):
                self.write_rows(row)
                with self.assertRaises(ValueError):
                    read_export(self.source, 1)

    def test_total_and_cutover_rejected(self):
        with self.assertRaises(ValueError):
            prepare(self.source, self.baseline, 25)
        for baseline in [
            {'site_base': 12, 'captured_at': '2026-10-28T00:00:00Z'},
            {'site_base': 18, 'captured_at': '2026-10-30T17:00:00Z'},
            {'site_base': 6, 'captured_at': '2026-10-30T17:00:00Z'},
            {'site_base': 12, 'captured_at': '2026-10-31T00:00:00'},
        ]:
            self.baseline.write_text(json.dumps(baseline), encoding='utf-8')
            with self.assertRaises(ValueError):
                prepare(self.source, self.baseline, 26)

    def test_comparison_requires_exact_old_dates(self):
        other = self.root / 'second.csv'
        self.write_rows('1,2026-10-29 12:00:00,2026-10-29,8\n2,2026-10-31 12:00:00,2026-10-31,9\n3,2026-11-01 12:00:00,2026-11-01,9\n', path=other)
        with self.assertRaises(ValueError):
            prepare(self.source, self.baseline, 26, other)
        self.write_rows('3,2026-11-02 12:00:00,2026-11-02,19\n1,2026-10-29 12:00:00,2026-10-29,7\n2,2026-10-31 12:00:00,2026-10-31,10\n', path=other)
        prepare(self.source, self.baseline, 26, other)

    def test_cli_writes_once_and_reports_hash(self):
        output = self.root / 'normalized.json'
        command = [sys.executable, str(Path(__file__).with_name('prepare_visit_history.py')),
                   '--input', str(self.source), '--baseline', str(self.baseline),
                   '--timezone', 'Asia/Shanghai', '--expected-export-total', '26',
                   '--output', str(output)]
        run = subprocess.run(command, capture_output=True, text=True, check=True)
        summary = json.loads(run.stdout)
        self.assertEqual(summary['network_requests'], 0)
        self.assertEqual(len(summary['sha256']), 64)
        self.assertEqual(json.loads(output.read_text(encoding='utf-8'))['site_base'], 12)
        self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
