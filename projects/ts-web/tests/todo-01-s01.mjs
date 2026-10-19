import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {withApp} from './browser-fixture.mjs';

// Scenario checklist: add to an empty list under All; then add to an
// existing list containing both unfinished and completed tasks, preserving
// every existing task and its completion state. Sorting is out of scope.
const checks = [];
await withApp(async ({page, observe}) => {
  page.setDefaultTimeout(5000);
  async function verify(label, actual, expected) {
    let failure = null;
    try { assert.deepEqual(actual, expected); } catch (error) { failure = error.message; }
    checks.push({label, actual, expected, passed: failure === null, failure});
    await fs.writeFile(path.join(process.env.ACCEPTANCE_EVIDENCE_DIR, 'checks.json'), JSON.stringify(checks, null, 2));
    assert.equal(failure, null, label + ': ' + failure);
  }
  const sorted = rows => [...rows].sort((a, b) => a.title.localeCompare(b.title));
  const content = rows => sorted(rows.map(({title, done}) => ({title, done})));
  // Titles come from the fixed inputs. Only explicitly established existing
  // states are asserted: TODO-01 does not specify a new task's default state.
  async function expectRows(label, titles, existing = []) {
    const observed = await observe(label);
    await verify(label + ': task count', observed.rows.length, titles.length);
    await verify(label + ': complete task titles',
      observed.rows.map(row => row.title).sort(), [...titles].sort());
    for (const title of titles) {
      await verify(label + ': visible title ' + title,
        await page.locator('#tasks').getByText(title, {exact: true}).isVisible(), true);
    }
    if (existing.length) {
      await verify(label + ': established task states remain unchanged',
        content(observed.rows.filter(row => existing.some(item => item.title === row.title))), content(existing));
    }
    return observed;
  }
  try {
    const initial = await observe('initial-dom');
    await verify('isolated context starts with no tasks', initial.rows, []);
    // Choose controls only after recording the current page and list state.
    const input = page.getByRole('textbox', {name: 'Title', exact: true});
    await input.waitFor({state: 'visible', timeout: 5000});
    const add = page.getByRole('button', {name: 'Add', exact: true});
    await page.getByRole('button', {name: 'All', exact: true}).click();
    await input.fill('买牛奶');
    await add.click();
    const unfinished = {title: '买牛奶', done: false};
    const completed = {title: '整理书架', done: true};
    const addedTitle = 'Call Alex';
    await expectRows('added-to-empty', [unfinished.title]);
    // Establish the unfinished baseline by an explicit UI operation, without
    // relying on the state chosen by the product when the task was added.
    await page.getByRole('checkbox', {name: 'Complete ' + unfinished.title, exact: true}).uncheck();
    const unfinishedBaseline = await expectRows('unfinished-existing-baseline', [unfinished.title], [unfinished]);

    await input.fill(completed.title);
    await add.click();
    await expectRows('added-to-existing-unfinished', [unfinished.title, completed.title], unfinishedBaseline.rows);
    const checkbox = page.getByRole('checkbox', {name: 'Complete ' + completed.title, exact: true});
    await checkbox.waitFor({state: 'visible', timeout: 5000});
    await checkbox.check();
    const before = await expectRows('mixed-existing-baseline', [unfinished.title, completed.title], [unfinished, completed]);

    await input.fill(addedTitle);
    await add.click();
    const after = await expectRows('added-to-existing-mixed', [unfinished.title, completed.title, addedTitle]);
    await verify('all preexisting task titles and completion states remain unchanged',
      content(after.rows.filter(row => row.title !== addedTitle)), content(before.rows));
  } catch (error) {
    await observe('failure-context');
    throw error;
  }
});
console.log('TODO-01-S01 passed');
