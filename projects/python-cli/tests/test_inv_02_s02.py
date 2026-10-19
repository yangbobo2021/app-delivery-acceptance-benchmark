"""INV-02-S02: exact account totals at and above the signed 32-bit limit.

Coverage checklist: one valid six-row CSV distinguishes wrapping, clamping,
rejecting a large account total, and serializing totals as strings or floats.
The expected totals are the scenario's constants, independent of product code.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest


class Int32AccountTotals(unittest.TestCase):
    def test_exact_totals_across_signed_int32_limit(self):
        evidence = Path(os.environ['ACCEPTANCE_CASE_ROOT']) / 'inv-02-s02'
        evidence.mkdir(parents=True, exist_ok=False)
        input_dir = evidence / 'input'
        input_dir.mkdir()
        fixture = Path(__file__).parent / 'fixtures' / 'inv_02_s02_int32.csv'
        source = input_dir / 'amounts.csv'
        shutil.copyfile(fixture, source)
        input_before = source.read_bytes()
        entries_before = sorted(path.name for path in input_dir.iterdir())
        command = [sys.executable, '-m', 'invoice', '--input', str(source.resolve())]
        try:
            result = subprocess.run(command, capture_output=True, timeout=10)
        except subprocess.TimeoutExpired as error:
            (evidence / 'stdout.bin').write_bytes(error.stdout or b'')
            (evidence / 'stderr.bin').write_bytes(error.stderr or b'')
            (evidence / 'execution.json').write_text(json.dumps({
                'command': command, 'timed_out': True,
            }, indent=2) + '\n', encoding='utf-8')
            self.fail('CLI exceeded the 10 second timeout; raw output preserved')
        (evidence / 'stdout.bin').write_bytes(result.stdout)
        (evidence / 'stderr.bin').write_bytes(result.stderr)
        input_after = source.read_bytes() if source.is_file() else None
        entries_after = sorted(path.name for path in input_dir.iterdir())
        (evidence / 'input-observation.json').write_text(json.dumps({
            'before': input_before.decode('utf-8'),
            'after': input_after.decode('utf-8', errors='replace')
                     if input_after is not None else None,
            'entries_before': entries_before, 'entries_after': entries_after,
            'bytes_unchanged': input_before == input_after,
        }, indent=2) + '\n', encoding='utf-8')
        (evidence / 'execution.json').write_text(json.dumps({
            'command': command, 'returncode': result.returncode,
            'expected': {'totals': {'AtLimit': 2147483647,
                                    'AboveLimit': 2147483648}, 'row_count': 6},
            'stdout': result.stdout.decode('utf-8', errors='replace'),
            'stderr': result.stderr.decode('utf-8', errors='replace'),
        }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

        with self.subTest(criterion='success exit status'):
            self.assertEqual(result.returncode, 0)
        with self.subTest(criterion='empty stderr'):
            self.assertEqual(result.stderr, b'')
        with self.subTest(criterion='input contents unchanged'):
            self.assertEqual(input_after, input_before)
        with self.subTest(criterion='input directory entries unchanged'):
            self.assertEqual(entries_after, entries_before)
        payload = json.loads(result.stdout)
        self.assertIs(type(payload), dict)
        with self.subTest(criterion='JSON fields'):
            self.assertEqual(set(payload), {'totals', 'row_count'})
        with self.subTest(criterion='all six data rows counted'):
            self.assertIs(type(payload['row_count']), int)
            self.assertEqual(payload['row_count'], 6)
        totals = payload['totals']
        self.assertIs(type(totals), dict)
        with self.subTest(criterion='both accounts present'):
            self.assertEqual(set(totals), {'AtLimit', 'AboveLimit'})
        for account, expected in [('AtLimit', 2147483647),
                                  ('AboveLimit', 2147483648)]:
            with self.subTest(account=account, expected=expected):
                self.assertIs(type(totals[account]), int)
                self.assertEqual(totals[account], expected)


if __name__ == '__main__':
    unittest.main(verbosity=2)
