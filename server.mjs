#!/usr/bin/env node
// Standalone stdio MCP server and `--wait <gid>` CLI for aria2-mcp.
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { waitForDownload } from './lib/service.mjs';
import { buildToolSpecs } from './lib/tools.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: 'aria2-mcp', version: pkg.version };
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const CLI_PATH = fileURLToPath(import.meta.url);

const TOOL_SPECS = buildToolSpecs({
  cliHint: `node "${CLI_PATH}"`,
  waitMaxSeconds: 120,
  namePrefix: 'download_',
});
const TOOL_MAP = new Map(TOOL_SPECS.map((t) => [t.name, t]));
const MCP_TOOLS = TOOL_SPECS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

function printHelp() {
  process.stdout.write(
    [
      `aria2-mcp v${pkg.version} — Zero-config local aria2 MCP server`,
      '',
      'Usage:',
      '  aria2-mcp                         Start stdio MCP server (default)',
      '  aria2-mcp --wait <gid> [--timeout <secs>]  Wait for download completion',
      '  aria2-mcp --version               Print version',
      '  aria2-mcp --help                  Show help',
      '',
      'Environment variables:',
      '  ARIA2_BIN             Explicit path to aria2c binary',
      '  ARIA2_DATA_DIR        Custom directory for rpc.json & downloads.session',
      '  ARIA2_DEFAULT_DIR     Default download directory (defaults to ~/Downloads)',
      '  ARIA2_DEFAULT_PROXY   Default proxy mode: system (default), direct, or http://host:port',
      '  ARIA2_RPC_URL         Connect to an existing/remote aria2 JSON-RPC endpoint',
      '  ARIA2_RPC_SECRET      Secret token for ARIA2_RPC_URL',
    ].join('\n') + '\n',
  );
}

async function runCliWait(argv) {
  const idx = argv.indexOf('--wait');
  const gid = argv[idx + 1];
  if (!gid) {
    console.error('Usage: aria2-mcp --wait <gid> [--timeout <seconds>]');
    process.exit(2);
  }
  let timeout = 3600;
  const tIdx = argv.indexOf('--timeout');
  if (tIdx !== -1) {
    timeout = Number(argv[tIdx + 1]);
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 86400) {
      console.error('Invalid --timeout value (expected 0..86400 seconds)');
      process.exit(2);
    }
  }
  try {
    const result = await waitForDownload(gid, timeout, { maxTimeout: 86400 });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.timedOut) process.exit(124);
    if (result.status === 'complete') process.exit(0);
    if (result.status === 'paused') process.exit(2);
    process.exit(1);
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
}

function runMcpServer() {
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
  });

  const send = (msg) => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const { id, method, params } = req;
    if (id === undefined) return;

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : '2024-11-05';
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
            },
          });
          return;
        }
        case 'ping':
          send({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'tools/list':
          send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
          return;
        case 'tools/call': {
          const spec = TOOL_MAP.get(params?.name);
          if (!spec) throw new Error(`Unknown tool: ${params?.name}`);
          const out = await spec.execute(params?.arguments);
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(out) }] },
          });
          return;
        }
        default:
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      if (method === 'tools/call') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: err?.message || String(err) }],
            isError: true,
          },
        });
      } else {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err?.message || String(err) },
        });
      }
    }
  });

  rl.on('close', () => process.exit(0));
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  printHelp();
} else if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${pkg.version}\n`);
} else if (argv.includes('--wait')) {
  await runCliWait(argv);
} else {
  runMcpServer();
}
