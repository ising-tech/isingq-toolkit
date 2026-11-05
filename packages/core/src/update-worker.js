'use strict';

// The long-lived MCP/DSH adapters use inline mode. Only real Node package
// entrypoints launch this file, so SEA builds need no worker file beside them.
const { runUpdateWorker } = require('./background-updates');
const lifetime = setTimeout(() => process.exit(0), 5000);
Promise.resolve().then(() => runUpdateWorker(process.argv[2])).catch(() => {}).finally(() => {
  clearTimeout(lifetime);
  process.exit(0);
});
