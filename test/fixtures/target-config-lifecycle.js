'use strict';
// Fault injectors run only with explicit modes, never on test discovery/import.
if (process.argv[2] === 'manager-never-ready') {
  const fs = require('node:fs'), http = require('node:http');
  process.on('SIGTERM', () => {});
  const server = http.createServer((_, response) => response.end('fixture-only'));
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, port: server.address().port }), { mode: 0o600 }));
} else if (process.argv[2] === 'manager-delayed') {
  const fs = require('node:fs');
  const report = process.argv[3], delay = Number(process.argv[4]), args = process.argv.slice(5);
  setTimeout(async () => {
    const session = await require('../../packages/core/src/target-config-page').serveTargetConfigSidecar(args);
    fs.writeFileSync(report, JSON.stringify({ pid: process.pid, listening: Boolean(session) }), { mode: 0o600 });
  }, delay);
} else if (process.argv[2] === 'manager-registration-failure') {
  const fs = require('node:fs');
  const lifecycle = require('../../packages/core/src/target-config-lifecycle');
  const page = require('../../packages/core/src/target-config-page'); // Freeze shipped identity before fault injection.
  const report = process.argv[3];
  lifecycle.publishSession = (_location, _claim, session) => {
    fs.writeFileSync(report, JSON.stringify({ pid: process.pid, port: Number(new URL(session.url).port), injected_error: 'EACCES', stage: 'publish_after_listen' }), { mode: 0o600 });
    throw Object.assign(new Error('isolated registration write denied'), { code: 'EACCES' });
  };
  page.serveTargetConfigSidecar(process.argv.slice(4));
} else if (process.argv[2] === 'manager-external-listener') {
  const http = require('node:http');
  const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(request.url === '/health' ? '{"alive":true}' : '{}'); });
  server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
}
