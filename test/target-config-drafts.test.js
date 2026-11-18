'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { fork } = require('node:child_process');
const { ManagerDraftStore, DRAFT_TTL_MS, MAX_DRAFTS, MAX_TOMBSTONES } = require('../packages/core/src/target-config-drafts');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { openTargetConfig } = require('../packages/core/src/target-config-page');
const id = n => n.toString(16).padStart(32, '0');
const value = (n = 1, generation = 1) => ({ id: id(n), generation, mode: 'add', profile_id: null, profile_revision: null, values: { name: '未完成的连接', api_base_url: 'http://incomplete:', web_base_url: '', contract_text: '{invalid JSON kept as text' } });
function setup(t, options = {}) { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-drafts-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); const profileStore = new SolverProfileStore({ XDG_CONFIG_HOME: directory }); return { directory, profileStore, store: new ManagerDraftStore({ configFile: profileStore.file, ...options }) }; }
async function page(t, profileStore, options = {}) { const session = await openTargetConfig({ profileStore, idleTimeoutMs: 10000, ...options }); t.after(session.close); const u = new URL(session.url); return { session, origin: u.origin, port: Number(u.port), headers: { Origin: u.origin, 'Content-Type': 'application/json', 'X-Config-Token': u.hash.slice(1) } }; }
const post = (h, route, body) => fetch(h.origin + route, { method: 'POST', headers: h.headers, body: JSON.stringify(body) });
const del = (h, draftId, generation) => fetch(h.origin + '/api/drafts/' + draftId, { method: 'DELETE', headers: h.headers, body: JSON.stringify({ generation }) });
const rebind = port => new Promise(resolve => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

test('drafts default to24h/10 and preserve incomplete text without modifying saved connections', t => {
  const { store, profileStore } = setup(t); assert.equal(DRAFT_TTL_MS, 86400000); assert.equal(MAX_DRAFTS, 10); assert.equal(MAX_TOMBSTONES, 100);
  const result = store.save(value()); assert.equal(result.draft.values.contract_text, value().values.contract_text); assert.equal(Date.parse(result.draft.expires_at) - Date.parse(result.draft.updated_at), DRAFT_TTL_MS);
  const list = store.list(); assert.equal(list.drafts[0].name, value().values.name); assert.equal(Object.hasOwn(list.drafts[0], 'values'), false);
  assert.equal(fs.existsSync(profileStore.file), false); assert.deepEqual(profileStore.list(), []);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(store.file).mode & 0o077, 0); assert.equal(fs.statSync(store.directory).mode & 0o077, 0); }
});

test('draft transaction releases its owned lock even when closing the descriptor fails', t => {
  const { store } = setup(t);
  const descriptors = new Set();
  const originalOpen = fs.openSync, originalClose = fs.closeSync;
  fs.openSync = function(filename, ...args) {
    const fd = originalOpen.call(this, filename, ...args);
    if (String(filename) === store.lock) descriptors.add(fd);
    return fd;
  };
  fs.closeSync = function(fd) {
    if (descriptors.has(fd)) {
      descriptors.delete(fd);
      originalClose.call(this, fd);
      throw Object.assign(Error('synthetic lock close failure'), { code: 'EIO' });
    }
    return originalClose.call(this, fd);
  };
  try { assert.throws(() => store.list(), { code: 'EIO' }); }
  finally { fs.openSync = originalOpen; fs.closeSync = originalClose; }
  assert.equal(fs.existsSync(store.lock), false);
});

test('generation is monotone, same generation is idempotent only for identical contents', t => {
  let now = 1; const { store } = setup(t, { clock: () => now }); const saved = store.save(value()).draft; now = 100;
  assert.deepEqual(store.save(value()).draft, saved); assert.throws(() => store.save({ ...value(), values: { ...value().values, name: 'same generation changed' } }), e => e.code === 'draft_generation_conflict');
  store.save(value(1, 3)); assert.throws(() => store.save(value(1, 2)), e => e.code === 'draft_generation_conflict'); assert.equal(store.get(id(1)).draft.generation, 3);
});

test('cancel/save deletion tombstones prevent late saves of every generation from resurrecting a cleared context', t => {
  const { store } = setup(t); store.save(value()); assert.deepEqual(store.delete(id(1), { generation: 2 }), { deleted: true, id: id(1), generation: 2 });
  for (const generation of [1, 2, 100]) assert.throws(() => store.save(value(1, generation)), e => e.code === 'draft_deleted');
  assert.deepEqual(store.delete(id(1), { generation: 2 }), { deleted: true, id: id(1), generation: 2 }); assert.equal(store.delete(id(1), { generation: 3 }).generation, 3);
  assert.throws(() => store.delete(id(1), { generation: 1 }), e => e.code === 'draft_generation_conflict'); assert.deepEqual(store.list().drafts, []);
});

test('restoring to a new id is independent; deleting a stale source generation cannot erase another tabs newer edit', t => {
  const { store } = setup(t); store.save(value()); store.save(value(1, 2)); store.save({ ...value(2), values: { ...value().values, name: 'restored copy' } });
  assert.throws(() => store.delete(id(1), { generation: 1 }), e => e.code === 'draft_generation_conflict'); assert.equal(store.get(id(1)).draft.generation, 2);
  store.delete(id(2), { generation: 1 }); assert.equal(store.get(id(1)).draft.generation, 2);
});

test('expired drafts are not listed/recovered and retain bounded late-write protection', t => {
  let now = 1; const { store } = setup(t, { clock: () => now, ttlMs: 100 }); store.save(value()); now = 102;
  assert.deepEqual(store.list().drafts, []); assert.throws(() => store.get(id(1)), e => e.status === 404); assert.throws(() => store.save(value(1, 2)), e => e.code === 'draft_deleted');
  now = 203; assert.equal(store.save(value(1, 3)).draft.generation, 3);
});

test('draft and tombstone quotas fail honestly without discarding another draft or replay protection', t => {
  const { store } = setup(t, { maxDrafts: 2, maxTombstones: 2 }); store.save(value(1)); store.save(value(2)); assert.throws(() => store.save(value(3)), e => e.code === 'draft_capacity');
  store.delete(id(1), { generation: 1 }); store.delete(id(2), { generation: 1 }); assert.throws(() => store.delete(id(3), { generation: 1 }), e => e.code === 'draft_tombstone_capacity');
  assert.throws(() => store.save(value(1, 10)), e => e.code === 'draft_deleted'); assert.equal(store.save(value(3)).draft.id, id(3));
});

test('unknown/token fields, excessive text and invalid identity/mode never become backups', t => {
  const { store } = setup(t);
  for (const invalid of [{ ...value(), token: 'never-store-session-token' }, { ...value(), generation: 0 }, { ...value(), id: 'draft_' + id(1) }, { ...value(), mode: 'edit' }, { ...value(), values: { ...value().values, secret: 'not allowed' } }, { ...value(), values: { ...value().values, contract_text: 'x'.repeat(32769) } }]) assert.throws(() => store.save(invalid), e => e.status === 400 || e.status === 413);
  assert.equal(fs.existsSync(store.file), false);
});

test('corruption and unsafe permissions never turn into an empty list or overwrite evidence', t => {
  const { store } = setup(t); store.save(value()); fs.writeFileSync(store.file, '{broken'); const before = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.list(), e => e.code === 'draft_store_invalid'); assert.throws(() => store.save(value(2)), e => e.code === 'draft_store_invalid'); assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  fs.unlinkSync(store.file); store.save(value()); if (process.platform !== 'win32') { fs.chmodSync(store.file, 0o644); assert.throws(() => store.list(), e => e.code === 'draft_store_unsafe'); fs.chmodSync(store.file, 0o600); }
});

test('write failure is explicit not-backed-up and does not pretend a successful draft acknowledgment', t => {
  const { store } = setup(t); store.write = () => { throw Object.assign(new Error('private diagnostic ignored'), { code: 'EACCES' }); };
  assert.throws(() => store.save(value()), e => e.status === 500 && e.code === 'draft_store_io_error' && /未备份/.test(e.message) && !e.message.includes('private diagnostic'));
  assert.equal(fs.existsSync(store.file), false); assert.equal(fs.existsSync(store.lock), false);
});

test('private drafts are discoverable across a genuinely new server port after the old server is reclaimed', { timeout: 2500 }, async t => {
  const { profileStore } = setup(t); const first = await page(t, profileStore); const saved = await post(first, '/api/drafts', value()); assert.equal(saved.status, 200);
  assert.equal((await fetch(first.origin + '/api/drafts')).status, 403); await first.session.close(); assert.equal(await rebind(first.port), true);
  const held = net.createServer(); await new Promise(resolve => held.listen(first.port, '127.0.0.1', resolve)); t.after(() => held.close());
  const second = await page(t, profileStore); assert.notEqual(second.port, first.port);
  const list = await (await fetch(second.origin + '/api/drafts', { headers: second.headers })).json(); assert.equal(list.drafts.length, 1); assert.equal(Object.hasOwn(list.drafts[0], 'values'), false);
  const restored = await (await fetch(second.origin + '/api/drafts/' + id(1), { headers: second.headers })).json(); assert.deepEqual(restored.draft.values, value().values);
  assert.equal((await del(second, id(1), 2)).status, 200); const late = await post(second, '/api/drafts', value(1, 3)); assert.equal(late.status, 409); assert.equal((await late.json()).code, 'draft_deleted');
  assert.equal(fs.existsSync(profileStore.file), false);
});

test('two independent processes serialize private draft writes without losing distinct ids', { timeout: 5000 }, async t => {
  const { store, profileStore } = setup(t); const modulePath = require.resolve('../packages/core/src/target-config-drafts'); const children = [];
  const program = `const {ManagerDraftStore}=require(${JSON.stringify(modulePath)});const store=new ManagerDraftStore({configFile:${JSON.stringify(profileStore.file)}});process.send('ready');process.once('message',async n=>{for(let retry=0;retry<30;retry++){try{store.save({id:String(n).padStart(32,'0'),generation:1,mode:'add',profile_id:null,profile_revision:null,values:{name:'isolated draft',api_base_url:'',web_base_url:'',contract_text:''}});process.send('saved');process.disconnect();return}catch(e){if(e.code!=='draft_store_busy'){process.send({error:e.code});process.disconnect();process.exitCode=1;return}await new Promise(r=>setTimeout(r,5))}}process.exit(1)});`;
  const states = await Promise.all([1, 2].map(n => new Promise((resolve, reject) => {
    const child = fork('-e', [program], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] }); children.push(child); let saved = false;
    child.on('message', msg => { if (msg === 'ready') child.send(n); else if (msg === 'saved') saved = true; else reject(new Error('draft child failed: ' + msg.error)); });
    child.on('error', reject); child.on('exit', code => code === 0 && saved ? resolve(true) : reject(new Error('draft writer exit=' + code)));
  })));
  t.after(() => { for (const child of children) if (child.exitCode === null && !child.signalCode) child.kill(); });
  assert.ok(states.every(Boolean)); assert.deepEqual(store.list().drafts.map(row => row.id).sort(), [id(1), id(2)]);
});
