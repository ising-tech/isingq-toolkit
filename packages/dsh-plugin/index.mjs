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
  getKnowledge,
  modelingGuide,
  readResource,
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
    const parameter = Object.fromEntries(
      ['type', 'description', 'enum', 'additionalProperties', 'items', 'properties']
        .filter((field) => schema[field] !== undefined)
        .map((field) => [field, schema[field]]),
    );
    if (parameter.type === 'object' && parameter.additionalProperties === undefined) {
      parameter.additionalProperties = true;
    }
    if (required.has(key)) parameter.required = true;
    return [key, parameter];
  }));
}

export function apply(ctx) {
  const service = new SolverService();
  const execute = {
    isingq_api_key_setup: (args) => configureApiKeyAsync({ force: args.force === true }),
    isingq_knowledge_get: (args) => getKnowledge(args.topic, args.locale),
    isingq_modeling_guide_get: (args) => modelingGuide(args.problem_summary),
    isingq_qubo_validate: (args) => service.validate(args.qubo),
    isingq_solve_start: (args) => service.start(args),
    isingq_solve_poll: (args) => service.poll(args.solve_id),
    isingq_solve_result_get: (args) => service.get(args.solve_id),
  };
  for (const definition of TOOL_DEFINITIONS) {
    ctx.tools.register(defineTool({
      name: definition.name,
      description: definition.description,
      parameters: dshParameters(definition.inputSchema),
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
