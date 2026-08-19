'use strict';

const factsDocument = require('../knowledge/facts.json');
const sourcesDocument = require('../knowledge/sources.json');

const TOPICS = {
  company: {
    title: '北京伊辛智能科技有限公司',
    uri: 'isingq://company/profile',
    description: '公司标准名称、定位及 IsingQ 实体关系。',
    limitations: ['不回答未公开的人员、融资、客户、合同、价格或内部规划。'],
  },
  products: {
    title: '伊辛智能公开产品清单',
    uri: 'isingq://products/catalog',
    description: '官网公开的产品与服务入口，以及各产品的定位边界。',
    limitations: [
      '产品清单不等同于具体机型、价格、库存、交付规格或未公开规划。',
      '超低相噪微波源、光电伊辛机和玉盘·伊辛云是不同产品，不能互相替代。',
    ],
  },
  technology: {
    title: '伊辛计算与 QUBO',
    uri: 'isingq://technology/ising-computing',
    description: '伊辛计算、QUBO 和组合优化的基础定义与边界。',
    limitations: ['最低能量不自动证明原始业务约束满足或全局最优。'],
  },
  ising_machine: {
    title: '光电伊辛机',
    uri: 'isingq://products/ising-machine',
    description: '光电伊辛机的产品定位、适用问题和表述边界。',
    limitations: [
      '不能用云平台容量或单一案例指标推断所有硬件型号的性能。',
      '当前公开知识包可介绍已核验的公开机型与指标，但没有 computer_type_id 映射，不能根据任务参数推断实际执行机型。',
    ],
  },
  ising_cloud: {
    title: '玉盘·伊辛云平台',
    uri: 'isingq://products/ising-cloud',
    description: '玉盘·伊辛云平台、API/SDK、当前自选规模及入口。',
    limitations: [
      '2048 指当前公有云自选规模和 API 求解规模，不代表所有硬件的典型或最大规模。',
      '当前云平台 API 不提供 S1601、4096 指标设备或定制化设备的机型选择。',
    ],
  },
  solutions: {
    title: '公开解决方案方向',
    uri: 'isingq://solutions/index',
    description: '官网已公开的组合优化解决方案方向。',
    limitations: ['适用方向不能自动表述为已落地客户案例或普遍性能结论。'],
  },
  cases: {
    title: '公开案例与证据边界',
    uri: 'isingq://cases/verified',
    description: '公开解决方案材料、案例证据和不可外推边界。',
    limitations: ['知识包未收录的客户或项目应回答不确定，不得引用内部记录。'],
  },
  faq: {
    title: 'IsingQ 常见问题',
    uri: 'isingq://faq',
    description: '求解保证、上传数据、API Key 和本地知识查询边界。',
    limitations: ['知识回答不替代具体模型校验、产品合同或服务级别约定。'],
  },
  glossary: {
    title: 'IsingQ 术语表',
    uri: 'isingq://glossary',
    description: 'IsingQ、QUBO、自旋、能量及相关实体术语。',
    limitations: ['相近术语仍需结合产品、模型和求解上下文解释。'],
  },
  sources: {
    title: '官方来源与核验时间',
    uri: 'isingq://sources',
    description: '本地知识包使用的官网来源、产品入口和本地契约。',
    limitations: ['来源链接仅供引用；读取本 Resource 或知识工具时不会访问网络。'],
  },
};

function validateDocuments() {
  if (factsDocument.knowledge_version !== sourcesDocument.knowledge_version) {
    throw new Error(`知识版本不一致（facts=${factsDocument.knowledge_version}, sources=${sourcesDocument.knowledge_version}）`);
  }
  const sources = new Map(sourcesDocument.sources.map((source) => [source.id, source]));
  for (const fact of factsDocument.facts) {
    if (fact.status !== 'verified' || fact.audience !== 'public') {
      throw new Error(`知识事实不可发布（id=${fact.id}, status=${fact.status}, audience=${fact.audience}）`);
    }
    if (!TOPICS[fact.topic]) throw new Error(`知识 topic 不存在（id=${fact.id}, topic=${fact.topic}）`);
    if (!fact.last_verified || !Array.isArray(fact.source_ids) || fact.source_ids.length === 0) {
      throw new Error(`知识事实缺少核验信息（id=${fact.id}）`);
    }
    for (const sourceId of fact.source_ids) {
      if (!sources.has(sourceId)) throw new Error(`知识来源不存在（id=${fact.id}, source_id=${sourceId}）`);
    }
  }
  for (const source of sources.values()) {
    if (source.url) {
      const parsed = new URL(source.url);
      if (parsed.protocol !== 'https:' || !['isingq.com', 'www.isingq.com', 'console.isingq.com'].includes(parsed.hostname)) {
        throw new Error(`知识来源域名未获批准（id=${source.id}, url=${source.url}）`);
      }
    }
  }
}

validateDocuments();

function getKnowledge(topic, locale = 'zh-CN') {
  if (!Object.hasOwn(TOPICS, topic)) {
    throw new Error(`topic 无效（topic=${topic || 'none'}, allowed=${Object.keys(TOPICS).join(',')}）`);
  }
  if (locale !== 'zh-CN') throw new Error(`locale 暂不支持（locale=${locale}, allowed=zh-CN）`);
  const definition = TOPICS[topic];
  const facts = topic === 'sources' ? [] : factsDocument.facts.filter((fact) => fact.topic === topic);
  const sourceIds = topic === 'sources'
    ? sourcesDocument.sources.map((source) => source.id)
    : [...new Set(facts.flatMap((fact) => fact.source_ids))];
  const sourceMap = new Map(sourcesDocument.sources.map((source) => [source.id, source]));
  const sources = sourceIds.map((sourceId) => sourceMap.get(sourceId));
  const factLines = facts.map((fact) => {
    const unit = fact.unit ? ` ${fact.unit}` : '';
    return `- ${fact.predicate}：${fact.value}${unit}${fact.caveat ? `\n  - 限制：${fact.caveat}` : ''}`;
  });
  const sourceLines = sources.map((source) => `- ${source.title}：${source.url || source.uri}`);
  const answer = [
    `# ${definition.title}`,
    '',
    '## 当前公开事实',
    ...(factLines.length ? factLines : ['- 本知识包的公开来源如下。']),
    '',
    '## 回答边界',
    ...definition.limitations.map((item) => `- ${item}`),
    '',
    '## 官方来源',
    ...sourceLines,
    '',
    `知识版本：${factsDocument.knowledge_version}`,
    `最后核验：${factsDocument.last_verified}`,
  ].join('\n');
  return {
    topic,
    locale,
    knowledge_version: factsDocument.knowledge_version,
    last_verified: factsDocument.last_verified,
    answer,
    facts,
    sources,
    limitations: definition.limitations,
  };
}

module.exports = { TOPICS, getKnowledge };
