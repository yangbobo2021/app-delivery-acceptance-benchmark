import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
const appRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function withApp(run) {
 const out=process.env.ACCEPTANCE_EVIDENCE_DIR;
 assert(out,'ACCEPTANCE_EVIDENCE_DIR required');
 await fs.mkdir(out,{recursive:true});
 const raw=process.env.PROJECT_NATIVE_DIR;
 const server=spawn(process.execPath,['--require','./tests/node-flush.cjs','server.mjs'],{cwd:appRoot,env:{...process.env,PORT:'0',...(raw?{NODE_V8_COVERAGE:raw}:{})},stdio:['ignore','pipe','pipe']});
 let serverLog='';server.stderr.on('data',s=>serverLog+=s);
 let browser,context,page; let seq=0; const observations=[];
 try {
  const ready=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('server startup timeout: '+text+serverLog)),10000);server.once('exit',c=>{clearTimeout(timer);reject(Error('server exited '+c+serverLog));});server.stdout.on('data',s=>{text+=s; if(text.includes('\n')){clearTimeout(timer);resolve(JSON.parse(text.split('\n')[0]));}});});
  browser=await chromium.launch({channel:'chrome',headless:true}); context=await browser.newContext(); page=await context.newPage();
  await context.tracing.start({screenshots:true,snapshots:true,sources:true});
  await page.coverage.startJSCoverage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+ready.port+'/');
  async function observe(label){
   const state=await page.locator('body').innerText();
   const rows=await page.locator('#tasks li').evaluateAll(items=>items.map(li=>({id:li.dataset.id,title:li.querySelector('span').textContent,done:li.querySelector('input').checked})));
   const record={label,url:page.url(),body:state,rows,error:await page.locator('#error').innerText(),remaining:await page.locator('#remaining').innerText(),pageErrors:[...errors]};observations.push(record);
   await page.screenshot({path:path.join(out,String(++seq).padStart(2,'0')+'-'+label+'.png'),fullPage:true});
   await fs.writeFile(path.join(out,'observations.json'),JSON.stringify(observations,null,2));return record;
  }
  await run({page,context,browser,observe});
  assert.deepEqual(errors,[],'unexpected page errors');
 } finally {
  if(page&&raw){const entries=await page.coverage.stopJSCoverage();await fs.writeFile(path.join(out,'browser-native.json'),JSON.stringify(entries));
   const app=entries.filter(e=>new URL(e.url).pathname==='/app.js');assert.equal(app.length,1,'one app script document expected');
   assert.equal(app[0].source,await fs.readFile(path.join(appRoot,'dist/app.js'),'utf8'),'served source matches build');
   await fs.writeFile(path.join(raw,'browser.json'),JSON.stringify({result:app.map(e=>({...e,url:pathToFileURL(path.join(appRoot,'dist/app.js')).href}))}));
  }
  if(context){await context.tracing.stop({path:path.join(out,'trace.zip')});await context.close();}if(browser)await browser.close();
  server.kill('SIGTERM');await once(server,'exit');
  await fs.writeFile(path.join(out,'server-stderr.log'),serverLog);
 }
}
