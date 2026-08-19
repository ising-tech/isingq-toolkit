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
