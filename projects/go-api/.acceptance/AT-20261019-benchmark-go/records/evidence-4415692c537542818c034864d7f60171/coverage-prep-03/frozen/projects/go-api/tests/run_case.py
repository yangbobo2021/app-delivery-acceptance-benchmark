#!/usr/bin/env python3
"""Repository regression entry. Go's official build overlay keeps tests in tests/.
No source is copied, patched or generated. All *_test.go are provided to Go as
virtual package-root test files. Original product bytes remain unchanged.
"""
import json,os,pathlib,subprocess,sys,tempfile
root=pathlib.Path(__file__).resolve().parent.parent
coverdir=pathlib.Path(os.environ['ACCEPTANCE_COVERDIR'])
coverdir.mkdir(parents=True,exist_ok=False)
with tempfile.TemporaryDirectory(prefix='go-overlay-',dir=coverdir.parent) as directory:
 overlay=pathlib.Path(directory)/'overlay.json'
 overlay.write_text(json.dumps({'Replace':{str(root/('acceptance_'+p.name)):str(p) for p in sorted((root/'tests').glob('*_test.go'))}}))
 binary=pathlib.Path(directory)/'stock.test'
 build=['go','test','-c','-overlay',str(overlay),'-covermode=atomic','-coverpkg=stock.local/app','-o',str(binary),'.']
 print(json.dumps({'native_build_command':build}),flush=True)
 if subprocess.call(build,cwd=root):sys.exit(2)
 command=[str(binary),'-test.v','-test.run='+ (sys.argv[1] if len(sys.argv)>1 else '.'),'-test.gocoverdir='+str(coverdir)]
 print(json.dumps({'native_test_command':command,'native_coverdir':str(coverdir)}),flush=True)
 sys.exit(subprocess.call(command,cwd=root,env={**os.environ,'GOCOVERDIR':str(coverdir)}))
