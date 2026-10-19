"""Project-owned coverage.py protocol adapter for the invoice CLI.

Coverage.py owns executable units, subprocess collection, merging and counts.
The adapter only binds its native data to the frozen acceptance session.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import coverage

APP_SOURCE = 'projects/python-cli/invoice'


def read(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def bound(path, mapping, expected=None):
    original = str(path)
    value = mapping.get(original + '#' + expected) if expected else None
    value = value or mapping.get(original)
    actual = Path(value['path']) if value else Path(path)
    digest = expected or (value['sha256'] if value else None)
    if digest and sha(actual) != digest:
        raise ValueError('changed coverage artifact: ' + original)
    return actual


def metric(totals, branch=False):
    return {'status': 'measured',
            'covered': totals['covered_branches' if branch else 'covered_lines'],
            'total': totals['num_branches' if branch else 'num_statements'],
            'pct': totals['percent_branches_covered' if branch else 'percent_statements_covered']}


def component(profile, totals):
    return {'id': 'invoice-python', 'label': 'coverage.py native lines and arcs',
            'source_paths': sorted(profile['spec']['source_hashes']),
            'line': metric(totals), 'branch': metric(totals, True)}


def native(profile, databases, mapping):
    root = Path(profile['spec']['project_root'])
    with tempfile.TemporaryDirectory(prefix='invoice-coverage-report-') as temporary:
        folder = Path(temporary).resolve()
        destinations = {}
        for name, digest in profile['spec']['source_hashes'].items():
            target = folder / 'src' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(bound(root / name, mapping, digest), target)
            destinations[name] = str(target)

        def remap(name):
            value = str(name)
            if value.startswith(str(root) + '/'):
                value = value[len(str(root)) + 1:]
            if value not in destinations:
                raise ValueError('unexpected coverage source: ' + value)
            return destinations[value]

        cov = coverage.Coverage(config_file=False, data_file=str(folder / 'merged'),
                                branch=True, source=[str(folder / 'src' / APP_SOURCE)])
        merged = cov.get_data()
        merged.add_arcs({})
        for destination in destinations.values():
            merged.touch_file(destination)
        for database in databases:
            data = coverage.CoverageData(basename=str(database))
            data.read()
            if not data.has_arcs():
                if any(data.lines(name) or data.arcs(name) for name in data.measured_files()):
                    raise ValueError('coverage branch data missing for nonempty input')
                continue  # Native zero-hit discovery reports files without arc mode.
            merged.update(data, map_path=remap)
        cov.save()
        path = folder / 'report.json'
        cov.json_report(outfile=str(path))
        return read(path)


def profile_at(path, mapping):
    profile = read(bound(path, mapping))
    if coverage.__version__ != profile['tools'][0]['version']:
        raise ValueError('coverage.py tool version changed')
    for artifact in profile['preparation_evidence']:
        bound(artifact['path'], mapping, artifact['sha256'])
    for name, digest in {**profile['spec']['source_hashes'], **profile['adapter_files']}.items():
        bound(Path(profile['spec']['project_root']) / name, mapping, digest)
    return profile


def operate(operation, request, response):
    mapping = request.get('artifact_map', {})
    if operation == 'verify-preparation':
        profile = profile_at(request['prepared'], mapping)
        probe = read(bound(profile['probe_comparison']['path'], mapping,
                           profile['probe_comparison']['sha256']))
        if probe['status'] != 'matched' or probe['zero']['covered_lines'] != 0 or probe['hit']['covered_lines'] <= 0:
            raise ValueError('nonzero coverage probe mismatch')
        for label, evidence in profile['probe_databases'].items():
            report = native(profile, [bound(evidence['path'], mapping, evidence['sha256'])], mapping)
            if report['totals'] != probe[label]:
                raise ValueError('native probe totals changed')
        save(response, {'status': 'valid', 'tool_version': coverage.__version__})
        return 0
    if operation == 'run':
        profile_at(Path(request['prepared']) / 'prepared.json', mapping)
        out = Path(request['output'])
        command = request['command']
        if Path(command[0]).resolve() != Path(sys.executable).resolve():
            raise ValueError('use the prepared Python interpreter')
        config = Path(request['cwd']) / 'projects/python-cli/tests/coverage.ini'
        env = {**os.environ, **request.get('env', {}),
               'COVERAGE_FILE': str(out / 'native-data'), 'COVERAGE_RCFILE': str(config),
               'PYTHONDONTWRITEBYTECODE': '1'}
        actual = [sys.executable, '-m', 'coverage', 'run', '--rcfile', str(config), *command[1:]]
        result = subprocess.run(actual, cwd=request['cwd'], env=env)
        combine = subprocess.run([sys.executable, '-m', 'coverage', 'combine', '--keep', str(out)],
                                 cwd=request['cwd'], env=env, text=True, capture_output=True)
        save(out / 'native-invocation.json', {'business_command': command, 'collector_command': actual,
                                              'business_exit_code': result.returncode,
                                              'combine_exit_code': combine.returncode,
                                              'combine_stdout': combine.stdout,
                                              'combine_stderr': combine.stderr})
        if combine.returncode:
            raise RuntimeError('coverage combine failed: ' + combine.stderr)
        save(response, {'exit_code': result.returncode, 'native_data': str(out / 'native-data')})
        return result.returncode
    if operation == 'finish':
        session = read(request['request'])
        profile = profile_at(Path(session['prepared']) / 'prepared.json', mapping)
        out = Path(request['output'])
        data = out / 'native-data'
        report = native(profile, [data], mapping)
        native_path = out / 'native-report.json'
        save(native_path, report)
        raw = [*sorted(out.glob('native-data*')), native_path, out / 'native-invocation.json', out / 'run-response.json']
        result = {'schema': 'project-tool-coverage-report-v1', 'protocol': 'project-coverage-v1',
                  'prepared': session['prepared'], 'prepared_sha256': session['prepared_sha256'],
                  'scene_id': session['scene_id'], 'revision': profile['spec']['revision'],
                  'source_hashes': profile['spec']['source_hashes'], 'tools': profile['tools'],
                  'collection_relation': 'same_run', 'status': 'measured',
                  'receipt_path': request['receipt'], 'execution_sha256': sha(request['receipt']),
                  'raw_evidence': [{'path': str(path), 'sha256': sha(path)} for path in raw],
                  'components': [component(profile, report['totals'])]}
        save(response, result)
        return 0
    if operation == 'verify-report':
        report = read(bound(request['report'], mapping))
        profile = profile_at(Path(report['prepared']) / 'prepared.json', mapping)
        for evidence in report['raw_evidence']:
            bound(evidence['path'], mapping, evidence['sha256'])
        database = next(x for x in report['raw_evidence'] if Path(x['path']).name == 'native-data')
        original = native(profile, [bound(database['path'], mapping, database['sha256'])], mapping)
        if report['components'] != [component(profile, original['totals'])]:
            raise ValueError('coverage report differs from native data')
        save(response, {'status': 'valid'})
        return 0
    if operation == 'summarize':
        reports = [read(bound(x, mapping)) for x in request['reports']]
        profile = profile_at(Path(reports[0]['prepared']) / 'prepared.json', mapping)
        databases = []
        for report in reports:
            databases.append(next(bound(x['path'], mapping, x['sha256']) for x in report['raw_evidence']
                                  if Path(x['path']).name == 'native-data'))
        merged = native(profile, databases, mapping)
        unavailable = {'status': 'unavailable', 'reason': 'Requirements benchmark has no frozen base/head change inventory.'}
        save(response, {'tools': profile['tools'], 'scopes': {
            'project': {'status': 'measured', 'components': [component(profile, merged['totals'])]},
            'changed_files': unavailable, 'changed_lines': unavailable}})
        return 0
    raise ValueError('unknown coverage operation: ' + operation)


if __name__ == '__main__':
    sys.exit(operate(sys.argv[1], read(sys.argv[2]), sys.argv[3]))
