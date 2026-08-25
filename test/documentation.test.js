'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('user READMEs explain where to create and how to protect an API key', () => {
  const chinese = read('README.md');
  const english = read('README.en.md');
  for (const content of [chinese, english]) {
    assert.match(content, /https:\/\/console\.isingq\.com\//);
    assert.match(content, /Create API|创建API/);
    assert.match(content, /Settings|设置/);
    assert.match(content, /secure input|安全输入/);
  }
});

test('DSH package README is bilingual and documents its install and data boundaries', () => {
  const content = read('packages/dsh-plugin/README.md');
  assert.match(content, /^## Install$/m);
  assert.match(content, /^## 中文说明$/m);
  assert.match(content, /dsh plugin --profile <profile> add @ising-tech\/isingq-dsh-plugin/);
  assert.match(content, />=0\.1\.0-rc\.7 <0\.2\.0-0/);
  assert.match(content, /HTTPS authentication|HTTPS 鉴权/);
  assert.match(content, /nine `isingq_\*` tools|9 个 `isingq_\*` 工具/);
  assert.match(content, /dsh plugin --profile <profile> remove @ising-tech\/isingq-dsh-plugin/);
  assert.match(content, /administrator|管理员/);
  assert.match(content, /osascript/);
  assert.match(content, /systemd-ask-password/);
  assert.match(content, /does not download or execute remote scripts|不下载或执行远程脚本/);
});

test('root READMEs expose the native DSH package and compatibility range', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const content = read(file);
    assert.match(content, /https:\/\/www\.npmjs\.com\/package\/@ising-tech\/isingq-dsh-plugin/);
    assert.match(content, />=0\.1\.0-rc\.7 <0\.2\.0-0/);
    assert.match(content, /isingq_resource_list/);
    assert.match(content, /isingq_resource_read/);
  }
});

test('developer material is separated from the user README', () => {
  assert.doesNotMatch(read('README.md'), /^## 开发验证$/m);
  assert.match(read('README.md'), /docs\/DEVELOPMENT\.md/);
  assert.match(read('docs/DEVELOPMENT.md'), /^## GitHub Actions 与 Release$/m);
});

test('security docs pin the production API and separate Agent input from headless administration', () => {
  const security = read('SECURITY.md');
  assert.match(security, /https:\/\/api\.isingq\.com/);
  assert.match(security, /ISINGQ_API_KEY/);
  assert.match(security, /Headless/);
  assert.match(security, /Agent.*must not|Agent.*不得/);
  assert.doesNotMatch(read('packages/core/src/index.js'), /ISINGQ_BASE_URL/);
});

test('installation skills direct users without receiving their API key', () => {
  for (const file of ['skills/install-isingq-mcp/SKILL.md', 'skills/install-isingq-mcp/SKILL.zh-CN.md']) {
    const content = read(file);
    assert.match(content, /https:\/\/console\.isingq\.com\//);
    assert.match(content, /Create API|创建API/);
  }
});

test('installation skills select one distribution and use path-neutral acceptance state', () => {
  for (const file of ['skills/install-isingq-mcp/SKILL.md', 'skills/install-isingq-mcp/SKILL.zh-CN.md']) {
    const content = read(file);
    const paths = ['codex-plugin', 'dsh-plugin', 'npx', 'release', 'source'];
    for (const pathName of paths) assert.match(content, new RegExp(pathName), `${file}: ${pathName}`);
    for (const field of [
      'distribution_mode', 'runtime_available', 'api_key_configured', 'host_registered',
      'tools_loaded', 'loaded_version', 'blocked_by', 'next_action',
    ]) {
      assert.match(content, new RegExp(field), `${file}: ${field}`);
    }
    assert.doesNotMatch(content, /binary_installed|native_tools_loaded/);
    assert.match(content, /exactly one|唯一/);
  }
});

test('source installer reports the shared acceptance schema without claiming release verification', () => {
  for (const file of [
    'skills/install-isingq-mcp/scripts/install-macos.sh',
    'skills/install-isingq-mcp/scripts/install-linux.sh',
    'skills/install-isingq-mcp/scripts/install-windows.ps1',
  ]) {
    const content = read(file);
    assert.match(content, /distribution_mode/);
    assert.match(content, /runtime_available/);
    assert.match(content, /tools_loaded/);
    assert.match(content, /loaded_version/);
    assert.doesNotMatch(content, /binary_installed|native_tools_loaded|hash-verified|哈希校验通过/);
  }
});

test('README math blocks avoid raw HTML delimiters that break GitHub rendering', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const blocks = [...read(file).matchAll(/```math\n([\s\S]*?)\n```/g)].map((match) => match[1]);
    assert.ok(blocks.length >= 2, `${file}: expected documented energy and objective formulas`);
    for (const block of blocks) assert.doesNotMatch(block, /[<>]/, file);
  }
});
