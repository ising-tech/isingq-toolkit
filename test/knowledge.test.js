'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const factsDocument = require('../packages/core/knowledge/facts.json');
const sourcesDocument = require('../packages/core/knowledge/sources.json');
const { getKnowledge, TOPICS } = require('../src/knowledge');

test('publishes only verified public facts with traceable sources', () => {
  const sourceIds = new Set(sourcesDocument.sources.map((source) => source.id));
  for (const fact of factsDocument.facts) {
    assert.equal(fact.status, 'verified', fact.id);
    assert.equal(fact.audience, 'public', fact.id);
    assert.match(fact.last_verified, /^\d{4}-\d{2}-\d{2}$/, fact.id);
    assert.equal(fact.source_ids.length > 0, true, fact.id);
    assert.equal(fact.source_ids.every((sourceId) => sourceIds.has(sourceId)), true, fact.id);
  }
});

test('keeps current cloud capacity distinct from historical capacity', () => {
  const current = factsDocument.facts.find((fact) => fact.id === 'cloud.current_spin_count');
  const historical = factsDocument.historical_facts.find((fact) => fact.id === 'cloud.previous_spin_count');
  assert.equal(current.value, 2048);
  assert.equal(current.scope, 'public-cloud');
  assert.equal(historical.value, 1601);
  assert.equal(historical.status, 'historical');
  assert.doesNotMatch(getKnowledge('ising_cloud').answer, /当前(?:自选|求解)规模[^\n]*1601/);
  assert.match(getKnowledge('ising_cloud').answer, /API 求解只支持 2048/);
  assert.match(getKnowledge('ising_cloud').limitations.join('\n'), /不提供 S1601/);
});

test('knowledge topics are closed, local and carry answer boundaries', () => {
  assert.deepEqual(Object.keys(TOPICS), [
    'company', 'products', 'technology', 'ising_machine', 'ising_cloud',
    'solutions', 'cases', 'faq', 'glossary', 'sources',
  ]);
  for (const topic of Object.keys(TOPICS)) {
    const knowledge = getKnowledge(topic);
    assert.equal(knowledge.topic, topic);
    assert.equal(knowledge.knowledge_version, factsDocument.knowledge_version);
    assert.equal(Array.isArray(knowledge.sources), true);
    assert.equal(Array.isArray(knowledge.limitations), true);
    assert.equal(typeof knowledge.answer, 'string');
  }
  assert.throws(() => getKnowledge('internal'), /topic/);
  assert.throws(() => getKnowledge('company', 'en-US'), /locale/);
});

test('product catalog lists distinct public products with official sources', () => {
  const knowledge = getKnowledge('products');
  assert.match(knowledge.answer, /光电伊辛机/);
  assert.match(knowledge.answer, /玉盘·伊辛云平台/);
  assert.match(knowledge.answer, /超低相噪微波源/);
  assert.equal(knowledge.facts.length, 3);
  assert.equal(knowledge.sources.some((source) => source.url === 'https://www.isingq.com/product/oepo'), true);
  assert.match(knowledge.limitations.join('\n'), /不同产品/);
});

test('machine knowledge describes public characteristics without inventing model mapping', () => {
  const knowledge = getKnowledge('ising_machine');
  assert.match(knowledge.answer, /全连接/);
  assert.match(knowledge.answer, /室温/);
  assert.match(knowledge.answer, /数千至上万自旋/);
  assert.match(knowledge.answer, /S1601/);
  assert.match(knowledge.answer, /S2048/);
  assert.match(knowledge.answer, /全连接自旋数达 4096/);
  assert.match(knowledge.answer, /私有化部署与定制化集成/);
  assert.equal(knowledge.facts.some((fact) => /S4096/.test(`${fact.subject} ${fact.predicate}`)), false);
  assert.match(knowledge.answer, /云平台 API 不提供 S1601 选择/);
  assert.match(knowledge.limitations.join('\n'), /computer_type_id/);
  assert.doesNotMatch(knowledge.answer, /computer_type_id\s*[=:]　?\d+/);
});

test('public knowledge contains no internal paths, credentials or unsupported guarantees', () => {
  const serialized = JSON.stringify({ factsDocument, sourcesDocument });
  const publishedValues = factsDocument.facts.map((fact) => String(fact.value)).join('\n');
  assert.doesNotMatch(serialized, /\/Users\/|wiki\/company|leader-feedback|KPI|api[_ -]?key\s*[:=]\s*[A-Za-z0-9_-]+/i);
  assert.doesNotMatch(publishedValues, /全球领先|指数级加速|^保证全局最优$/m);
});
