"""Prepare and directly cross-check this project's coverage.py adapter."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import coverage

ROOT = Path(__file__).resolve().parents[3]
TESTS = ROOT / 'projects/python-cli/tests'
SOURCES = ['projects/python-cli/invoice/__init__.py',
           'projects/python-cli/invoice/__main__.py',
           'projects/python-cli/invoice/totals.py']
ADAPTERS = ['coverage_adapter.py', 'coverage.ini', 'prepare_coverage.py']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def read(path):
    return json.loads(Path(path).read_text())


def artifact(path):
    return {'path': str(path), 'sha256': sha(path)}


def invoke(operation, request, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    inp = directory / f'{operation}-request.json'
    out = directory / f'{operation}-response.json'
    save(inp, request)
    command = [sys.executable, str(TESTS / 'coverage_adapter.py'), operation, str(inp), str(out)]
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    save(directory / f'{operation}-invocation.json', {'command': command, 'exit_code': result.returncode,
                                                     'stdout': result.stdout, 'stderr': result.stderr})
    if result.returncode:
        raise RuntimeError(f'{operation} failed: {result.stderr[-2000:]}')
    return out


def main():
    out = Path(sys.argv[1]).resolve()
    revision = sys.argv[2]
    out.mkdir(parents=True, exist_ok=False)
    sources = {name: sha(ROOT / name) for name in SOURCES}
    adapters = {f'projects/python-cli/tests/{name}': sha(TESTS / name) for name in ADAPTERS}
    inventory = out / 'inventory.json'
    save(inventory, {'schema': 'fixed-revision-inventory-v1', 'revision': revision,
                     'source_paths': sorted(sources), 'changed_files': [], 'changed_lines': {},
                     'change_scope': 'unavailable: requirements benchmark has no base/head diff'})
    prepared = out / 'prepared'
    prepared.mkdir()
    profile = {'schema': 'project-coverage-preparation-v1',
               'entry': [sys.executable, str(TESTS / 'coverage_adapter.py')],
               'adapter_files': adapters,
               'tools': [{'name': 'coverage.py', 'version': coverage.__version__,
                          'role': 'native Python line/branch collection, subprocess merge and statistics'}],
               'spec': {'project_root': str(ROOT), 'revision': revision, 'components': {},
                        'source_hashes': sources, 'inventory_path': str(inventory),
                        'inventory_sha256': sha(inventory), 'registry_path': str(out / 'registry.json')},
               'source_dispositions': {name: {'kind': 'measured',
                                              'reason': 'coverage.py source discovery includes zero-hit Python files'}
                                       for name in sources},
               'preparation_evidence': [], 'artifact_aliases': {}}
    manifest = prepared / 'prepared.json'
    save(manifest, profile)
    sample = out / 'sample.csv'
    sample.write_text('account,amount_cents\nA,1\n')
    noop = out / 'noop.py'
    noop.write_text('pass\n')
    observations = {}
    for label, command in [('zero', [sys.executable, str(noop)]),
                           ('hit', [sys.executable, '-m', 'invoice', '--input', str(sample)])]:
        folder = out / label
        folder.mkdir()
        session = {'cwd': str(ROOT), 'output': str(folder), 'scene_id': 'preparation-'+label,
                   'command': command, 'env': {'PYTHONPATH': 'projects/python-cli'},
                   'files': list(adapters), 'prepared': str(prepared),
                   'prepared_sha256': sha(manifest), 'revision': revision}
        run_request = folder / 'run-request.json'
        save(run_request, session)
        run_response = invoke('run', session, folder)
        receipt = folder / 'receipt.json'
        save(receipt, {'command': command, 'cwd': str(ROOT), 'exit_code': read(run_response)['exit_code']})
        report = invoke('finish', {'request': str(run_request), 'receipt': str(receipt),
                                   'output': str(folder)}, folder)
        raw = folder / 'native-data'
        direct_copy = folder / 'native-direct-copy'
        shutil.copyfile(raw, direct_copy)
        direct = coverage.Coverage(config_file=str(TESTS / 'coverage.ini'), data_file=str(direct_copy))
        direct.load()
        direct.get_data().add_arcs({})  # An empty source discovery DB has no stored mode.
        direct_path = folder / 'direct-coverage.json'
        direct.json_report(outfile=str(direct_path))
        direct_totals = read(direct_path)['totals']
        native_totals = read(folder / 'native-report.json')['totals']
        if native_totals != direct_totals:
            raise ValueError(f'{label} adapter totals differ from direct coverage.py JSON')
        observations[label] = {'raw': raw, 'report': report, 'direct': direct_path,
                               'direct_copy': direct_copy,
                               'native_totals': native_totals}
    if observations['zero']['native_totals']['covered_lines'] != 0 or observations['hit']['native_totals']['covered_lines'] <= 0:
        raise ValueError('zero-hit or nonzero-hit probe failed')
    comparison = out / 'probe-comparison.json'
    save(comparison, {'status': 'matched', 'zero': observations['zero']['native_totals'],
                      'hit': observations['hit']['native_totals'],
                      'comparison': 'Complete native coverage.py JSON totals agree for each same SQLite database.'})
    profile['probe_comparison'] = artifact(comparison)
    profile['probe_databases'] = {label: artifact(value['raw']) for label, value in observations.items()}
    for name in [*sources, *adapters]:
        frozen = out / 'frozen' / name
        frozen.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, frozen)
        profile['artifact_aliases'][str(ROOT / name)] = str(frozen)
    evidence = [inventory, sample, noop, comparison]
    for label, value in observations.items():
        folder = out / label
        evidence.extend([value['raw'], value['report'], value['direct'], value['direct_copy'],
                         folder / 'native-report.json'])
        evidence.extend(folder.glob('*-request.json'))
        evidence.extend(folder.glob('*-response.json'))
        evidence.extend(folder.glob('*-invocation.json'))
    profile['preparation_evidence'] = [artifact(path) for path in sorted(set(evidence))]
    save(manifest, profile)
    invoke('verify-preparation', {'prepared': str(manifest)}, out / 'final-check')
    for label, value in observations.items():
        invoke('verify-report', {'report': str(value['report'])}, out / ('verify-'+label))
        invoke('summarize', {'reports': [str(value['report'])], 'inventory': read(inventory)},
               out / ('summary-'+label))
    config = {'policy': 'required', 'protocol': 'project-coverage-v1', 'prepared': str(prepared),
              'prepared_sha256': sha(manifest), 'inventory_path': str(inventory)}
    save(out / 'coverage-config.json', config)
    print(json.dumps({'status': 'verified', 'config': str(out / 'coverage-config.json')}))


if __name__ == '__main__':
    main()
