'use strict';

const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

async function loadNativeDsh(t) {
  const toolsEntry = require.resolve('@deepseek-ai/dsh-tools');
  const resolveDsh = createRequire(toolsEntry);
  const [{ Context }, { SystemPrompt }, { ToolRuntime }, plugin] = await Promise.all([
    import(pathToFileURL(resolveDsh.resolve('@deepseek-ai/cordis'))),
    import(pathToFileURL(resolveDsh.resolve('@deepseek-ai/dsh-system-prompt'))),
    import(pathToFileURL(toolsEntry)),
    import('../packages/dsh-plugin/index.mjs'),
  ]);
  const ctx = new Context();
  const fibers = [];
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  });
  fibers.push(await ctx.plugin(SystemPrompt, {}));
  fibers.push(await ctx.plugin(ToolRuntime, {}));
  fibers.push(await ctx.plugin(plugin, { backgroundUpdates: null }));
  return ctx.tools;
}

module.exports = { loadNativeDsh };
