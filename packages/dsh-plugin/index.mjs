// IsingQ 的原生 DSH 插件：进程内复用 @ising-tech/isingq-core，直接向 DSH 注册工具。
//
// 必须是 ESM：@deepseek-ai/dsh-tools 是 ESM 包，CJS require() 会与 loader 的
// 并发 import() 竞争（ERR_REQUIRE_ESM_RACE_CONDITION）。用静态 import 引入
// defineTool，共享 CJS core 则经 createRequire 加载。
//
// 相比 MCP 桥接，原生插件额外暴露 MCP Resources、拥有类型化输出与 Code Mode
// 支持，且不额外起子进程。只有 API Key 输入走 setup.js 的异步安全输入；
// 求解授权交由 DSH Host 的工具权限与用户确认流程处理。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  RESOURCES,
  SolverService,
  TOOL_DEFINITIONS,
  configureApiKeyAsync,
  normalizeSetupResult,
  getKnowledge,
  modelingGuide,
  readResource,
  validateDelivery,
  DeliveryValidationError,
  VerifiedReportError,
  buildVerifiedReport,
} = require('@ising-tech/isingq-core');

export const name = 'isingq-dsh-plugin';
export const inject = ['tools'];

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };
const RESOURCE_LIST_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: true } };

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function dshParameters(inputSchema) {
  const required = new Set(inputSchema.required || []);
  return Object.fromEntries(Object.entries(inputSchema.properties || {}).map(([key, schema]) => {
    // The DSH schema subset rejects minimum/maximum and default. Numeric
    // bounds remain visible in descriptions and are enforced by shared core.
    const parameter = Object.fromEntries(
      ['type', 'description', 'enum', 'additionalProperties']
        .filter((field) => schema[field] !== undefined)
        .map((field) => [field, schema[field]]),
    );
    // DSH expresses nullable primitive unions with oneOf, not a type array.
    if (Array.isArray(parameter.type)) {
      parameter.oneOf = parameter.type.map(type => ({ type }));
      delete parameter.type;
    }
    if (parameter.type === 'object' && parameter.additionalProperties === undefined) {
      parameter.additionalProperties = true;
    }
    // DSH expects a property map with per-property required:true at every
    // depth, rather than JSON Schema's required array on the object itself.
    if (schema.properties) parameter.properties = dshParameters(schema);
    if (schema.items) parameter.items = dshParameters({ properties: { item: schema.items } }).item;
    if (required.has(key)) parameter.required = true;
    return [key, parameter];
  }));
}

export function apply(ctx) {
  let service;
  const getService = () => service ||= new SolverService();
  const execute = {
    isingq_api_key_setup: async (args) => normalizeSetupResult(await configureApiKeyAsync({ force: args.force === true })),
    isingq_knowledge_get: (args) => getKnowledge(args.topic, args.locale),
    isingq_modeling_guide_get: (args) => modelingGuide(args.problem_summary),
    isingq_delivery_validate: (args) => {
      if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(key => key !== 'document')) {
        throw new DeliveryValidationError('delivery_unknown_field', 'arguments', '仅允许 document 字段；所有交付声明必须放在 document 内');
      }
      return validateDelivery(args.document);
    },
    isingq_report_verify: (args) => {
      if (!args || Array.isArray(args) || typeof args !== 'object' || Object.keys(args).some(key => key !== 'document')) {
        throw new VerifiedReportError('report_unknown_field', 'arguments', '仅允许 document 字段；所有核验输入必须放在 document 内');
      }
      try { return buildVerifiedReport(args.document); }
      catch (error) {
        if (error instanceof VerifiedReportError) throw error;
        throw Object.assign(new Error('本地报告核验未完成；请检查可信运行时完整性与兼容性，再重试 report verify。'), { code: 'report_failed' });
      }
    },
    isingq_qubo_validate: (args) => getService().validate(args.qubo),
    isingq_solve_start: (args) => getService().start(args),
    isingq_solve_poll: (args) => getService().poll(args.solve_id),
    isingq_solve_result_get: (args) => getService().get(args.solve_id),
  };
  for (const definition of TOOL_DEFINITIONS) {
    ctx.tools.register(defineTool({
      name: definition.name,
      description: definition.description,
      // DSH uses a schema DSL rather than arbitrary nested JSON Schema. Keep
      // this opaque document boundary shallow; the shared core owns all strict
      // delivery validation, including unknown fields and claimed statistics.
      parameters: definition.name === 'isingq_delivery_validate'
        ? { document: { type: 'object', additionalProperties: true, required: true,
          description: 'QUBO delivery document；含 qubo，可选 candidate_bits/claimed_summary/test_ledger/business_solution；由本地 core 严格校验，引用不执行。' } }
        : definition.name === 'isingq_report_verify'
          ? { document: { type: 'object', additionalProperties: true, required: true,
            description: 'isingq-verified-report-v1 document；model/data/candidates 及可选 baseline/top_k 由本地 core 严格校验。只消费核验结果，不自行补数字、排名或约束结论。' } }
          : dshParameters(definition.inputSchema),
      output: { schema: OBJECT_SCHEMA, render: renderJson },
      execute: execute[definition.name],
    }));
  }

  ctx.tools.register(defineTool({
    name: 'isingq_resource_list',
    description: '列出 isingq-mcp 本机公开知识资源清单（URI、标题、说明）。这些资源在 MCP 桥接模式下不可见。',
    parameters: {},
    output: { schema: RESOURCE_LIST_SCHEMA, render: renderJson },
    execute() {
      return RESOURCES;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'isingq_resource_read',
    description: '读取指定的 isingq-mcp 本机资源内容（URI 见 isingq_resource_list）。',
    parameters: {
      uri: { type: 'string', required: true, description: '资源 URI，如 isingq://modeling/qubo' },
    },
    output: { schema: OBJECT_SCHEMA, render: renderJson },
    execute(args) {
      const content = readResource(args.uri);
      if (!content) throw new Error(`资源不存在（uri=${args.uri}）`);
      return content;
    },
  }));
}
