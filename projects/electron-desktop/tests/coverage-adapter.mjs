import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import libCoverage from 'istanbul-lib-coverage';
const [op,requestFile,responseFile]=process.argv.slice(2);
const req=JSON.parse(fs.readFileSync(requestFile));
const workspace=process.cwd(),root=path.join(workspace,'projects/electron-desktop'), require=createRequire(path.join(root,'tests/package.json'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const resolveFile=(p,h)=>req.artifact_map?.[p+'#'+h]?.path||req.artifact_map?.[p]?.path||p;
const read=(p,h)=>JSON.parse(fs.readFileSync(resolveFile(p,h)));
const save=(p,x)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');};
const bound=(p,h)=>{if(hash(resolveFile(p,h))!==h)throw Error('Hash mismatch '+p);};
const versions=()=>[
 {name:'Electron / V8 NODE_V8_COVERAGE + Chromium precise coverage',version:'44.9.0 / 15.2.124.43-electron.0',role:'collector'},
 {name:'playwright',version:require('playwright/package.json').version,role:'collector'},
 {name:'c8',version:require('c8/package.json').version,role:'converter/source-map/zero-units'},
 {name:'v8-to-istanbul',version:require('v8-to-istanbul/package.json').version,role:'converter/source-map'},
 {name:'istanbul-lib-coverage',version:require('istanbul-lib-coverage/package.json').version,role:'merge/statistics'}];
const unavailable=reason=>({status:'unavailable',reason});
const gap='Bundled main/store source-map zero baseline reports falsely covered lines; reliable complete native metrics remain unavailable. Raw counts are diagnostics only.';
function metrics(map){
 const picked=libCoverage.createCoverageMap({});
 for(const file of map.files())if(['src/renderer.ts','src/preload.ts'].includes(path.relative(root,file)))picked.addFileCoverage(map.fileCoverageFor(file));
 const sum=picked.getCoverageSummary().toJSON();
 const metric=v=>({status:'measured',covered:v.covered,total:v.total,pct:v.pct});
 return [
 {id:'renderer-preload',label:'Electron renderer + sandbox preload; native V8 block branches',source_paths:['projects/electron-desktop/src/renderer.ts','projects/electron-desktop/src/preload.ts'],line:metric(sum.lines),branch:metric(sum.branches)},
 {id:'main-store',label:'Electron main + bundled Store',source_paths:['projects/electron-desktop/src/main.ts','projects/electron-desktop/src/store.ts'],line:unavailable(gap),branch:unavailable(gap)},
 {id:'build',label:'Build helper',source_paths:['projects/electron-desktop/build.mjs'],line:unavailable('Build helper is not exercised by desktop scenes; separate complete native baseline has not been verified.'),branch:unavailable('Build helper native branch denominator has not been verified.')}
 ];
}
function scopes(components){return {
 project:{status:'incomplete',reason:'Only renderer/preload metrics verified; main/store/build unavailable. Static HTML is non-executable.',components},
 changed_files:{status:'unavailable',reason:'Requirements benchmark has no frozen base/head change inventory. '+gap},
 changed_lines:{status:'unavailable',reason:'Requirements benchmark has no frozen base/head changed lines. '+gap}
};}
function nativeReport(nativeDir,output){
 const argv=[require.resolve('c8/bin/c8.js'),'report','--all','--src','dist','--temp-directory',nativeDir,'--reports-dir',output,'--reporter','json','--reporter','json-summary','--exclude-after-remap','--exclude','tests/**','--exclude','node_modules/**'];
 const result=spawnSync(process.execPath,argv,{cwd:root,encoding:'utf8'});
 save(path.join(output,'command.json'),{command:[process.execPath,...argv],exit_code:result.status,stdout:result.stdout,stderr:result.stderr});
 if(result.status!==0)throw Error(result.stderr||'c8 failed');
 const map=libCoverage.createCoverageMap(read(path.join(output,'coverage-final.json')));
 for(const name of ['src/main.ts','src/store.ts','src/preload.ts','src/renderer.ts'])if(!map.files().includes(path.join(root,name)))throw Error('c8 omitted '+name);
 return map;
}
function rawInputs(output){
 const dirs=[path.join(output,'native')];
 const visit=p=>{for(const x of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,x.name);if(x.isDirectory())visit(f);else if(x.name==='renderer.json'){
 const result=read(f).filter(x=>x.url.includes('/dist/')&&!x.url.includes('/node_modules/')).map(({source,...x})=>({...x,url:x.url.startsWith('file:')?x.url:'file://'+x.url}));
 save(path.join(output,'native','renderer-'+crypto.createHash('sha256').update(f).digest('hex').slice(0,10)+'.json'),{result});
 }}};
 const evidence=path.join(output,'ui');if(fs.existsSync(evidence))visit(evidence);
 return dirs[0];
}
function checkProfile(p){
 if(JSON.stringify(p.tools)!==JSON.stringify(versions()))throw Error('Tool versions changed');
 for(const [n,h] of Object.entries({...p.spec.source_hashes,...p.adapter_files}))bound(path.join(p.spec.project_root,n),h);
 bound(p.spec.inventory_path,p.spec.inventory_sha256);
 for(const a of p.preparation_evidence)bound(a.path,a.sha256);
 if(p.probe_only)return;
 const cmp=read(p.probe_comparison.path,p.probe_comparison.sha256);
 if(cmp.status!=='matched'||!cmp.nonzero_chain||!cmp.zero_baseline_verified)throw Error('Probe comparison absent');
 const baseline=read(p.zero_summary.path,p.zero_summary.sha256);
 for(const name of ['src/renderer.ts','src/preload.ts'])if(baseline[path.join(root,name)].lines.covered!==0)throw Error('Zero baseline invalid '+name);
}
function verifyReport(r){
 const p=read(path.join(r.prepared,'prepared.json'),r.prepared_sha256);checkProfile(p);
 for(const x of r.raw_evidence)bound(x.path,x.sha256);
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-native-recompute-'));
 try{
 const native=path.join(tmp,'native');fs.mkdirSync(native);
 for(const [i,x] of r.raw_evidence.filter(x=>x.role==='v8').entries())fs.copyFileSync(resolveFile(x.path,x.sha256),path.join(native,i+'.json'));
 const map=nativeReport(native,path.join(tmp,'report'));const c=metrics(map);
 if(JSON.stringify(c)!==JSON.stringify(r.components))throw Error('Native recomputation differs');
 return {p,map};
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
let result;
if(op==='verify-preparation'){
 const p=read(req.prepared);if(p.probe_only)throw Error('Probe-only profile cannot activate');checkProfile(p);result={status:'valid',tools:versions(),limits:[gap]};
}else if(op==='run'){
 fs.mkdirSync(path.join(req.output,'native'),{recursive:true});
 fs.mkdirSync(path.join(req.output,'ui'),{recursive:true});
 const r=spawnSync(req.command[0],req.command.slice(1),{cwd:req.cwd,env:{...process.env,...req.env,NODE_V8_COVERAGE:path.join(req.output,'native'),NATIVE_COVERAGE_DIR:path.join(req.output,'native'),UI_EVIDENCE_DIR:path.join(req.output,'ui')},stdio:'inherit'});
 result={status:'executed',exit_code:r.status,signal:r.signal};save(responseFile,result);process.exit(r.status??1);
}else if(op==='finish'){
 const session=read(req.request),receipt=read(req.receipt),p=read(path.join(session.prepared,'prepared.json'),session.prepared_sha256);
 const native=rawInputs(session.output),map=nativeReport(native,path.join(session.output,'c8'));
 const files=fs.readdirSync(native).filter(x=>x.endsWith('.json')).map(x=>({path:path.join(native,x),sha256:hash(path.join(native,x)),role:'v8'}));
 for(const f of ['coverage-final.json','coverage-summary.json','command.json'])files.push({path:path.join(session.output,'c8',f),sha256:hash(path.join(session.output,'c8',f)),role:'c8'});
 result={schema:'project-tool-coverage-report-v1',protocol:'project-coverage-v1',prepared:session.prepared,prepared_sha256:session.prepared_sha256,scene_id:session.scene_id,revision:p.spec.revision,source_hashes:p.spec.source_hashes,tools:p.tools,collection_relation:'same_run',status:'incomplete',receipt_path:req.receipt,execution_sha256:hash(req.receipt),raw_evidence:files,components:metrics(map)};
 save(path.join(session.output,'coverage-report.json'),result);
}else if(op==='verify-report'){
 const r=read(req.report);verifyReport(r);result={status:'valid'};
}else if(op==='summarize'){
 const maps=req.reports.map(f=>verifyReport(read(f)).map),merged=libCoverage.createCoverageMap({});
 for(const map of maps)merged.merge(map);
 result={tools:versions(),scopes:scopes(metrics(merged))};
}else if(op==='probe-report'){
 const map=nativeReport(req.native,path.join(req.output,'c8'));result={tools:versions(),scopes:scopes(metrics(map)),source_paths:map.files().map(x=>path.relative(root,x))};
}else throw Error('Unknown operation '+op);
save(responseFile,result);
