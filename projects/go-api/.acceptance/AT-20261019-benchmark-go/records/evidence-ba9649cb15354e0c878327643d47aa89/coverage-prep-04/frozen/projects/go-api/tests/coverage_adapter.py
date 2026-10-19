#!/usr/bin/env python3
"""Project-owned Go native coverage protocol. No coverage unit/count algorithms.
Uses go test native profiles and go tool cover -func for statement statistics.
Line/branch metrics and undeclared diff scopes are explicitly unavailable.
"""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile

def read(p): return json.loads(pathlib.Path(p).read_text())
def sha(p): return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def save(p,v): pathlib.Path(p).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def resolve(p,r):
 m=r.get('artifact_map',{});i=m.get(str(p))
 if pathlib.Path(p).is_file(): return pathlib.Path(p)
 return pathlib.Path(i['path']) if i else pathlib.Path(p)
def checked_file(item,r):
 p=resolve(item['path'],r)
 assert sha(p)==item['sha256'],str(p)
 return p
def version(): return subprocess.check_output(['go','version'],text=True).strip()
def native_stats(profile):
 command=['go','tool','cover','-func='+str(profile)]
 result=subprocess.run(command,text=True,capture_output=True,cwd=pathlib.Path(__file__).resolve().parent.parent)
 if result.returncode: raise RuntimeError(result.stderr)
 return result.stdout

def covdata_text(directories,output):
 command=['go','tool','covdata','textfmt','-i='+','.join(map(str,directories)),'-o='+str(output)]
 result=subprocess.run(command,text=True,capture_output=True,cwd=pathlib.Path(__file__).resolve().parent.parent)
 if result.returncode:raise RuntimeError(result.stderr)
 return pathlib.Path(output)

def native_files(directory):
 directory=pathlib.Path(directory)
 files=sorted([*directory.glob('covmeta.*'),*directory.glob('covcounters.*')])
 if not any(file.name.startswith('covmeta.') for file in files) or not any(file.name.startswith('covcounters.') for file in files):
  raise ValueError('incomplete Go native covdata directory: '+str(directory))
 return files

def scene_directories(receipt):
 fresh=receipt.get('env_changes',{}).get('ACCEPTANCE_CASE_ROOT')
 if not fresh:return []
 root=pathlib.Path(fresh)
 if not root.is_dir():raise ValueError('fresh case output root missing')
 # The case owns its fresh state directory. Discover native process records
 # there without naming any particular test or service phase.
 found=sorted({file.parent for file in root.rglob('covmeta.*')})
 for directory in found:native_files(directory)
 return found

def copy_covdata(source,target):
 target.mkdir(parents=True,exist_ok=False)
 for file in native_files(source):shutil.copy2(file,target/file.name)
 return native_files(target)

def evidence_groups(report,r):
 groups={}
 for item in report['raw_evidence']:
  if item.get('role')=='go_covdata':groups.setdefault(item['group'],[]).append((item,checked_file(item,r)))
 if not groups:raise ValueError('report has no Go native covdata')
 return groups

def materialize_groups(groups,root):
 dirs=[]
 for label,items in groups.items():
  directory=pathlib.Path(root)/label;directory.mkdir(parents=True)
  for item,source in items:shutil.copy2(source,directory/pathlib.Path(item['path']).name)
  native_files(directory);dirs.append(directory)
 return dirs

def metric(reason): return {'status':'unavailable','reason':reason}
def components(stats):
 return [{'id':'stock-go','label':'Go native statement coverage (not line/branch coverage)','source_paths':['projects/go-api/main.go'],
 'line':metric('Go native coverage exposes statement/block units; no verified line conversion tool is installed.'),
 'branch':metric('Go native cover does not report branch coverage.'),
 'statement':{'status':'measured','tool_output':stats}}]
def validate_profile(p,r):
 assert p['schema']=='project-coverage-preparation-v1'
 assert version()==p['tools'][0]['version']
 for item in p['preparation_evidence']: checked_file(item,r)
 for original,snapshot in p['artifact_aliases'].items():
  relative=str(pathlib.Path(original).relative_to(p['spec']['project_root'])); expected={**p['spec']['source_hashes'],**p['adapter_files']}[relative]
  checked_file({'path':snapshot,'sha256':expected},r)
 comparison=read(resolve(p['probe_comparison'],r))
 assert comparison['status']=='matched' and comparison['adapter_components']==comparison['direct_components']
 return p

def main(op,r):
 if op=='verify-preparation':
  p=validate_profile(read(resolve(r['prepared'],r)),r)
  for kind in ['zero','hit']:
   evidence=p['probe_profiles'][kind];raw=checked_file(evidence,r)
   stats=native_stats(raw)
   assert stats==resolve(p['probe_stats'][kind],r).read_text()
  return {'status':'valid','tool_version':version()}
 if op=='run':
  out=pathlib.Path(r['output']);coverdir=out/'covdata'/'parent';coverdir.parent.mkdir(parents=True,exist_ok=True)
  env={**os.environ,**r.get('env',{}),'ACCEPTANCE_COVERDIR':str(coverdir)}
  result=subprocess.run(r['command'],cwd=r['cwd'],env=env)
  response={'exit_code':result.returncode,'command':r['command'],'native_coverdir':str(coverdir),
            'native_files':[{'path':str(file),'sha256':sha(file)} for file in native_files(coverdir)]}
  save(sys.argv[3],response)
  return result.returncode
 if op=='finish':
  session=read(r['request']);p=read(pathlib.Path(session['prepared'])/'prepared.json');out=pathlib.Path(r['output'])
  response=out/'run-response.json';rr=read(response);receipt=read(r['receipt'])
  parent=out/'covdata'/'parent'
  assert rr['command']==session['command'] and rr['exit_code']==receipt['exit_code']
  assert rr['native_files']==[{'path':str(file),'sha256':sha(file)} for file in native_files(parent)]
  directories=[parent];sources=[]
  for index,source in enumerate(scene_directories(receipt)):
   target=out/'covdata'/f'child-{index}'
   copy_covdata(source,target)
   directories.append(target)
   sources.append({'source_dir':str(source),'copied_dir':str(target),
                   'files':[{'name':file.name,'sha256':sha(file)} for file in native_files(target)]})
  merged=covdata_text(directories,out/'merged.coverprofile')
  stats=native_stats(merged);statfile=out/'native-statements.txt';statfile.write_text(stats)
  evidence=[{'path':str(file),'sha256':sha(file),'role':'go_covdata','group':directory.name}
            for directory in directories for file in native_files(directory)]
  evidence.extend({'path':str(file),'sha256':sha(file),'role':role} for file,role in
                  [(merged,'merged_text'),(statfile,'native_stats'),(response,'run_response')])
  return {'schema':'project-tool-coverage-report-v1','protocol':'project-coverage-v1','prepared':session['prepared'],'prepared_sha256':session['prepared_sha256'],
   'scene_id':session['scene_id'],'revision':p['spec']['revision'],'source_hashes':p['spec']['source_hashes'],'tools':p['tools'],'collection_relation':'same_run',
   'status':'measured','receipt_path':r['receipt'],'execution_sha256':sha(r['receipt']),
   'raw_evidence':evidence,'collection_sources':sources,'components':components(stats)}
 if op=='verify-report':
  report=read(resolve(r['report'],r));p=validate_profile(read(resolve(pathlib.Path(report['prepared'])/'prepared.json',r)),r)
  for item in report['raw_evidence']: checked_file(item,r)
  with tempfile.TemporaryDirectory() as folder:
   directories=materialize_groups(evidence_groups(report,r),folder)
   regenerated=covdata_text(directories,pathlib.Path(folder)/'regenerated.coverprofile')
   assert regenerated.read_bytes()==checked_file(report['raw_evidence'][-3],r).read_bytes()
  stats=native_stats(checked_file(report['raw_evidence'][-3],r))
  assert components(stats)==report['components']
  assert stats==checked_file(report['raw_evidence'][-2],r).read_text()
  return {'status':'valid'}
 if op=='summarize':
  reports=[read(resolve(path,r)) for path in r['reports']]
  with tempfile.TemporaryDirectory() as folder:
   directories=[]
   for index,report in enumerate(reports):
    directories.extend(materialize_groups(evidence_groups(report,r),pathlib.Path(folder)/str(index)))
   combined=covdata_text(directories,pathlib.Path(folder)/'combined.coverprofile')
   stats=native_stats(combined)
  return {'tools':reports[0]['tools'],'scopes':{
   'project':{'status':'measured','components':components(stats),'reason':'Go native covdata from the parent and any observed child processes merged by go tool covdata; statement report only. Line/branch metrics unavailable.'},
   'changed_files':{'status':'unavailable','reason':'Requirements run at one frozen revision; no change comparison/base was requested or frozen.'},
   'changed_lines':{'status':'unavailable','reason':'No change comparison/base was requested; native Go tool has no verified changed-line summarizer.'}}}
 raise ValueError(op)

if __name__=='__main__':
 result=main(sys.argv[1],read(sys.argv[2]))
 if type(result) is int: sys.exit(result)
 save(sys.argv[3],result)
