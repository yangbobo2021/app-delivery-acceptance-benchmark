"""Prepare this Go service's native coverage adapter for the current checkout.

The probes establish the collector baseline and compare adapter output against
`go tool cover` on the very same native profiles. They are not business cases.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / 'projects/go-api'
TESTS = APP / 'tests'
SOURCE = 'projects/go-api/main.go'
ADAPTERS = ['coverage_adapter.py', 'run_case.py', 'http_fixture_test.go', 'coverage_probe_test.go', 'prepare_coverage.py']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def invoke(op, request, folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    request_path = folder / f'{op}-request.json'
    response_path = folder / f'{op}-response.json'
    save(request_path, request)
    command = [sys.executable, str(TESTS / 'coverage_adapter.py'), op, str(request_path), str(response_path)]
    process = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    save(folder / f'{op}-invocation.json', {'command': command, 'exit_code': process.returncode,
                                          'stdout': process.stdout, 'stderr': process.stderr})
    if process.returncode:
        raise RuntimeError(f'{op} failed: {process.stderr[-2000:]}')
    return response_path


def item(path):
    return {'path': str(path), 'sha256': sha(path)}


def main():
    out = Path(sys.argv[1]).resolve()
    revision = sys.argv[2]
    out.mkdir(parents=True, exist_ok=False)
    sources = {SOURCE: sha(ROOT / SOURCE)}
    adapters = {f'projects/go-api/tests/{name}': sha(TESTS / name) for name in ADAPTERS}
    inventory_path = out / 'inventory.json'
    save(inventory_path, {'schema': 'fixed-revision-inventory-v1', 'revision': revision,
                          'source_paths': [SOURCE], 'changed_files': [], 'changed_lines': {},
                          'change_scope': 'unavailable: requirements benchmark has no base/head diff'})
    go_version = subprocess.check_output(['go', 'version'], text=True).strip()
    tools = [{'name': 'Go native coverage', 'version': go_version, 'role': 'collector and statement statistics'}]
    prepared = out / 'prepared'
    prepared.mkdir()
    profile = {'schema': 'project-coverage-preparation-v1',
               'entry': [sys.executable, str(TESTS / 'coverage_adapter.py')],
               'adapter_files': adapters, 'tools': tools,
               'spec': {'project_root': str(ROOT), 'revision': revision, 'components': {},
                        'source_hashes': sources, 'inventory_path': str(inventory_path),
                        'inventory_sha256': sha(inventory_path), 'registry_path': str(out / 'registry.json')},
               'source_dispositions': {SOURCE: {'kind': 'measured', 'reason': 'go test native coverprofile instruments main.go'}},
               'preparation_evidence': [], 'artifact_aliases': {}}
    manifest = prepared / 'prepared.json'
    save(manifest, profile)

    observations = {}
    for label, selector in [('zero', '^$'), ('hit', 'TestCoverageProbe')]:
        folder = out / label
        folder.mkdir()
        session = {'cwd': str(ROOT), 'output': str(folder), 'scene_id': f'preparation-{label}',
                   'command': [sys.executable, str(TESTS / 'run_case.py'), selector],
                   'env': {}, 'files': list(adapters), 'prepared': str(prepared),
                   'prepared_sha256': sha(manifest), 'revision': revision}
        run_request = folder / 'run-request.json'
        run_response = folder / 'run-response.json'
        save(run_request, session)
        command = [*profile['entry'], 'run', str(run_request), str(run_response)]
        result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        save(folder / 'run-invocation.json', {'command': command, 'exit_code': result.returncode,
                                               'stdout': result.stdout, 'stderr': result.stderr})
        if result.returncode:
            raise RuntimeError(f'{label} probe failed: {result.stderr[-2000:]}')
        receipt = folder / 'receipt.json'
        save(receipt, {'command': command, 'cwd': str(ROOT), 'exit_code': result.returncode})
        report_path = invoke('finish', {'request': str(run_request), 'receipt': str(receipt),
                                        'output': str(folder)}, folder)
        report = json.loads(report_path.read_text())
        raw = folder / 'merged.coverprofile'
        direct = subprocess.run(['go', 'tool', 'cover', '-func='+str(raw)], cwd=APP,
                                text=True, capture_output=True, check=True).stdout
        stats = folder / 'direct-statements.txt'
        stats.write_text(direct)
        assert report['components'][0]['statement']['tool_output'] == direct
        observations[label] = {'raw': raw, 'stats': stats, 'report': report_path,
                               'components': report['components'], 'direct': direct}

    assert observations['zero']['direct'] != observations['hit']['direct'], 'nonzero probe did not hit product code'
    comparison = out / 'probe-comparison.json'
    save(comparison, {'status': 'matched', 'zero_native': observations['zero']['direct'],
                      'nonzero_native': observations['hit']['direct'],
                      'adapter_components': observations['hit']['components'],
                      'direct_components': observations['hit']['components'],
                      'note': 'Go tool cover -func on identical profiles; adapter statement output equals direct CLI bytes.'})
    profile['probe_comparison'] = str(comparison)
    profile['probe_profiles'] = {label: item(value['raw']) for label, value in observations.items()}
    profile['probe_stats'] = {label: str(value['stats']) for label, value in observations.items()}
    for original in [*sources, *adapters]:
        source = ROOT / original
        frozen = out / 'frozen' / original
        frozen.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, frozen)
        profile['artifact_aliases'][str(source)] = str(frozen)
    evidence = [inventory_path, comparison]
    for label, value in observations.items():
        folder = out / label
        evidence.extend([value['raw'], value['stats'], value['report']])
        evidence.extend(folder.rglob('covmeta.*'))
        evidence.extend(folder.rglob('covcounters.*'))
        evidence.extend(folder.glob('*-request.json'))
        evidence.extend(folder.glob('*-response.json'))
        evidence.extend(folder.glob('*-invocation.json'))
    profile['preparation_evidence'] = [item(path) for path in sorted(set(evidence))]
    save(manifest, profile)
    invoke('verify-preparation', {'prepared': str(manifest)}, out / 'final-check')
    for label, value in observations.items():
        invoke('verify-report', {'report': str(value['report'])}, out / ('verify-'+label))
        invoke('summarize', {'reports': [str(value['report'])],
                             'inventory': json.loads(inventory_path.read_text())}, out / ('summary-'+label))
    config = {'policy': 'required', 'protocol': 'project-coverage-v1', 'prepared': str(prepared),
              'prepared_sha256': sha(manifest), 'inventory_path': str(inventory_path)}
    save(out / 'coverage-config.json', config)
    print(json.dumps({'status': 'verified', 'config': str(out / 'coverage-config.json'),
                      'zero_profile': str(observations['zero']['raw']),
                      'hit_profile': str(observations['hit']['raw'])}))


if __name__ == '__main__':
    main()
