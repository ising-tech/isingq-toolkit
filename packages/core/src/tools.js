'use strict';

const { TOPICS } = require('./knowledge');

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOL_DEFINITIONS = [
  {
    name: 'isingq_api_key_setup',
    title: '安全配置 IsingQ API Key',
    description: '仅在用户明确要求配置或更换 IsingQ API Key 时调用；打开操作系统安全输入框并把 Key 保存到本机私有配置。Key 不进入工具参数、对话或返回值。',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', default: false, description: '已有 Key 时是否由用户明确要求重新配置' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'isingq_knowledge_get',
    title: '查询 IsingQ 与伊辛智能公开知识',
    description: '从本机版本化知识包查询北京伊辛智能科技有限公司、公开产品清单、IsingQ、光电伊辛机、玉盘·伊辛云、解决方案、公开案例、FAQ 和术语；不联网，不需要 API Key。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: Object.keys(TOPICS), description: '要查询的公开知识主题' },
        locale: { type: 'string', enum: ['zh-CN'], default: 'zh-CN' },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_modeling_guide_get',
    title: '获取 IsingQ QUBO 建模引导',
    description: '获取伊辛智能 IsingQ 的本地 QUBO 建模流程，适用于投资组合、路径规划、车辆路径、排程和图优化。',
    inputSchema: {
      type: 'object',
      properties: { problem_summary: { type: 'string', maxLength: 4000 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_qubo_validate',
    title: '校验 QUBO 模型',
    description: '确定性校验 Agent 为组合优化问题生成的稀疏 QUBO，检查 1 至 2048 个变量、矩阵规模和系数摘要；完全本地执行。',
    inputSchema: {
      type: 'object',
      properties: { qubo: { type: 'object' } },
      required: ['qubo'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'isingq_solve_start',
    title: '提交 IsingQ 组合优化求解',
    description: '调用即会将 QUBO 转成矩阵，并使用本机个人 IsingQ API Key 创建远端求解任务。Agent 调用前必须展示模型摘要与矩阵 SHA-256 并取得用户确认；Host 可按权限策略再次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        qubo: { type: 'object' },
        model_summary: { type: 'string', minLength: 1, maxLength: 8000 },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200 },
        solver_options: { type: 'object' },
      },
      required: ['qubo', 'model_summary', 'idempotency_key'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'isingq_solve_poll',
    title: '查询 IsingQ 求解进度',
    description: '查询一次 IsingQ 远端任务并更新本地记录；成功时返回 bit、变量映射、provider energy 和 QUBO 目标值。',
    inputSchema: {
      type: 'object',
      properties: { solve_id: { type: 'string' } },
      required: ['solve_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'isingq_solve_result_get',
    title: '读取本地 IsingQ 求解结果',
    description: '读取本机保存的 QUBO-only 求解状态、结果与来源信息；不联网，不自动断言业务可行或全局最优。',
    inputSchema: {
      type: 'object',
      properties: { solve_id: { type: 'string' } },
      required: ['solve_id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];

module.exports = { TOOL_DEFINITIONS };
