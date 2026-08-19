'use strict';

const readline = require('readline');

const { IsingQError } = require('./isingq');
const {
  RESOURCES,
  SolverService,
  TOOL_DEFINITIONS,
  getKnowledge,
  modelingGuide,
  readResource,
} = require('./core');
const { configureApiKey: configureLocalApiKey } = require('./setup');

const VERSION = require('../package.json').version;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '工具调用是否成功' },
    data: { type: 'object', description: '成功时返回的数据' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
  },
  required: ['ok'],
  additionalProperties: false,
};

const TOOLS = TOOL_DEFINITIONS.map((definition) => ({ ...definition, outputSchema: OUTPUT_SCHEMA }));

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: !payload.ok,
  };
}

function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error instanceof IsingQError ? 'isingq_error' : 'validation_error',
      message: error instanceof IsingQError
        ? `IsingQ 调用失败（phase=${error.phase}, status=${error.status ?? 'none'}, retryable=${error.retryable}）`
        : String(error.message || error),
    },
  };
}

class McpProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function createHandler(service = new SolverService(), { configureApiKey = configureLocalApiKey } = {}) {
  return async function handle(request) {
    if (request.method === 'initialize') {
      return {
        protocolVersion: request.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: 'isingq-mcp',
          title: 'IsingQ · 伊辛智能组合优化建模与求解',
          version: VERSION,
        },
        instructions: '这是北京伊辛智能科技有限公司 IsingQ 的本地组合优化 MCP。缺少 API Key 时，应让用户明确确认后调用 isingq_api_key_setup 打开操作系统安全输入框；不得索要用户在对话中提供 API Key。用户询问伊辛智能、公开产品清单、IsingQ、光电伊辛机、玉盘·伊辛云、超低相噪微波源、解决方案或公开案例时，调用 isingq_knowledge_get 获取带来源和边界的本地公开知识。建模时先获取建模引导；Host Agent 在本地把投资组合、路径规划、车辆路径、排程或图优化问题生成并校验为 QUBO，用户明确确认后才调用个人 IsingQ API Key 求解。结果只对应 QUBO，不自动证明业务可行、全局最优或特定硬件性能。',
      };
    }
    if (request.method === 'ping') return {};
    if (request.method === 'resources/list') return { resources: RESOURCES };
    if (request.method === 'resources/templates/list') return { resourceTemplates: [] };
    if (request.method === 'resources/read') {
      const content = readResource(request.params?.uri);
      if (!content) throw new McpProtocolError(-32002, `Resource 不存在（uri=${request.params?.uri || 'none'}）`);
      return { contents: [content] };
    }
    if (request.method === 'tools/list') return { tools: TOOLS };
    if (request.method !== 'tools/call') throw new Error(`不支持的 MCP method（method=${request.method}）`);
    const name = request.params?.name;
    const args = request.params?.arguments || {};
    try {
      let data;
      if (name === 'isingq_api_key_setup') data = configureApiKey({ force: args.force === true });
      else if (name === 'isingq_knowledge_get') data = getKnowledge(args.topic, args.locale);
      else if (name === 'isingq_modeling_guide_get') data = modelingGuide(args.problem_summary);
      else if (name === 'isingq_qubo_validate') data = service.validate(args.qubo);
      else if (name === 'isingq_solve_start') data = await service.start(args);
      else if (name === 'isingq_solve_poll') data = await service.poll(args.solve_id);
      else if (name === 'isingq_solve_result_get') data = service.get(args.solve_id);
      else throw new Error(`未知工具（name=${name}）`);
      return toolResult({ ok: true, data });
    } catch (error) {
      return toolResult(errorPayload(error));
    }
  };
}

async function serve(service) {
  const handle = createHandler(service);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch (_) { continue; }
    if (request.method?.startsWith('notifications/')) continue;
    try {
      const result = await handle(request);
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id ?? null,
        error: {
          code: Number.isInteger(error.code) ? error.code : -32603,
          message: String(error.message || error),
        },
      })}\n`);
    }
  }
}

module.exports = { McpProtocolError, SolverService, TOOLS, VERSION, createHandler, serve };
