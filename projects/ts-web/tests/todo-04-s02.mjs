import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {withApp} from './browser-fixture.mjs';

// Coverage checklist: mixed tasks under All, Active, Completed; two active
// tasks under Completed with an empty visible list. Expectations come from
// the scenario and the UI actions below, not from the app's count logic.
const checks = [];
await withApp(async ({page, observe}) => {
  page.setDefaultTimeout(5000);
  await observe('initial-dom');
  const title = page.getByRole('textbox', {name: 'Title', exact: true});
  await title.waitFor({state: 'visible', timeout: 5000});
  const add = page.getByRole('button', {name: 'Add', exact: true});
  const all = page.getByRole('button', {name: 'All', exact: true});
  const active = page.getByRole('button', {name: 'Active', exact: true});
  const completed = page.getByRole('button', {name: 'Completed', exact: true});
  const first = {title: 'S02 unfinished alpha', done: false};
  const second = {title: 'S02 unfinished beta', done: false};
  const done = {title: 'S02 finished gamma', done: true};
  async function capture(label, expectedRows) {
    const observed = await observe(label);
    const actualRows = observed.rows.map(({title, done}) => ({title, done}));
    // Ignore ordering: sorting is explicitly outside the acceptance contract.
    const sorted = rows => [...rows].sort((a, b) => a.title.localeCompare(b.title));
    for (const [criterion, actual, expected] of [
      ['visible task identities and completion states', sorted(actualRows), sorted(expectedRows)],
      ['global unfinished total', observed.remaining, '2'],
    ]) {
      let failure = null;
      try { assert.deepEqual(actual, expected); } catch (error) { failure = error.message; }
      checks.push({label, criterion, actual, expected, passed: failure === null, failure});
    }
    await fs.writeFile(path.join(process.env.ACCEPTANCE_EVIDENCE_DIR, 'checks.json'), JSON.stringify(checks, null, 2));
  }
  try {
    assert.equal(await page.locator('#tasks li').count(), 0, 'fresh context must start empty');
    for (const item of [first, second, done]) {
      await title.fill(item.title);
      await add.click();
    }
    await page.getByRole('checkbox', {name: 'Complete ' + done.title, exact: true}).check();
    await all.click();
    await capture('mixed-all', [first, second, done]);
    await active.click();
    await capture('mixed-active', [first, second]);
    await completed.click();
    await capture('mixed-completed', [done]);
    await all.click();
    await capture('mixed-return-all', [first, second, done]);
    const finishedRow = page.locator('#tasks li').filter({has: page.getByRole('checkbox', {name: 'Complete ' + done.title, exact: true})});
    await finishedRow.getByRole('button', {name: 'Delete', exact: true}).click();
    await capture('two-active-all', [first, second]);
    await completed.click();
    await capture('two-active-completed-empty', []);
    await all.click();
    await capture('two-active-return-all', [first, second]);
    assert.deepEqual(checks.filter(check => !check.passed).map(({label, criterion, actual, expected}) => ({label, criterion, actual, expected})), [], 'scenario criteria failed');
  } catch (error) {
    await observe('failure-context');
    throw error;
  }
});
console.log('TODO-04-S02 passed');
