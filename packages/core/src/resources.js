'use strict';

const { TOPICS, getKnowledge } = require('./knowledge');
const { modelingGuide } = require('./modeling');

const MODELING_GUIDE = modelingGuide();

const LAST_MODIFIED = '2026-08-17T00:00:00Z';
const SECURITY_LAST_MODIFIED = '2026-08-25T00:00:00Z';

const LOCAL_RESOURCE_CONTENT = {
  'isingq://modeling/qubo': `# QUBO 建模契约

目标函数：offset + Σ linear[i]·x_i + Σ quadratic[i,j]·x_i·x_j，其中 x_i ∈ {0,1}；当前支持 1 至 2048 个二进制变量。

输入必填项：${MODELING_GUIDE.qubo_contract.input_schema.required.join(", ")}。linear/quadratic/variables省略为[]，offset省略或null为0；完整规范化输出不是必填清单。

${MODELING_GUIDE.qubo_contract.transport_boundary.description}

意图入口：${Object.keys(MODELING_GUIDE.intent_routes).join(' / ')}。数据阶段：symbolic_model / numeric_matrix / cloud_submission。概念解释不安装，仅建模不要求云权限；缺实例值可先做符号模型，只阻断依赖步骤，不重复追问已知信息。

按当前入口选用步骤：
${MODELING_GUIDE.required_sequence.map((step) => '- ' + step).join('\n')}

用户确认业务范围、目标约束、数据外发、付款选择与任务执行摘要；后台关联 model_sha256、求解参数和稳定幂等键。矩阵/hash/日志按需提供，无需用户读懂矩阵；专业技术交付要求完整满足。

结果证据状态：
${Object.entries(MODELING_GUIDE.result_evidence.states).map(([state, evidence]) => '- ' + state + '：' + evidence).join('\n')}

${Object.values(MODELING_GUIDE.explanation_contract).join('\n')}

${MODELING_GUIDE.agent_rules.join('\n')}

isingq_solve_start 被 Host 放行后会立即创建远端任务。MCP 不弹出额外的操作系统求解确认框；Host 可以根据自身工具权限策略再次要求确认。

最低 energy 不自动证明业务约束满足，也不自动证明全局最优。`,
  'isingq://security/data-flow': `# 数据流与安全边界

- 交互环境默认从用户电脑的私有文件读取 IsingQ API Key；Headless 管理员可在 Agent 启动前注入 ISINGQ_API_KEY，运行时不持久化该变量。Agent 不得接收、设置或显示 Key。
- 生产 API 固定为 https://api.isingq.com，不支持通过运行时环境变量替换目标域名。
- 企业知识、建模引导和 QUBO 校验完全在用户电脑执行。
- 只有 isingq_solve_start 会将生成的 QUBO 矩阵经 HTTPS 和 IsingQ 提供的上传链路发送到 IsingQ；该工具被 Host 放行后会立即创建远端任务。
- MCP 不为求解另开操作系统确认框。Agent 必须在调用前取得用户确认，Host 可以根据自身权限策略再次确认。
- 当前 MCP 使用的云平台 API 求解只支持 2048 自旋能力，不向用户提供其他机型选择。
- 本地记录保存模型、任务标识、矩阵摘要和结果，不保存 API Key。
- 除 IsingQ 求解链路外，不会把模型数据发送到其他业务服务。
- 提交结果不确定时会标记 submission_unknown，禁止自动重复创建任务。`,
};

const knowledgeResources = Object.entries(TOPICS).map(([topic, definition]) => ({
  topic,
  uri: definition.uri,
  name: `isingq-${topic.replaceAll('_', '-')}`,
  title: definition.title,
  description: definition.description,
  mimeType: 'text/markdown',
  annotations: { audience: ['user', 'assistant'], priority: 0.8, lastModified: LAST_MODIFIED },
}));

const RESOURCES = [
  {
    uri: 'isingq://about',
    name: 'isingq-about',
    title: 'IsingQ 与伊辛智能（兼容入口）',
    description: '兼容旧版本的公司与 IsingQ 实体说明；内容与 company/profile 一致。',
    mimeType: 'text/markdown',
    annotations: { audience: ['user', 'assistant'], priority: 0.9, lastModified: LAST_MODIFIED },
  },
  ...knowledgeResources.map(({ topic: _topic, ...resource }) => resource),
  {
    uri: 'isingq://modeling/qubo',
    name: 'isingq-qubo-modeling',
    title: 'QUBO 建模与解释规则',
    description: '变量、约束、Penalty、Agent/Host 确认责任和结果解释契约。',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant'], priority: 1, lastModified: LAST_MODIFIED },
  },
  {
    uri: 'isingq://security/data-flow',
    name: 'isingq-data-flow',
    title: 'IsingQ MCP 数据流与安全边界',
    description: 'API Key、知识查询、QUBO 矩阵和求解结果的本地与远端边界。',
    mimeType: 'text/markdown',
    annotations: { audience: ['user', 'assistant'], priority: 0.9, lastModified: SECURITY_LAST_MODIFIED },
  },
];

const topicByUri = new Map(knowledgeResources.map((resource) => [resource.uri, resource.topic]));

function readResource(uri) {
  if (uri === 'isingq://about') return { uri, mimeType: 'text/markdown', text: getKnowledge('company').answer };
  if (Object.hasOwn(LOCAL_RESOURCE_CONTENT, uri)) {
    return { uri, mimeType: 'text/markdown', text: LOCAL_RESOURCE_CONTENT[uri] };
  }
  const topic = topicByUri.get(uri);
  if (!topic) return null;
  return { uri, mimeType: 'text/markdown', text: getKnowledge(topic).answer };
}

module.exports = { RESOURCES, readResource };
