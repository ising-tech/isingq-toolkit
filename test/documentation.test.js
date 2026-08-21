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
});

test('developer material is separated from the user README', () => {
  assert.doesNotMatch(read('README.md'), /^## 开发验证$/m);
  assert.match(read('README.md'), /docs\/DEVELOPMENT\.md/);
  assert.match(read('docs/DEVELOPMENT.md'), /^## GitHub Actions 与 Release$/m);
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
