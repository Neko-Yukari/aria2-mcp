// Magpie tools plugin entry ("Tools for every agent", zero dependencies, JSON Schema args).
// Magpie serves these tools to all connected agents via /mcp/magpie/tools and the MCP router.
import { buildToolSpecs } from './lib/tools.mjs';

const specs = buildToolSpecs({
  // Stay safely under Magpie's 55-second per-tool execution timeout.
  waitMaxSeconds: 50,
  namePrefix: '',
});

const toolMap = Object.fromEntries(
  specs.map((spec) => [
    spec.shortName,
    {
      description: spec.description,
      args: spec.inputSchema,
      async execute(args, ctx) {
        return spec.execute(args, ctx);
      },
    },
  ]),
);

export const Aria2Tools = async () => ({
  tool: toolMap,
});
