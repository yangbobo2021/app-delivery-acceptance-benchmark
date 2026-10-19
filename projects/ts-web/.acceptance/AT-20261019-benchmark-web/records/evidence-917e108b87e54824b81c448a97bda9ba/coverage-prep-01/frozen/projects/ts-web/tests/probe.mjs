import {withApp} from './browser-fixture.mjs';

// Toolchain probe: open the real app and retain native browser/Node coverage.
// No business outcome is classified here.
await withApp(async ({observe}) => { await observe('loaded'); });
console.log('PREPARATION_PROBE_OK');
