const v8 = require('node:v8');
process.on('SIGTERM', () => { v8.takeCoverage(); process.exit(0); });
