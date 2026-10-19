"""Start the inherited coverage.py session without writing global .pth files.

Used only on the real CLI subprocess's PYTHONPATH. Without an inherited
coverage session this has no effect. All collection remains owned by coverage.py.
"""
import os

if os.environ.get('COVERAGE_PROCESS_CONFIG') or os.environ.get('COVERAGE_PROCESS_START'):
    import coverage

    coverage.process_startup()
