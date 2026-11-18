'use strict';

const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { promptApiKey, promptApiKeyAsync } = require('../packages/core/src/setup');

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}

test('synchronous private input has a configured deadline and hard termination signal', () => {
  let options;
  const result = promptApiKey({ platform: 'darwin', environment: { PATH: '' }, timeoutMs: 1234,
    spawn(_command, _args, supplied) { options = supplied; return { status: 0, stdout: 'TEST_ONLY_VALUE' }; } });
  assert.equal(result, 'TEST_ONLY_VALUE');
  assert.equal(options.timeout, 1234);
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.maxBuffer, 65536);
});

test('synchronous timeout and buffer exhaustion report context without private output', () => {
  for (const [code, expected] of [['ETIMEDOUT', /超时.*timeout_ms=10/], ['ENOBUFS', /超过.*max_bytes=65536/]]) {
    assert.throws(() => promptApiKey({ platform: 'darwin', environment: { PATH: '' }, timeoutMs: 10,
      spawn: () => ({ error: Object.assign(Error('TEST_PRIVATE_OUTPUT'), { code }), stdout: 'TEST_PRIVATE_OUTPUT' }) }),
    error => expected.test(error.message) && !error.message.includes('TEST_PRIVATE_OUTPUT'));
  }
});

test('asynchronous private input kills a stalled child even if it never emits close', async () => {
  const child = childProcess();
  await assert.rejects(promptApiKeyAsync({ platform: 'darwin', environment: { PATH: '' }, timeoutMs: 10, spawn: () => child }), /超时.*timeout_ms=10/);
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.stdout.write('LATE_PRIVATE_OUTPUT');
  child.emit('close', 0);
});

test('asynchronous output limit counts UTF-8 bytes and stops accumulating output', async () => {
  const child = childProcess();
  const pending = promptApiKeyAsync({ platform: 'darwin', environment: { PATH: '' }, timeoutMs: 1000, spawn: () => child });
  child.stdout.write('中'.repeat(22000));
  await assert.rejects(pending, error => /超过.*max_bytes=65536/.test(error.message) && !error.message.includes('中'));
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.emit('close', 0);
});

test('asynchronous success clears its timeout and Linux missing components fall back', async () => {
  const children = [], commands = [];
  const result = await promptApiKeyAsync({ platform: 'linux', environment: { PATH: '' }, timeoutMs: 20,
    spawn(command) {
      commands.push(command);
      const child = childProcess(); children.push(child);
      setImmediate(() => {
        if (command === 'zenity') child.emit('error', Object.assign(Error('missing'), { code: 'ENOENT' }));
        else { child.stdout.write('TEST_ONLY_VALUE\n'); child.emit('close', 0); }
      });
      return child;
    } });
  assert.equal(result, 'TEST_ONLY_VALUE');
  assert.deepEqual(commands, ['zenity', 'kdialog']);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(children.every(child => child.kills.length === 0));
});

test('asynchronous cancellation, empty output and spawn failures are sanitized', async () => {
  for (const mode of ['cancel', 'empty', 'spawn']) {
    await assert.rejects(promptApiKeyAsync({ platform: 'darwin', environment: { PATH: '' }, timeoutMs: 100,
      spawn() {
        if (mode === 'spawn') throw Error('TEST_PRIVATE_OUTPUT');
        const child = childProcess();
        setImmediate(() => { if (mode === 'cancel') child.stdout.write('TEST_PRIVATE_OUTPUT'); child.emit('close', mode === 'cancel' ? 2 : 0); });
        return child;
      } }), error => !error.message.includes('TEST_PRIVATE_OUTPUT') && /取消|失败|为空/.test(error.message));
  }
});

test('private input timeout terminates an actual synthetic child process', async () => {
  let closed;
  await assert.rejects(promptApiKeyAsync({ platform: 'darwin', environment: { PATH: '' }, timeoutMs: 20,
    spawn() {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
      closed = once(child, 'close');
      return child;
    } }), /超时/);
  const [code, signal] = await closed;
  assert.equal(code, null);
  assert.equal(signal, 'SIGKILL');
});

test('invalid private input deadlines fail before starting a child', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 2147483648]) {
    const options = { platform: 'darwin', environment: { PATH: '' }, timeoutMs, spawn() { throw Error('MUST_NOT_SPAWN'); } };
    assert.throws(() => promptApiKey(options), /timeoutMs/);
    await assert.rejects(promptApiKeyAsync(options), /timeoutMs/);
  }
});

test('synchronous spawn exceptions never expose private component messages', () => {
  assert.throws(() => promptApiKey({ platform: 'darwin', environment: { PATH: '' },
    spawn() { throw Error('TEST_PRIVATE_COMPONENT_MESSAGE'); } }),
  error => /失败.*command=osascript/.test(error.message) && !error.message.includes('TEST_PRIVATE_COMPONENT_MESSAGE'));
});

test('private output stream errors reject once, terminate the child and tolerate late events', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const child = childProcess();
    const pending = promptApiKeyAsync({ platform: 'darwin', environment: { PATH: '' }, timeoutMs: 100, spawn: () => child });
    child.stdout.write('TEST_PRIVATE_COMPONENT_MESSAGE');
    child[stream].emit('error', Error('TEST_PRIVATE_COMPONENT_MESSAGE'));
    await assert.rejects(pending, error => /失败/.test(error.message) && !error.message.includes('TEST_PRIVATE_COMPONENT_MESSAGE'));
    child.stdout.emit('error', Error('LATE_PRIVATE_MESSAGE'));
    child.stderr.emit('error', Error('LATE_PRIVATE_MESSAGE'));
    child.emit('close', 0);
    assert.deepEqual(child.kills, ['SIGKILL']);
  }
});
