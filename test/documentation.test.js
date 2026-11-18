'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('user READMEs explain where to create and how to protect an API key', () => {
  for (const file of ['README.md','README.en.md','packages/mcp/README.md','packages/mcp/README.en.md','packages/dsh-plugin/README.md','packages/dsh-plugin/README.en.md']) {
    const content=read(file);
    assert.match(content, /https:\/\/console\.isingq\.com\/api-keys/,file);
    assert.match(content, /create.*personal API Key|创建个人 API Key/i,file);
    assert.match(content, /private|secure input|安全输入/i,file);
    assert.match(content, /Never.*API Key|Keep API Keys out|API Key 不应|API Key 不进入/i,file);
  }
});

test('DSH package publishes separate bilingual installation guides with current compatibility and data boundaries', () => {
  const chinese=read('packages/dsh-plugin/README.md'),english=read('packages/dsh-plugin/README.en.md');
  assert.match(chinese, /\[English\]\(README.en.md\)/);
  assert.match(english, /\[简体中文\]\(README.md\)/);
  assert.match(chinese,/插件 → 添加插件/);assert.match(english,/Plugins → Add plugin/);
  for(const content of [chinese,english]) {
  assert.match(content, /Applications\/DeepSeek Harness\.app\/Contents\/Resources\/runtime\/cli\/bin\/dsh/);
  assert.match(content, /plugin --profile <profile> add @ising-tech\/isingq-dsh-plugin/);
  assert.match(content, />=0\.1\.0-rc\.7 <0\.3\.0-0/);
  assert.match(content, /\*\*21 (?:tools|个工具)\*\*/);
  assert.match(content, /plugin --profile <profile> remove @ising-tech\/isingq-dsh-plugin/);
  assert.match(content, /fully quit|完全退出/);
  assert.match(content,/Profile configuration, and logs|Profile 配置或日志/);
  assert.match(content,/local tasks send it to the selected device|内网本地任务发送到选定设备/);
  }
});

test('root READMEs link the native DSH package while its own guides own the compatibility range', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const content = read(file);
    assert.match(content, /https:\/\/www\.npmjs\.com\/package\/@ising-tech\/isingq-dsh-plugin/);
    assert.match(content, /packages\/dsh-plugin#readme/);
  }
  const pkg=JSON.parse(read('packages/dsh-plugin/package.json'));
  for(const file of ['packages/dsh-plugin/README.md','packages/dsh-plugin/README.en.md']) assert.ok(read(file).includes(pkg.engines.dsh),file);
  for(const resource of ['isingq_resource_list','isingq_resource_read']) assert.ok(read('docs/DEVELOPMENT.md').includes(resource));
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

test('installation skills defer solve behavior to runtime guidance and do not require cloud Key for local targets', () => {
  for (const file of ['skills/install-isingq-mcp/SKILL.md', 'skills/install-isingq-mcp/SKILL.zh-CN.md']) {
    const content = read(file);
    assert.match(content, /isingq_modeling_guide_get/);
    assert.match(content, /isingq:\/\/modeling\/qubo/);
    assert.match(content, /target_guidance/);
    assert.match(content, /solver_mode_policy/);
    assert.match(content, /numeric_model_policy/);
    assert.match(content, /Local solving does not require a cloud Key|本地求解不要求云Key/);
    assert.match(content, /Skip them for local-only use|仅用本地时跳过/);
    assert.doesNotMatch(content, /Agent must show the model summary and matrix SHA-256|Agent 调用前必须展示模型摘要和矩阵 SHA-256/);
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

test('concise READMEs link the shared mathematical contracts instead of duplicating full formula references', () => {
  for (const file of ['README.md', 'README.en.md']) {
    assert.match(read(file),/packages\/core\/README.md/);
  }
  for(const file of ['packages/core/README.md','packages/core/README.en.md']) {
    assert.match(read(file),/\]\(MODEL-DIGEST.md\)/);
    assert.match(read(file),/\]\(API.md\)/);
  }
  assert.match(read('packages/core/MODEL-DIGEST.md'),/QUBO_CONTRACT_VERSION/);
  assert.match(read('packages/core/API.md'),/objectiveEnergy/);
});

test('legacy size claims match the executable boundary while explicit targets use declared capabilities', () => {
  const { validateQubo } = require('../packages/core/src/qubo');
  const source = read('packages/core/src/qubo.js');
  const maximum = source.match(/^const MAX_BITS = (\d+);$/m);
  assert.ok(maximum, 'MAX_BITS declaration must remain inspectable by the documentation contract test');
  const maxBits = Number(maximum[1]);
  for (const [file, pattern] of [
    ['packages/core/MODEL-DIGEST.md', /1 至 ([\d,]+) 的整数/],
    ['docs/solver-targets.md', /legacy start保持原云契约与([\d,]+)本地边界/],
  ]) {
    const claim = read(file).match(pattern);
    assert.ok(claim, `${file}: missing explicit cloud size claim`);
    const advertised = Number(claim[1].replaceAll(',', ''));
    assert.equal(advertised, maxBits, `${file}: advertised=${advertised}, MAX_BITS=${maxBits}`);
    assert.doesNotThrow(() => validateQubo({ num_bits: advertised }));
    assert.throws(() => validateQubo({ num_bits: advertised + 1 }), /num_bits/);
  }
});
