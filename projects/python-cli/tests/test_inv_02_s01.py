"""INV-02-S01: complete per-account aggregation of interleaved CSV rows.

Coverage checklist (one real CLI invocation):
* Alpha1's three separated rows total 400, detecting overwrite/adjacent-only sums.
* Beta2's two separated rows total 79, detecting cross-account accumulation.
* Solo3's single middle row totals 18, detecting dropped singleton accounts.
* Exact account set, integer values, six data rows, exit 0 and empty stderr.
Expected values come from the scenario, without importing product calculations.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest


class InterleavedAccountTotals(unittest.TestCase):
    def test_complete_interleaved_totals(self):
        evidence = Path(os.environ['ACCEPTANCE_CASE_ROOT']) / 'inv-02-s01'
        evidence.mkdir(parents=True, exist_ok=False)
        input_dir = evidence / 'input'
        input_dir.mkdir()
        fixture = Path(__file__).parent / 'fixtures' / 'inv_02_s01_interleaved.csv'
        source = input_dir / 'amounts.csv'
        shutil.copyfile(fixture, source)
        before = source.read_bytes()
        entries_before = sorted(p.name for p in input_dir.iterdir())
        expected = {'totals': {'Alpha1': 400, 'Beta2': 79, 'Solo3': 18},
                    'row_count': 6}
        command = [sys.executable, '-m', 'invoice', '--input', str(source.resolve())]
        # The restricted host cannot write coverage.py's automatic .pth file
        # into site-packages. Load its official startup API from a test fixture.
        child_env = os.environ.copy()
        startup = str(Path(__file__).parent.resolve() / 'coverage_subprocess')
        child_env['PYTHONPATH'] = os.pathsep.join(
            [startup, child_env.get('PYTHONPATH', '')])
        try:
            result = subprocess.run(command, capture_output=True, timeout=10,
                                    env=child_env)
        except subprocess.TimeoutExpired as error:
            (evidence / 'stdout.bin').write_bytes(error.stdout or b'')
            (evidence / 'stderr.bin').write_bytes(error.stderr or b'')
            (evidence / 'execution.json').write_text(json.dumps({
                'command': command, 'timed_out': True,
            }, indent=2) + '\n', encoding='utf-8')
            self.fail('CLI exceeded 10 seconds; raw output preserved')
        (evidence / 'stdout.bin').write_bytes(result.stdout)
        (evidence / 'stderr.bin').write_bytes(result.stderr)
        after = source.read_bytes() if source.is_file() else None
        entries_after = sorted(p.name for p in input_dir.iterdir())
        (evidence / 'execution.json').write_text(json.dumps({
            'command': command, 'returncode': result.returncode,
            'expected': expected,
            'stdout': result.stdout.decode('utf-8', errors='replace'),
            'stderr': result.stderr.decode('utf-8', errors='replace'),
            'input_before': before.decode('utf-8'),
            'input_after': after.decode('utf-8', errors='replace')
                           if after is not None else None,
            'entries_before': entries_before, 'entries_after': entries_after,
        }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

        with self.subTest(criterion='success exit code'):
            self.assertEqual(result.returncode, 0)
        with self.subTest(criterion='empty stderr'):
            self.assertEqual(result.stderr, b'')
        with self.subTest(criterion='input bytes unchanged'):
            self.assertEqual(after, before)
        with self.subTest(criterion='input directory entries unchanged'):
            self.assertEqual(entries_after, entries_before)
        payload = json.loads(result.stdout)
        self.assertIs(type(payload), dict)
        with self.subTest(criterion='exact output fields'):
            self.assertEqual(set(payload), {'totals', 'row_count'})
        with self.subTest(criterion='all six rows counted'):
            self.assertIs(type(payload['row_count']), int)
            self.assertEqual(payload['row_count'], 6)
        totals = payload['totals']
        self.assertIs(type(totals), dict)
        with self.subTest(criterion='exact account set'):
            self.assertEqual(set(totals), set(expected['totals']))
        for account, amount in expected['totals'].items():
            with self.subTest(account=account, expected=amount):
                self.assertIn(account, totals)
                self.assertIs(type(totals[account]), int)
                self.assertEqual(totals[account], amount)


if __name__ == '__main__':
    unittest.main(verbosity=2)
