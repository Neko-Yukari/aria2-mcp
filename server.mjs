#!/usr/bin/env node
// Standalone stdio MCP server and `--wait <gid>` CLI for aria2-mcp.
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { status, waitForDownload } from './lib/service.mjs';
import { buildToolSpecs } from './lib/tools.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: 'aria2-mcp', version: pkg.version };
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const CLI_PATH = fileURLToPath(import.meta.url);
const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

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
      '  ARIA2_NOTIFY_POLL_MS  Background completion watcher poll interval in ms (default 5000)',
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

  let minLogLevelIdx = LOG_LEVELS.indexOf('info');
  let claudeChannelEnabled = process.env.ARIA2_CLAUDE_CHANNEL === '1';

  // Track downloads submitted during this MCP session to emit completion notifications.
  const tracked = new Map();
  const pollMsRaw = Number(process.env.ARIA2_NOTIFY_POLL_MS);
  const pollIntervalMs = Number.isFinite(pollMsRaw) && pollMsRaw >= 100 && pollMsRaw <= 60_000 ? pollMsRaw : 5000;
  let watchTimer = null;
  let polling = false;

  const shouldLog = (level) => {
    const idx = LOG_LEVELS.indexOf(level);
    return idx === -1 || idx >= minLogLevelIdx;
  };

  const emitCompletion = (item, result) => {
    const isComplete = result.status === 'complete';
    const level = isComplete ? 'notice' : 'error';
    const event = isComplete ? 'download_complete' : `download_${result.status}`;
    const summary = isComplete
      ? `[aria2] Download complete: ${item.filename} (GID ${item.gid}${item.directory ? `, dir ${item.directory}` : ''})`
      : `[aria2] Download ${result.status}: ${item.filename} (GID ${item.gid}${result.errorCode ? `, aria2 error ${result.errorCode}` : ''})`;

    if (shouldLog(level)) {
      send({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: {
          level,
          logger: 'aria2-mcp',
          data: {
            event,
            message: summary,
            gid: item.gid,
            filename: item.filename,
            ...(item.directory ? { directory: item.directory } : {}),
            status: result.status,
            ...(result.totalLength !== undefined ? { totalLength: result.totalLength } : {}),
            ...(result.completedLength !== undefined ? { completedLength: result.completedLength } : {}),
            ...(result.progress !== undefined ? { progress: result.progress } : {}),
            ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
          },
        },
      });
    }

    if (claudeChannelEnabled) {
      send({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: summary,
          meta: {
            event,
            gid: item.gid,
            status: result.status,
            filename: item.filename,
            ...(item.directory ? { directory: item.directory } : {}),
          },
        },
      });
    }
  };

  const stopWatcherIfIdle = () => {
    if (tracked.size === 0 && watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  };

  const pollTracked = async () => {
    if (polling || tracked.size === 0) return;
    polling = true;
    try {
      for (const [gid, item] of Array.from(tracked.entries())) {
        let result;
        try {
          result = await status(gid);
        } catch {
          continue;
        }
        if (result.status === 'complete' || result.status === 'error' || result.status === 'removed') {
          if (tracked.delete(gid)) {
            emitCompletion(item, result);
          }
        }
      }
    } finally {
      polling = false;
      stopWatcherIfIdle();
    }
  };

  const ensureWatcher = () => {
    if (watchTimer || tracked.size === 0) return;
    watchTimer = setInterval(() => {
      void pollTracked();
    }, pollIntervalMs);
    watchTimer.unref?.();
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
          if (params?.capabilities?.experimental?.['claude/channel']) {
            claudeChannelEnabled = true;
          }
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                logging: {},
                ...(claudeChannelEnabled ? { experimental: { 'claude/channel': {} } } : {}),
              },
              serverInfo: SERVER_INFO,
            },
          });
          return;
        }
        case 'ping':
          send({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'logging/setLevel': {
          const idx = LOG_LEVELS.indexOf(params?.level);
          if (idx === -1) {
            send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid log level' } });
            return;
          }
          minLogLevelIdx = idx;
          send({ jsonrpc: '2.0', id, result: {} });
          return;
        }
        case 'tools/list':
          send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
          return;
        case 'tools/call': {
          const spec = TOOL_MAP.get(params?.name);
          if (!spec) throw new Error(`Unknown tool: ${params?.name}`);

          const progressToken = params?._meta?.progressToken;
          const ctx =
            progressToken !== undefined
              ? {
                  onProgress: (cur) => {
                    const completed = Number(cur.completedLength) || 0;
                    const total = Number(cur.totalLength) || 0;
                    send({
                      jsonrpc: '2.0',
                      method: 'notifications/progress',
                      params: {
                        progressToken,
                        progress: completed,
                        ...(total > 0 ? { total } : {}),
                        message: `${cur.status}${cur.progress !== null ? ` (${cur.progress}%)` : ''}`,
                      },
                    });
                  },
                }
              : undefined;

          const out = await spec.execute(params?.arguments, ctx);

          if (params?.name === 'download_submit' && out?.gid) {
            tracked.set(out.gid, {
              gid: out.gid,
              filename: out.filename,
              directory: out.directory,
            });
            ensureWatcher();
          } else if (
            params?.name === 'download_wait' &&
            out?.gid &&
            !out.timedOut &&
            ['complete', 'error', 'removed'].includes(out.status)
          ) {
            tracked.delete(out.gid);
            stopWatcherIfIdle();
          } else if (params?.name === 'download_control' && params?.arguments?.action === 'cancel' && out?.gid) {
            tracked.delete(out.gid);
            stopWatcherIfIdle();
          }

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

  rl.on('close', () => {
    if (watchTimer) clearInterval(watchTimer);
    process.exit(0);
  });
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
