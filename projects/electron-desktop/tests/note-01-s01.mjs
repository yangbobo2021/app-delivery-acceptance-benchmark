import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
assert.ok(process.env.ACCEPTANCE_CASE_ROOT, 'Execution entry must bind ACCEPTANCE_CASE_ROOT');
assert.ok(process.env.UI_EVIDENCE_DIR, 'Execution entry must bind UI_EVIDENCE_DIR');
const out = path.resolve(process.env.UI_EVIDENCE_DIR);
fs.mkdirSync(out, {recursive: true});
const userData = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_CASE_ROOT, 'note-01-s01-user-'));
const notes = [
  {title: '周一采购清单', body: '早餐：牛奶和面包。\n晚餐：番茄、鸡蛋和米饭。'},
  {title: '周末读书计划', body: '周六上午阅读第三章。\n周日下午整理读书笔记并写下两个问题。'}
];
const report = {
  scene: 'NOTE-01-S01', userData, inputs: notes,
  coverageChecklist: [
    'Create and save A through visible controls; select and read its entire title and body',
    'Create and save B with a different legal title and body; both list entries coexist',
    'Select A, B, A, B after both saves; each selection displays its own entire title and body'
  ],
  status: 'starting', businessExecution: 'not_started', observations: [], checks: []
};
const flush = () => fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(report, null, 2));
flush();
process.on('uncaughtExceptionMonitor', (error, origin) => {
  report.status = 'failed';
  report.fatalDriverError = {origin, name: error.name, message: error.message, stack: error.stack};
  flush();
});
let app, electronProcess, page, coverageStarted = false;
const errorDetails = error => ({name: error.name, message: error.message, stack: error.stack});
async function recordElectronExit(child) {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const onExit = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        reject(new Error('Electron process did not exit within 5 seconds after app.close()'));
      }, 5000);
      child.once('exit', onExit);
    });
  }
  report.electronExitCode = child.exitCode;
  report.electronSignalCode = child.signalCode;
  report.electronProcessExited = child.exitCode !== null || child.signalCode !== null;
}
function check(label, fn) {
  try { fn(); report.checks.push({label, passed: true}); }
  catch (error) { report.checks.push({label, passed: false, message: error.message}); throw error; }
  finally { flush(); }
}
async function observe(label) {
  const dom = await page.evaluate(() => ({
    url: location.href, html: document.body.outerHTML,
    rows: [...document.querySelectorAll('#notes button')].map(b => ({title: b.textContent, id: b.dataset.id})),
    title: document.querySelector('#title')?.value,
    body: document.querySelector('#body')?.value,
    error: document.querySelector('#error')?.textContent
  }));
  const store = path.join(userData, 'notes.json');
  const observation = {label, at: new Date().toISOString(), dom,
    persistedRaw: fs.existsSync(store) ? fs.readFileSync(store, 'utf8') : null};
  report.observations.push(observation);
  flush();
  await page.screenshot({path: path.join(out, `${String(report.observations.length).padStart(2, '0')}-${label}.png`)});
  return observation;
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await observe('timeout');
  throw new Error(`Timed out after 5 seconds: ${label}`);
}
const row = note => page.locator('#notes').getByRole('button', {name: note.title, exact: true});
async function selectAndRead(note, expectedNotes, label) {
  await row(note).click();
  await until(async () =>
    await page.locator('#title').inputValue() === note.title &&
    await page.locator('#body').inputValue() === note.body, `${label}: full selected text`);
  const state = await observe(label);
  check(`${label}: exact title and entire body belong to selected note`, () => {
    assert.equal(state.dom.title, note.title);
    assert.equal(state.dom.body, note.body);
  });
  check(`${label}: all saved notes remain separately selectable`, () => {
    assert.deepEqual(state.dom.rows.map(n => n.title).sort(), expectedNotes.map(n => n.title).sort());
  });
  for (const item of expectedNotes) assert.ok(await row(item).isVisible(), `Visible list entry: ${item.title}`);
}
async function createAndSave(note, expectedNotes, label) {
  await page.locator('#new').click();
  await page.locator('#title').fill(note.title);
  await page.locator('#body').fill(note.body);
  await observe(`${label}-before-save`);
  await page.locator('#save').click();
  await until(async () => await page.locator('#notes button').count() === expectedNotes.length &&
    await row(note).count() === 1, `${label}: saved list entry`);
  await selectAndRead(note, expectedNotes, `${label}-saved-and-selected`);
}
try {
  app = await electron.launch({
    args: ['.', '--user-data-dir', userData], cwd: appRoot, timeout: 10000,
    executablePath: path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    artifactsDir: path.join(out, 'playwright-artifacts'), chromiumSandbox: true,
    env: {...process.env, NODE_V8_COVERAGE: process.env.NATIVE_COVERAGE_DIR || process.env.NODE_V8_COVERAGE}
  });
  // Save the native handle while Playwright's application object is still live.
  electronProcess = app.process();
  report.electronPid = electronProcess.pid;
  page = await app.firstWindow({timeout: 10000});
  page.setDefaultTimeout(5000);
  report.initialWindow = {url: page.url(), html: await page.content()};
  flush();
  if (page.url() === 'about:blank') await page.waitForURL(url => url.protocol === 'file:', {timeout: 5000});
  await page.waitForLoadState('domcontentloaded', {timeout: 5000});
  // Observe the current page before choosing its controls; retain unexpected states.
  await observe('initial-dom');
  await page.locator('#new').waitFor({state: 'visible', timeout: 5000});
  await page.coverage.startJSCoverage({resetOnNavigation: false});
  coverageStarted = true;
  await page.reload();
  await observe('after-coverage-reload');
  await page.locator('#new').waitFor({state: 'visible', timeout: 5000});
  check('Fresh user directory starts with no notes', () =>
    assert.equal(report.observations.at(-1).dom.rows.length, 0));
  report.status = 'running';
  report.businessExecution = 'started';
  await createAndSave(notes[0], [notes[0]], 'create-a');
  await createAndSave(notes[1], notes, 'create-b');
  for (const [index, note] of [notes[0], notes[1], notes[0], notes[1]].entries()) {
    await selectAndRead(note, notes, `roundtrip-${index + 1}`);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = {name: error.name, message: error.message, stack: error.stack};
  if (page && !page.isClosed()) {
    try { await observe('failure'); } catch (e) { report.diagnosticError = String(e); }
  }
  process.exitCode = 1;
} finally {
  if (coverageStarted) {
    try { fs.writeFileSync(path.join(out, 'renderer.json'), JSON.stringify(await page.coverage.stopJSCoverage())); }
    catch (error) {
      report.coverageError = errorDetails(error);
      report.status = 'failed';
      process.exitCode = 1;
    }
  }
  if (app) {
    try { await app.close(); }
    catch (error) {
      report.closeError = errorDetails(error);
      report.status = 'failed';
      process.exitCode = 1;
    }
    if (electronProcess) {
      try { await recordElectronExit(electronProcess); }
      catch (error) {
        report.processExitError = errorDetails(error);
        report.electronExitCode = electronProcess.exitCode;
        report.electronSignalCode = electronProcess.signalCode;
        report.electronProcessExited = electronProcess.exitCode !== null || electronProcess.signalCode !== null;
        report.status = 'failed';
        process.exitCode = 1;
      }
    }
  }
  flush();
  console.log(JSON.stringify({status: report.status, checks: report.checks.length,
    failure: report.failure?.message, evidence: path.join(out, 'observations.json')}));
}
