import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
assert.ok(process.env.ACCEPTANCE_CASE_ROOT, 'ACCEPTANCE_CASE_ROOT must be bound by the execution entry');
assert.ok(process.env.UI_EVIDENCE_DIR, 'UI_EVIDENCE_DIR must be bound by the execution entry');
const out = path.resolve(process.env.UI_EVIDENCE_DIR);
fs.mkdirSync(out, {recursive: true});
const userData = fs.mkdtempSync(path.join(process.env.ACCEPTANCE_CASE_ROOT, 'note-01-s05-user-'));
const storePath = path.join(userData, 'notes.json');
const title = '同标题独立管理';
const firstBody = '甲：第一条原始正文\n只属于甲。';
const secondBody = '乙：第二条原始正文\n只属于乙。';
const firstEdit = '甲：已经修改\n甲专属内容 🐱';
const secondEdit = '乙：已经修改\n乙专属内容 🐶';
const report = {
  scene: 'NOTE-01-S05', userData, storePath,
  coverageChecklist: [
    'Two legally saved notes with identical titles, different bodies, and different IDs coexist',
    'Editing each body retains both IDs and titles and leaves the other body unchanged',
    'Deleting the first note leaves the second selectable with its original ID, title, and edited body'
  ],
  observations: [], checks: [], status: 'starting',
  businessExecution: 'not_started'
};
// Persist the checklist even if the automation driver aborts during launch.
fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(report, null, 2));
// A driver launch rejection can become fatal before launch() reaches our catch.
// Retain the original error without intercepting it or changing the exit status.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  report.status = 'failed';
  report.fatalDriverError = {origin, name: error.name, message: error.message, stack: error.stack};
  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(report, null, 2));
});
let app, page, coverageStarted = false;
const readStore = () => fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : [];
const sorted = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
function check(label, fn) {
  try { fn(); report.checks.push({label, passed: true}); }
  catch (e) { report.checks.push({label, passed: false, message: e.message}); throw e; }
}
async function observe(label) {
  const dom = await page.evaluate(() => ({
    html: document.body.outerHTML,
    rows: [...document.querySelectorAll('#notes button')].map(b => ({id: b.dataset.id, title: b.textContent})),
    title: document.querySelector('#title')?.value,
    body: document.querySelector('#body')?.value,
    error: document.querySelector('#error')?.textContent
  }));
  const state = {label, at: new Date().toISOString(), persisted: readStore(), dom};
  report.observations.push(state);
  await page.screenshot({path: path.join(out, `${String(report.observations.length).padStart(2, '0')}-${label}.png`)});
  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(report, null, 2));
  return state;
}
async function until(predicate, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await observe('timeout');
  throw new Error(`Timed out after 5 seconds: ${label}`);
}
const row = id => page.locator(`#notes button[data-id="${id}"]`);
async function assertRecords(label, expected) {
  await until(async () => {
    const domIds = await page.locator('#notes button').evaluateAll(bs => bs.map(b => b.dataset.id));
    return JSON.stringify(domIds) === JSON.stringify(readStore().map(n => n.id));
  }, `${label}: list refresh`);
  const state = await observe(label);
  check(`${label}: exact persisted IDs, titles and bodies`, () => assert.deepEqual(sorted(state.persisted), sorted(expected)));
  check(`${label}: visible list has exactly the expected identities and titles`, () => {
    assert.deepEqual(sorted(state.dom.rows), sorted(expected.map(({id, title}) => ({id, title}))));
    assert.equal(state.dom.error, '');
  });
  for (const note of expected) {
    await row(note.id).click();
    const selected = await observe(`${label}-select-${note.id}`);
    check(`${label}: selecting ${note.id} returns its own full text`, () => {
      assert.equal(selected.dom.title, note.title);
      assert.equal(selected.dom.body, note.body);
      assert.equal(selected.dom.error, '');
    });
  }
}
async function saveNew(body, previousIds) {
  await page.locator('#new').click();
  await page.locator('#title').fill(title);
  await page.locator('#body').fill(body);
  await page.locator('#save').click();
  await until(() => readStore().some(n => !previousIds.includes(n.id) && n.title === title && n.body === body), 'new note persisted');
  const created = readStore().filter(n => !previousIds.includes(n.id));
  check('New save allocates exactly one independent nonempty ID', () => {
    assert.equal(created.length, 1);
    assert.equal(typeof created[0].id, 'string');
    assert.ok(created[0].id.length > 0);
  });
  return created[0];
}
async function edit(note, body) {
  await row(note.id).click();
  assert.equal(await page.locator('#title').inputValue(), title);
  await page.locator('#body').fill(body);
  await page.locator('#save').click();
  await until(() => readStore().some(n => n.id === note.id && n.body === body), 'edited note persisted with unchanged ID');
  return {...note, body};
}
try {
  app = await electron.launch({
    args: ['.', '--user-data-dir', userData], cwd: appRoot,
    timeout: 10000,
    // Match the actual Electron executable used by the successful preparation probe.
    executablePath: path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    artifactsDir: path.join(out, 'playwright-artifacts'),
    chromiumSandbox: true,
    env: {...process.env, NODE_V8_COVERAGE: process.env.NATIVE_COVERAGE_DIR || process.env.NODE_V8_COVERAGE}
  });
  page = await app.firstWindow({timeout: 10000});
  page.setDefaultTimeout(5000);
  // Inspect the current window before choosing controls. Electron may first
  // expose about:blank while the application's file navigation is pending.
  report.initialWindow = {url: page.url()};
  if (page.url() === 'about:blank') {
    await page.waitForURL(url => url.protocol === 'file:', {timeout: 5000});
  }
  await page.waitForLoadState('domcontentloaded', {timeout: 5000});
  report.initialWindow = {url: page.url(), html: await page.content()};
  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(report, null, 2));
  await observe('initial-dom');
  await page.locator('#new').waitFor({state: 'visible', timeout: 5000});
  report.status = 'running';
  report.businessExecution = 'started';
  await page.coverage.startJSCoverage({resetOnNavigation: false});
  coverageStarted = true;
  await page.reload();
  await page.locator('#new').waitFor({state: 'visible', timeout: 5000});
  await until(async () => await page.locator('#notes button').count() === 0, 'fresh empty list');
  check('Fresh isolated state', () => assert.deepEqual(readStore(), []));
  let first = await saveNew(firstBody, []);
  await assertRecords('first-created', [first]);
  let second = await saveNew(secondBody, [first.id]);
  check('Identical titles have distinct IDs', () => assert.notEqual(first.id, second.id));
  await assertRecords('two-created', [first, second]);
  first = await edit(first, firstEdit);
  await assertRecords('first-edited', [first, second]);
  second = await edit(second, secondEdit);
  await assertRecords('second-edited', [first, second]);
  await row(first.id).click();
  await observe('before-delete');
  await page.locator('#delete').click();
  await until(() => !readStore().some(n => n.id === first.id), 'selected note deleted');
  await assertRecords('after-delete', [second]);
  report.status = 'passed';
} catch (e) {
  report.status = 'failed';
  report.failure = {name: e.name, message: e.message, stack: e.stack};
  if (page && !page.isClosed()) {
    try { await observe('failure'); } catch (diagnosticError) { report.diagnosticError = String(diagnosticError); }
  }
  process.exitCode = 1;
} finally {
  if (coverageStarted) {
    try { fs.writeFileSync(path.join(out, 'renderer.json'), JSON.stringify(await page.coverage.stopJSCoverage())); }
    catch (e) { report.coverageError = String(e); process.exitCode = 1; }
  }
  if (app) {
    try { await app.close(); report.electronExitCode = app.process().exitCode; }
    catch (e) { report.closeError = String(e); process.exitCode = 1; }
  }
  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(report, null, 2));
  console.log(`EVIDENCE_DIR=${out}`);
  console.log(JSON.stringify({status: report.status, checks: report.checks, failure: report.failure?.message, evidence: path.join(out, 'observations.json')}));
}
