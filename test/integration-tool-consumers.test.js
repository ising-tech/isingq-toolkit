'use strict';
process.env.ISINGQ_UPDATE_CHECK = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const NORMAL = ['isingq_api_key_setup', 'isingq_knowledge_get', 'isingq_modeling_guide_get', 'isingq_solve'];
const NATIVE = ['isingq_api_key_setup', 'isingq_delivery_validate', 'isingq_knowledge_get', 'isingq_modeling_guide_get', 'isingq_qubo_validate', 'isingq_report_verify', 'isingq_resource_list', 'isingq_resource_read', 'isingq_solve_poll', 'isingq_solve_result_get', 'isingq_solve_start', 'isingq_update_check', 'isingq_solver_targets_list', 'isingq_target_solve_prepare', 'isingq_target_solve_start', 'isingq_solver_profiles_list', 'isingq_solver_profiles_save', 'isingq_solver_profiles_delete', 'isingq_solver_config_open', 'isingq_solve_records_list', 'isingq_target_delivery_validate'].sort();
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-consumers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function smoke(binary, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/smoke-binary.js'), binary, ...args], { cwd: root, env: { ...process.env, ISINGQ_UPDATE_CHECK: 'off' }, encoding: 'utf8', timeout: 35000 });
}
test('release smoke exercises real Node source in normal and explicit technical profiles', t => {
  const dir = temporary(t);
  const binary = path.join(root, 'bin/isingq-mcp.js');
  for (const args of [[], ['--technical']]) {
    const result = smoke(binary, args);
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, args.length ? /profile=technical, tools=20/ : /profile=normal, tools=4/);
  }
  if (process.platform !== 'win32') {
    const wrapper = path.join(dir, 'executable');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${binary.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
    assert.equal(smoke(wrapper).status, 0, 'executable path must remain supported');
  }
});
test('release smoke rejects wrong names even when tool count matches the selected profile', t => {
  const dir = temporary(t), fake = path.join(dir, 'fake.js');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst input = require('node:fs').readFileSync(0,'utf8');\nfor(const line of input.trim().split('\\n')) {const r=JSON.parse(line);if(!r.id)continue; const result = r.method==='initialize' ? {serverInfo:{name:'isingq-mcp'}} : r.method==='tools/list' ? {tools:${JSON.stringify(NORMAL.map((name, i) => ({ name: i ? name : 'isingq_wrong', outputSchema: { type: 'object' } })))}} : {resources:Array(13).fill({})};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));}`);
  fs.chmodSync(fake, 0o700);
  const result = smoke(fake); assert.equal(result.status, 1); assert.match(result.stderr, /isingq_wrong/);
});
test('actual native adapter reaches inspector ready and verified only for exact current names', async t => {
  const dir = temporary(t);
  const previous = Object.fromEntries(['VERIFY_OUT','VERIFY_BOOT_ID','VERIFY_PLUGIN_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), VERIFY_PLUGIN_DIR: path.join(root, 'packages/dsh-plugin') });
  t.after(() => { for (const [k,v] of Object.entries(previous)) { if(v === undefined) delete process.env[k]; else process.env[k]=v; } });
  const adapter = await import('../packages/dsh-plugin/index.mjs');
  const inspector = await import('../scripts/dsh-verify-inspector/index.mjs');
  const registered = new Map(); adapter.apply({ tools: { register: tool => registered.set(tool.name,tool) } }, { backgroundUpdates: null });
  assert.deepEqual([...registered.keys()].sort(), NATIVE);
  for (const mutation of ['exact','missing','extra','renamed']) {
    const out = path.join(dir, mutation); Object.assign(process.env, { VERIFY_OUT: out, VERIFY_BOOT_ID: mutation });
    const visible = new Map(registered);
    if (mutation === 'missing' || mutation === 'renamed') visible.delete('isingq_target_solve_prepare');
    if (mutation === 'extra' || mutation === 'renamed') visible.set('isingq_unexpected', {});
    const events = new Map(), before = process.listeners('exit');
    inspector.apply({ tools: { view: () => ({visible}) }, on: (name,fn) => events.set(name,fn), effect: () => {} });
    events.get('ready')();
    for (let i=0;i<10 && !fs.existsSync(path.join(out,`snapshot-verified-${mutation}.json`));i++) await new Promise(setImmediate);
    events.get('dispose')();
    for (const listener of process.listeners('exit')) if (!before.includes(listener)) process.removeListener('exit',listener);
    const ready = path.join(out,`snapshot-ready-${mutation}.json`), verified = path.join(out,`snapshot-verified-${mutation}.json`);
    assert.equal(fs.existsSync(ready), mutation === 'exact', mutation);
    assert.equal(fs.existsSync(verified), mutation === 'exact', mutation);
    if (mutation === 'exact') { const value=JSON.parse(fs.readFileSync(verified)); assert.equal(value.passed,true); assert.deepEqual(value.expected_tools,NATIVE); }
    else assert.equal(JSON.parse(fs.readFileSync(path.join(out,`snapshot-first-tools-${mutation}.json`))).tools_match,false);
    const snapshot=JSON.parse(fs.readFileSync(path.join(out,`snapshot-first-tools-${mutation}.json`)));
    t.diagnostic(JSON.stringify({case:mutation,registered_count:registered.size,observed_count:snapshot.isingq_tools.length,expected_count:snapshot.expected_tools.length,tools_match:snapshot.tools_match,ready:fs.existsSync(ready),verified:fs.existsSync(verified)}));
  }
});
