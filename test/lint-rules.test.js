'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Linter } = require('eslint');
const quality = require('../scripts/eslint-rules.cjs');

function verify(code, rule = 'quality/release-before-close') {
  return new Linter().verify(code, [{ languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
    plugins: { quality }, rules: { [rule]: 'error' } }]);
}

test('lint rejects repeated descriptor ownership bugs across functions, methods and aliases', () => {
  const invalid = [
    'function save() { let fd; try { fd = open(); fs.closeSync(fd); fd = undefined; } finally { if (fd !== undefined) fs.closeSync(fd); } }',
    'function save() { let descriptor; closeSync(descriptor); record(); descriptor = null; }',
    'class Writer { complete() { fs.closeSync(this.fd); this.fd = undefined; } }',
    'class Writer { discard() { fs["closeSync"](this["fd"]); this.fd = void 0; } }',
    'function save() { let fd; try { fs.closeSync(fd); } finally { if (false) fd = undefined; } }',
    'function save() { let fd; try { fs.closeSync(fd); } finally { cleanup(); fd = undefined; } }',
  ];
  for (const code of invalid) {
    const messages = verify(code);
    assert.ok(messages.some(message => message.ruleId === 'quality/release-before-close'), code);
    assert.ok(messages.every(message => message.severity === 2), code);
  }
});

test('lint accepts ownership transfer, guaranteed finally release, and unrelated shadowed descriptors', () => {
  for (const code of [
    'function save() { let fd; const ownedFd = fd; fd = undefined; fs.closeSync(ownedFd); }',
    'class Writer { complete() { const ownedFd = this.fd; this.fd = undefined; fs.closeSync(ownedFd); } }',
    'function save() { let fd; try { fs.closeSync(fd); } finally { fd = undefined; } }',
    'function save() { let fd; fs.closeSync(fd); { let fd; fd = undefined; } }',
    'function save() { let fd; fs.closeSync(fd); function another() { let fd; fd = undefined; } }',
  ]) assert.deepEqual(verify(code), [], code);
});

test('standard lint rules prevent finally from overriding failures and unsafe async promise executors', () => {
  assert.equal(verify('function save() { try { work(); } finally { return 1; } }', 'no-unsafe-finally').length, 1);
  assert.equal(verify('new Promise(async resolve => { resolve(await work()); });', 'no-async-promise-executor').length, 1);
});

test('all published package release paths require tests and the shared lint gate', () => {
  const root = path.resolve(__dirname, '..');
  for (const relative of ['package.json', 'packages/core/package.json', 'packages/dsh-plugin/package.json']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    assert.match(pkg.scripts.prepublishOnly, /test.*check/, relative);
  }
  const pkg = require('../package.json');
  assert.match(pkg.scripts.check, /lint/);
  assert.match(pkg.scripts.lint, /eslint/);
});

test('legacy and target solve entrypoints cannot bypass the shared run lifecycle when writing', () => {
  const config = require('../eslint.config.cjs');
  for (const file of ['index.js', 'legacy-solve.js', 'target-service.js']) {
    const filename = path.resolve(__dirname, '../packages/core/src', file);
    const verify = code => new Linter().verify(code, config, { filename });
    const examples = [
      'async function poll(run, provider) { await provider.poll(); this.store.save(run); }',
      'function reserve(run) { this["store"]["archive"](run); }',
      'function reserve(run) { const {save: write} = this.store; write(run); }',
    ];
    for (const code of examples) {
      const messages = verify(code);
      assert.deepEqual(messages.map(message => [message.ruleId, message.severity]), [['no-restricted-syntax', 2]], code);
      assert.match(messages[0].message, /solve-lifecycle\.js/);
    }
    assert.deepEqual(verify(
      "const { updatePolledRun } = require('./solve-lifecycle'); function poll(id) { return updatePolledRun(this.store, this.store.get(id)); }",
    ), []);
  }
});

test('shared lock owners cannot regress to blind path deletion after a partial write', () => {
  for (const [file, name] of [['managed-mcp-state.js', 'acquireUntil'], ['guided-solve.js', 'serial'],
    ['solver-profiles.js', 'mutate'], ['target-config-drafts.js', 'transaction'], ['target-service.js', 'lock']]) {
    const filename = path.resolve(__dirname, '../packages/core/src', file);
    const method = body => name === 'acquireUntil' ? `function ${name}() { ${body} }` : `class Store { ${name}() { ${body} } }`;
    const config = [{ plugins: { quality }, rules: { 'quality/owned-lock-cleanup': 'error' } }];
    const invalid = new Linter().verify(method('try { write(); } finally { fs.unlinkSync(lock); }'), config, { filename });
    assert.equal(invalid.length, 1, file);
    assert.equal(invalid[0].ruleId, 'quality/owned-lock-cleanup');
    assert.deepEqual(new Linter().verify(method('try { write(); } finally { unlinkOwnedFileSync(lock, identity); }'), config, { filename }), [], file);
  }
});


test('known fs cleanup in finally cannot replace a primary error', () => {
  const code = "const fs=require('node:fs');function save(temp){try{throw Object.assign(new Error('primary'),{code:'PRIMARY_WRITE'});}finally{fs.unlinkSync(temp);}}module.exports=save;";
  const config = require('../eslint.config.cjs');
  const messages = new Linter().verify(code, config, { filename: path.resolve(__dirname, '../packages/core/src/background-updates.js') });
  assert.ok(messages.some(message => message.ruleId === 'quality/no-throwing-fs-cleanup-in-finally'));
});

test('cleanup guard follows fs bindings and known FileHandle sources, including aliases', () => {
  const rule = 'quality/no-throwing-fs-cleanup-in-finally';
  for (const code of [
    "const fs=require('node:fs'); function f(){try { work(); }finally{fs.closeSync(fd); fs['unlinkSync'](file); fs.rmSync(dir); fs.rmdirSync(dir);}}",
    "const {unlinkSync: remove}=require('fs'); function f(){try { work(); }finally{remove(file);}}",
    "const fs=require('fs'), alias=fs; const close=alias.closeSync; function f(){try { work(); }finally{close(fd);}}",
    "const {unlinkOwnedFileSync: remove}=require('./owned-file'); function f(){try { work(); }finally{remove(file,identity);}}",
    "const fs=require('fs'); function f(){try { work(); }finally{try{fs.closeSync(fd);}catch(error){if(error.code!=='ENOENT')throw error;}}}",
    "const fs=require('fs'); function f(){try{work();}finally{try{fs.closeSync(fd);fs.unlinkSync(file);}catch{}}}",
    "const fs=require('fs'); promise.finally(() => fs.unlinkSync(file));",
    "const fs=require('node:fs'); async function f(){let handle;try{handle=await fs.promises.open(file);work();}finally{await handle.close();}}",
    "const {open: openFile}=require('node:fs/promises'); async function f(){const h=await openFile(file);try{work();}finally{await h.close();}}",
    "const fs=require('node:fs'); async function f(){const h=await fs.promises.open(file);try{work();}finally{try{h.close();}catch{}}}",
  ]) assert.ok(verify(code, rule).some(message => message.ruleId === rule), code);
  for (const code of [
    "const fs=require('fs'); function f(){try {work();}finally{try{fs.closeSync(fd);}catch(error){failure=error;}try{fs.unlinkSync(file);}catch{}}}",
    "const fs=require('fs'); async function f(){const h=await fs.promises.open(file);try{work();}finally{try{await h.close();}catch{}}}",
    "const fs=require('fs'); function f(){try{work();}finally{function neverCalled(){fs.unlinkSync(file);}}}",
    "const fs=require('fs'); function f(fs){try{work();}finally{fs.closeSync(fd);}}",
    "async function f(session){try{work();}finally{await session.close();}}",
    "const fs=require('fs'); function f(){return runWithCleanupSync(()=>work(),()=>fs.closeSync(fd),()=>fs.unlinkSync(file));}",
    "const fs=require('fs'); async function f(){const h=await fs.promises.open(file);return runWithCleanup(()=>work(),()=>h.close());}",
  ]) assert.deepEqual(verify(code, rule), [], code);
  const both = verify("const fs=require('fs');function f(){try{work();}finally{fs.closeSync(fd);fs.unlinkSync(file);}}", rule);
  assert.equal(both.length, 2, 'each unprotected cleanup step is actionable');
});

test('real lint config rejects second destructuring of filesystem and FileHandle aliases', () => {
  const config = require('../eslint.config.cjs'), rule = 'quality/no-throwing-fs-cleanup-in-finally';
  const cases = [
    ["const fs=require('fs');const {unlinkSync:remove}=fs;function f(temp){try{throw Error('PRIMARY')}finally{remove(temp)}}", 'js'],
    ["const fs=require('fs');const {open}=fs.promises;async function f(file){const h=await open(file);try{throw Error('PRIMARY')}finally{await h.close()}}", 'js'],
    ["import * as fs from 'node:fs';const {unlinkSync:remove}=fs;function f(temp){try{throw Error('PRIMARY')}finally{remove(temp)}}", 'mjs'],
    ["import * as fs from 'node:fs/promises';const {open:openFile}=fs;async function f(file){const h=await openFile(file);try{throw Error('PRIMARY')}finally{await h.close()}}", 'mjs'],
    ["import {default as fs} from 'node:fs';function f(temp){try{throw Error('PRIMARY')}finally{fs.unlinkSync(temp)}}", 'mjs'],
    ["import {default as io} from 'node:fs/promises';async function f(file){const h=await io.open(file);try{throw Error('PRIMARY')}finally{await h.close()}}", 'mjs'],
  ];
  for (const [code, ext] of cases) {
    const filename = path.resolve(__dirname, `../packages/core/src/lint-alias-fixture.${ext}`);
    assert.ok(new Linter().verify(code, config, { filename }).some(message => message.ruleId === rule), code);
    const safe = code.replace('finally{remove(temp)}', 'finally{try{remove(temp)}catch{}}')
      .replace('finally{fs.unlinkSync(temp)}', 'finally{try{fs.unlinkSync(temp)}catch{}}')
      .replace('finally{await h.close()}', 'finally{try{await h.close()}catch{}}');
    assert.deepEqual(new Linter().verify(safe, config, { filename }), [], safe);
  }
});
