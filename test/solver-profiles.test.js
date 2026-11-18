'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { SolverProfileStore } = require('../packages/core/src/solver-profiles');
const { SolverService } = require('../packages/core/src');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new SolverProfileStore({ XDG_CONFIG_HOME: dir }); }
const input = { name: '研发室', api_base_url: 'http://localhost:8080/proxy/', web_base_url: 'https://viewer.example.test/device' };
test('public profile saves require the current positive safe revision to update an existing connection', t => {
  const store = fixture(t);
  const service = new SolverService({ store: {}, targetOptions: { profileStore: store } });
  const original = service.profileSave(input);
  assert.equal(original.revision, 1);
  const latest = service.profileSave({ ...original, name: '另一客户端已更新' });
  const edited = { ...input, id: original.id, name: '旧编辑' };
  assert.throws(() => service.profileSave(edited), { code: 'profile_revision_invalid' });
  const inheritedRevision = Object.assign(Object.create({ revision: latest.revision }), edited);
  assert.throws(() => service.profileSave(inheritedRevision), { code: 'profile_revision_invalid' });
  for (const revision of [null, 0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => service.profileSave({ ...edited, revision }), { code: 'profile_revision_invalid' });
  }
  assert.throws(() => service.profileSave({ ...edited, revision: original.revision }), { code: 'profile_revision_conflict' });
  assert.deepEqual(service.profileList(), [latest]);
});
test('profiles support zero/multiple CRUD, stable identity, revision and shared environment without submission', t => { const store = fixture(t); assert.deepEqual(store.list(), []); const a = store.save(input), b = store.save({ ...input, name: '设备B' }); assert.notEqual(a.id, b.id); assert.equal(a.api_base_url, 'http://localhost:8080/proxy'); const edited = store.save({ ...a, name: '新名称', api_base_url: 'http://localhost:9090/new' }); assert.equal(edited.id, a.id); assert.equal(edited.revision, 2); assert.throws(() => store.save({ ...a, name: '过期编辑' }), { code: 'profile_revision_conflict' }); assert.equal(store.get(a.id).name, '新名称'); store.delete(a.id); assert.equal(store.list().length, 1); assert.equal(store.get(b.id).name, '设备B'); });
test('profiles reject malformed names and URL secrets without exposing supplied secrets', t => { const store = fixture(t); for (const api_base_url of ['', '192.168.1.1', 'ftp://host', 'http://u:supersecret@host', 'http://host/?token=supersecret', 'http://host/#supersecret']) { assert.throws(() => store.save({ ...input, api_base_url }), e => !e.message.includes('supersecret')); } for (const name of ['', ' ', 'a\nb']) assert.throws(() => store.save({ ...input, name })); assert.throws(() => store.save({ ...input, api_key: 'supersecret' })); assert.deepEqual(store.list(), []); });
test('profiles missing contract remains saveable, optional viewer remains unknown, permissions private and reads isolated', t => { const store = fixture(t); const a = store.save({ name: 'A', api_base_url: 'http://localhost:8080' }); assert.equal(a.web_base_url, null); assert.equal(a.contract, undefined); a.name = 'mutated'; assert.equal(store.get(a.id).name, 'A'); if (process.platform !== 'win32') { assert.equal(fs.statSync(store.file).mode & 0o777, 0o600); assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700); } assert.deepEqual(fs.readdirSync(store.directory), ['solver-profiles.json']); });
test('profiles refuse corrupt or symlinked configuration rather than overwrite it', t => { const store = fixture(t); store.save(input); fs.writeFileSync(store.file, '{private-corrupt'); assert.throws(() => store.save(input), { code: 'profiles_invalid' }); assert.equal(fs.readFileSync(store.file, 'utf8'), '{private-corrupt'); fs.unlinkSync(store.file); const other = path.join(store.directory, 'other'); fs.writeFileSync(other, '{}'); fs.symlinkSync(other, store.file); assert.throws(() => store.list(), { code: 'profiles_unsafe' }); assert.equal(fs.readFileSync(other, 'utf8'), '{}'); });
test('cross-process write lock prevents lost revisions and preserves original configuration', t => { const store = fixture(t); const p = store.save(input); fs.writeFileSync(`${store.file}.lock`, 'other-process'); assert.throws(() => store.save({ ...p, name: 'racing change' }), { code: 'profiles_busy' }); assert.equal(store.get(p.id).name, input.name); });

test('basic profiles and incomplete contracts remain saveable while supplied decimal step must be finite and positive', t => {
  const store = fixture(t);
  assert.equal(store.save({ ...input, contract: { integer_coefficients: false } }).contract.integer_coefficients, false);
  assert.equal(store.save({ ...input, contract: { coefficient_step: 0.1 } }).contract.coefficient_step, 0.1);
  for (const coefficient_step of [0, -1, Infinity, NaN, '0.1']) assert.throws(() => store.save({ ...input, contract: { coefficient_step } }), { code: 'profile_contract_invalid' });
});
test('1000 profiles remain readable and editable; saving profile1001 fails before replacing the file', t => {
  const store = fixture(t);
  const records = Array.from({ length: 999 }, (_, i) => ({ id: `local_${i.toString(16).padStart(32, '0')}`, revision: 1, name: `device${i}`, api_base_url: 'http://fixture.test', web_base_url: null }));
  store.write({ version: 1, profiles: records });
  const last = store.save(input);
  assert.equal(store.list().length, 1000);
  const before = fs.readFileSync(store.file);
  assert.throws(() => store.save({ ...input, name: 'profile1001' }), { code: 'profiles_limit_exceeded' });
  assert.deepEqual(fs.readFileSync(store.file), before);
  assert.equal(store.list().length, 1000);
  assert.equal(store.save({ ...last, name: 'edited at limit' }).revision, 2);
  assert.equal(store.list().length, 1000);
});
test('result_domain persists only explicit binary/spin contracts and rejects unknown domains without inferring from field names', t => {
  const store = fixture(t);
  for (const result_domain of ['binary', 'spin']) {
    const saved = store.save({ ...input, contract: { result_domain } });
    assert.equal(store.get(saved.id).contract.result_domain, result_domain);
  }
  for (const result_domain of ['', null, 'auto', 'spin_config', 0, ['binary']]) assert.throws(() => store.save({ ...input, contract: { result_domain } }), { code: 'profile_contract_invalid' });
  assert.equal(store.list().length, 2);
});
