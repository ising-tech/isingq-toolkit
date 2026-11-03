'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceArtifacts } = require('../packages/core/src');

test('explicit workspace creates deterministic round directories and preserves earlier artifacts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = new WorkspaceArtifacts({ root, round: 1 });
  const second = new WorkspaceArtifacts({ root, round: 2 });
  const expectedRoot = fs.realpathSync(root);
  assert.deepEqual(first.init(), {
    workspace_contract_version: 'isingq-workspace-v1', root: expectedRoot, round: 1,
    round_dir: path.join(expectedRoot, 'round1'),
    directories: Object.fromEntries(['tmp', 'logs', 'output'].map(name => [name, path.join(expectedRoot, 'round1', name)])),
  });
  const artifact = first.write('output/model.json', '{"num_bits":1}\n');
  second.init();
  second.write('output/model.json', '{"num_bits":2}\n');
  assert.equal(fs.readFileSync(artifact.path, 'utf8'), '{"num_bits":1}\n');
  assert.throws(() => first.write('output/model.json', 'overwrite'), { code: 'artifact_exists' });
});

test('paths is deterministic and read-only; roots and rounds must be explicit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-workspace-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const invalidRoot of [undefined, '', '.', path.join(root, 'missing')]) {
    assert.throws(() => new WorkspaceArtifacts({ root: invalidRoot, round: 1 }), /root/);
  }
  for (const round of [undefined, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new WorkspaceArtifacts({ root, round }), { code: 'workspace_round_invalid' });
  }
  const workspace = new WorkspaceArtifacts({ root, round: 3 });
  assert.deepEqual(workspace.paths(), workspace.paths());
  assert.equal(fs.existsSync(path.join(root, 'round3')), false);
  assert.equal(workspace.resolve('./output//nested/result.json'), path.join(fs.realpathSync(root), 'round3/output/nested/result.json'));
  assert.equal(fs.existsSync(path.join(root, 'round3')), false);
  const record = workspace.write('logs/nested/run.log', Buffer.from('结果\n'));
  assert.equal(record.size_bytes, Buffer.byteLength('结果\n'));
  assert.equal(record.relative_path, 'logs/nested/run.log');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(record.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(record.path)).mode & 0o777, 0o700);
  }
});

test('rejects traversal, external absolute paths, malformed categories and symlink escape before writing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-workspace-boundary-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-workspace-external-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const workspace = new WorkspaceArtifacts({ root, round: 1 });
  workspace.init();
  for (const invalid of ['../outside.log', 'output/../../outside.log', 'output/../model.json', '/tmp/outside.log',
    path.join(outside, 'outside.log'), 'C:\\outside.log', 'C:outside.log', '\\\\server\\share\\outside.log',
    'output\\outside.log', 'elsewhere/outside.log', 'output', 'output/', 'output/bad\0name', 'output/file:stream', 'output/CON', 'output/nul.json', 'logs/LPT1.txt', 'tmp/name.', 'tmp/name ']) {
    assert.throws(() => workspace.write(invalid, 'forbidden'), error => {
      assert.equal(error.code, 'artifact_path_invalid', invalid);
      assert.equal(error.context.path, invalid);
      assert.equal(error.context.round, 1);
      assert.match(error.hint, /工作根/);
      return true;
    });
  }
  fs.symlinkSync(outside, path.join(root, 'round1/tmp/link'), 'dir');
  assert.throws(() => workspace.write('tmp/link/escape.log', 'forbidden'), { code: 'artifact_path_unsafe' });
  fs.symlinkSync(path.join(outside, 'missing.log'), path.join(root, 'round1/output/dangling.log'));
  assert.throws(() => workspace.write('output/dangling.log', 'forbidden'), { code: 'artifact_path_unsafe' });
  fs.symlinkSync(outside, path.join(root, 'round2'), 'dir');
  assert.throws(() => new WorkspaceArtifacts({ root, round: 2 }).init(), { code: 'artifact_path_unsafe' });
  fs.symlinkSync(outside, path.join(root, 'redirected-root'), 'dir');
  assert.throws(() => new WorkspaceArtifacts({ root: path.join(root, 'redirected-root'), round: 1 }), { code: 'workspace_root_invalid' });
  fs.writeFileSync(path.join(root, 'round1/logs/file'), 'existing');
  assert.throws(() => workspace.write('logs/file/nested.log', 'forbidden'), { code: 'artifact_path_unsafe' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('checks paths again when a directory was redirected after initialization', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-workspace-recheck-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-workspace-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const workspace = new WorkspaceArtifacts({ root, round: 1 });
  workspace.init();
  fs.rmdirSync(path.join(root, 'round1/logs'));
  fs.symlinkSync(outside, path.join(root, 'round1/logs'), 'dir');
  assert.throws(() => workspace.paths(), { code: 'artifact_path_unsafe' });
  assert.throws(() => workspace.write('logs/escape.log', 'forbidden'), { code: 'artifact_path_unsafe' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('bounded artifact reads are read-only, reject traversal/symlinks and enforce actual size', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'isingq-read-artifact-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace=new WorkspaceArtifacts({root,round:1});
  assert.throws(()=>workspace.read('output/missing.md'),{code:'artifact_read_error'});
  assert.equal(fs.existsSync(path.join(root,'round1')),false);
  workspace.write('output/report.md','12345');
  assert.equal(workspace.read('output/report.md',5).toString(),'12345');
  assert.throws(()=>workspace.read('output/report.md',4),{code:'artifact_too_large'});
  assert.throws(()=>workspace.read('../report.md'),{code:'artifact_path_invalid'});
  assert.throws(()=>workspace.read('output/report.md',-1),{code:'artifact_size_invalid'});
  if(process.platform!=='win32'){
    fs.symlinkSync(path.join(root,'round1/output/report.md'),path.join(root,'round1/output/link.md'));
    assert.throws(()=>workspace.read('output/link.md'),{code:'artifact_path_unsafe'});
  }
});
