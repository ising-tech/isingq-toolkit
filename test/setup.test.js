'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { configureApiKey, promptApiKey } = require('../src/setup');
const { apiKey } = require('../src/store');
const { configureApiKeyAsync } = require('../packages/core/src/setup');

test('configures API key through a private prompt without returning the secret', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-plugin-setup-'));
  const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') };
  const result = configureApiKey({ environment, prompt: () => 'plugin-private-key' });
  assert.deepEqual(result, { configured: true, status: 'configured', execution_mode: 'live', credential_effect: 'written', remote_verification: 'unverified', no_real_credentials: false, credential_presence: 'available' });
  assert.equal(JSON.stringify(result).includes('plugin-private-key'), false);
  assert.equal(apiKey(environment), 'plugin-private-key');
});

test('reuses an existing API key without reopening the prompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-mcp-plugin-reuse-'));
  const environment = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config') };
  configureApiKey({ environment, prompt: () => 'existing-private-key' });
  let prompts = 0;
  const result = configureApiKey({ environment, prompt: () => { prompts += 1; return 'unexpected'; } });
  assert.deepEqual(result, { configured: true, status: 'already_configured', execution_mode: 'live', credential_effect: 'already_present', remote_verification: 'unverified', no_real_credentials: false, credential_presence: 'available' });
  assert.equal(prompts, 0);
});

test('rejects unsupported secure prompt platforms with an actionable error', () => {
  assert.throws(() => promptApiKey({ platform: 'aix' }), /不支持.*aix/);
});

test('already_present may come from the runtime environment and does not claim a disk write or remote verification', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'isingq-runtime-configuration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const environment = { HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config'), ISINGQ_API_KEY: 'TEST_RUNTIME_VALUE' };
  for (const configure of [configureApiKey, configureApiKeyAsync]) {
    const result = await configure({ environment, prompt: () => { throw new Error('MUST_NOT_PROMPT'); } });
    assert.equal(result.status, 'already_configured');
    assert.equal(result.credential_effect, 'already_present');
    assert.equal(result.remote_verification, 'unverified');
    assert.equal(result.credential_presence, 'available');
    assert.deepEqual(fs.readdirSync(directory), []);
  }
});

for (const [platform, expectedCommands] of [
  ['darwin', ['osascript']],
  ['win32', ['powershell']],
  ['linux', ['zenity', 'kdialog', 'systemd-ask-password']],
]) {
  test(`${platform} secure prompt commands explain official API Key creation without opening a dialog`, () => {
    for (let selected = 0; selected < expectedCommands.length; selected += 1) {
      const calls = [];
      const result = promptApiKey({
        platform,
        environment: {},
        spawn(command, args, options) {
          calls.push({ command, args, options });
          if (calls.length <= selected) return { error: { code: 'ENOENT' } };
          return { status: 0, stdout: 'TEST_ONLY_NOT_A_KEY' };
        },
      });
      assert.equal(result, 'TEST_ONLY_NOT_A_KEY');
      assert.deepEqual(calls.map(call => call.command), expectedCommands.slice(0, selected + 1));
      for (const { command, args, options } of calls) {
        const text = args.join(' ').replace(/\r?\n/g, ' ');
        assert.match(text, /https:\/\/console\.isingq\.com\//);
        assert.match(text, /https:\/\/console\.isingq\.com\/api-keys/);
        assert.match(text, /登录.*API Key.*创建.*复制/);
        assert.match(text, /不要.*对话.*(?:发送|粘贴).*Key/);
        assert.doesNotMatch(text, /设置.*API/);
        assert.equal(options.windowsHide, true);
        assert.equal(args.includes('TEST_ONLY_NOT_A_KEY'), false);
        if (command === 'osascript') assert.match(text, /with hidden answer/);
        if (command === 'powershell') {
          assert.match(text, /UseSystemPasswordChar=\$true/);
          assert.match(text, /\$l\.AutoSize=\$false/);
          assert.match(text, /\$l\.Size=New-Object System\.Drawing\.Size\(590,150\)/);
          assert.match(text, /Size\(640,310\)/);
          assert.match(text, /`r`n/);
        }
        if (command === 'zenity' || command === 'kdialog') assert.ok(args.includes('--password'));
        if (command === 'systemd-ask-password') assert.ok(args.includes('--no-tty'));
      }
    }
  });
}
