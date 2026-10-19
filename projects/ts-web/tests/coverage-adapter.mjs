// Project adapter: paths, process lifecycle and protocol only. c8/Istanbul own all units and counts.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
let require,lib;
const [op,input,response]=process.argv.slice(2);
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const digest=async p=>createHash('sha256').update(await fs.readFile(p)).digest('hex');
const save=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(v,null,2)+'\n');};
const req=await read(input);const mapping=req.artifact_map||{};
async function mapped(p,h){const m=mapping[p+'#'+h]||mapping[p];if(m){assert.equal(await digest(m.path),m.sha256);return m.path;}return p;}
let profilePath;
if(op==='verify-preparation') profilePath=req.prepared;
else if(op==='finish') profilePath=(await read(req.request)).prepared+'/prepared.json';
else if(op==='verify-report') profilePath=(await read(await mapped(req.report))).prepared+'/prepared.json';
else if(op==='summarize') profilePath=(await read(await mapped(req.reports[0]))).prepared+'/prepared.json';
else profilePath=req.prepared+'/prepared.json';
const profile=await read(await mapped(profilePath));
const workspace=profile.spec.project_root,root=path.join(workspace,"projects/ts-web");
require=createRequire(path.join(root,'tests/package.json'));lib=require('istanbul-lib-coverage');
const versions=()=>[
 {name:'Google Chrome',version:spawnSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--version'],{encoding:'utf8'}).stdout.trim(),role:'browser runtime'},
 {name:'Node V8',version:process.versions.v8,role:'native Node collector'},
 ...['playwright','c8','v8-to-istanbul','istanbul-lib-coverage','istanbul-reports'].map(n=>({name:n,version:require(n+'/package.json').version,role:n==='playwright'?'Chromium native precise collector':n==='v8-to-istanbul'?'source-map conversion':n==='c8'?'complete zero baseline and V8 merge/report':'statistics/report'}))
];
function components(map){const s=map.getCoverageSummary().toJSON();const metric=v=>({status:'measured',covered:v.covered,total:v.total,pct:v.pct});return [{id:'javascript',label:'Browser TypeScript and Node build/host',source_paths:Object.keys(profile.spec.source_hashes).filter(p=>p!=='projects/ts-web/src/index.html'),line:metric(s.lines),branch:metric(s.branches)}];}
function scopes(c){return {project:{status:'measured',components:c},changed_files:{status:'unavailable',reason:'Fixed revision acceptance has no admitted base/head change scope.'},changed_lines:{status:'unavailable',reason:'Fixed revision acceptance has no admitted diff line inventory.'}};}
async function toolMap(reportPaths,out){
 const scratch=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'tasks-c8-'))),appScratch=path.join(scratch,'projects/ts-web'); const native=path.join(scratch,'native');await fs.mkdir(native);
 try{
  const frozen={...profile.spec.source_hashes,...profile.adapter_files,...profile.build_hashes};
  for(const [rel,h] of Object.entries(frozen)){if(rel.startsWith('projects/ts-web/tests/'))continue;const src=await mapped(profile.build_artifacts?.[rel]?.path||path.join(workspace,rel),h);assert.equal(await digest(src),h);await fs.mkdir(path.dirname(path.join(scratch,rel)),{recursive:true});await fs.copyFile(src,path.join(scratch,rel));}
  let n=0;
  for(const r of reportPaths){for(const e of r.raw_evidence.filter(e=>e.role==='native_v8')){
   const data=await read(await mapped(e.path,e.sha256));const result=data.result.map(s=>{let p;try{p=fileURLToPath(s.url);}catch{return s;}return p.startsWith(root+'/')?{...s,url:pathToFileURL(path.join(appScratch,path.relative(root,p))).href}:s;});await save(path.join(native,String(n++)+'.json'),{...data,result});
  }}
  const config=await read(await mapped(path.join(root,'tests/coverage-config.json'),profile.adapter_files['projects/ts-web/tests/coverage-config.json']));
  const args=[require.resolve('c8/bin/c8.js'),'report','--all','--temp-directory',native,'--reports-dir',out,'--reporter','json','--reporter','json-summary',...config.include.flatMap(x=>['--include',x]),...config.extension.flatMap(x=>['--extension',x])];
  const proc=spawnSync(process.execPath,args,{cwd:appScratch,encoding:'utf8'});assert.equal(proc.status,0,proc.stderr);await save(path.join(out,'tool-invocation.json'),{command:[process.execPath,...args],exit_code:proc.status,stdout:proc.stdout,stderr:proc.stderr});
  const raw=await read(path.join(out,'coverage-final.json'));const normalized={};for(const [p,c]of Object.entries(raw)){const orig=path.join(root,path.relative(appScratch,p));normalized[orig]={...c,path:orig};}
  const map=lib.createCoverageMap(normalized);assert.deepEqual(map.files().sort(),['build.mjs','server.mjs','src/app.ts'].map(p=>path.join(root,p)).sort(),'complete mapped denominator');
  await save(path.join(out,'coverage-normalized.json'),map.toJSON());return map;
 }finally{await fs.rm(scratch,{recursive:true,force:true});}
}
async function tempMap(reports){const out=await fs.mkdtemp(path.join(os.tmpdir(),'tasks-report-'));try{return await toolMap(reports,out);}finally{await fs.rm(out,{recursive:true,force:true});}}
if(op==='run'){
 const native=path.join(req.output,'native');await fs.mkdir(native,{recursive:true});
 const proc=spawnSync(req.command[0],req.command.slice(1),{cwd:req.cwd,env:{...process.env,...req.env,PROJECT_NATIVE_DIR:native,ACCEPTANCE_EVIDENCE_DIR:req.env?.ACCEPTANCE_EVIDENCE_DIR||path.join(req.output,'dom')},stdio:'inherit'});
 await save(response,{exit_code:proc.status,command:req.command,native});process.exitCode=proc.status??1;
}else if(op==='finish'){
 const session=await read(req.request);const raw=[];
 for(const name of await fs.readdir(path.join(req.output,'native'))){const p=path.join(req.output,'native',name);raw.push({path:p,sha256:await digest(p),role:'native_v8'});}
 for(const rel of ['dist/app.js','dist/app.js.map']){const p=path.join(req.output,'build',rel);await fs.mkdir(path.dirname(p),{recursive:true});await fs.copyFile(path.join(root,rel),p);raw.push({path:p,sha256:await digest(p),role:'served_build'});}
 const report={schema:'project-tool-coverage-report-v1',protocol:'project-coverage-v1',prepared:session.prepared,prepared_sha256:session.prepared_sha256,scene_id:session.scene_id,revision:profile.spec.revision,source_hashes:profile.spec.source_hashes,tools:profile.tools,collection_relation:'same_run',status:'measured',receipt_path:req.receipt,execution_sha256:await digest(req.receipt),raw_evidence:raw};
 report.components=components(await toolMap([report],path.join(req.output,'c8-report')));await save(response,report);
}else if(op==='verify-report'){
 const r=await read(await mapped(req.report));assert.deepEqual(r.components,components(await tempMap([r])));for(const e of r.raw_evidence)assert.equal(await digest(await mapped(e.path,e.sha256)),e.sha256);await save(response,{status:'valid'});
}else if(op==='summarize'){
 const rs=await Promise.all(req.reports.map(async p=>read(await mapped(p))));assert.deepEqual(req.inventory,await read(await mapped(profile.spec.inventory_path,profile.spec.inventory_sha256)));await save(response,{tools:profile.tools,scopes:scopes(components(await tempMap(rs)))});
}else if(op==='verify-preparation'){
 assert.deepEqual(profile.tools,versions());for(const [p,h] of Object.entries({...profile.spec.source_hashes,...profile.adapter_files,...profile.build_hashes}))assert.equal(await digest(await mapped(profile.build_artifacts?.[p]?.path||path.join(workspace,p),h)),h);
 for(const e of profile.preparation_evidence)assert.equal(await digest(await mapped(e.path,e.sha256)),e.sha256);
 const comparison=await read(await mapped(profile.comparison.path,profile.comparison.sha256));assert.equal(comparison.status,'equal');assert(comparison.nonzero_lines>0);assert.equal(comparison.zero_lines,0);await save(response,{status:'valid',tools:versions()});
}else throw Error('Unknown operation '+op);
