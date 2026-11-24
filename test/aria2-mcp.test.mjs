import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  proxyURL,
  parseScutilProxy,
  validateFilename,
  validateGid,
  safeStatus,
  resolveAria2Binary,
} from '../lib/service.mjs';
import * as magpieEntry from '../index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_FILE = path.join(ROOT, 'server.mjs');
const PKG = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));

describe('unit: validators & parsers', () => {
  it('validates HTTP proxy URLs and rejects non-HTTP or malformed proxies', () => {
    assert.equal(proxyURL('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
    assert.equal(proxyURL('http://127.0.0.1:7890'), 'http://127.0.0.1:7890/');
    assert.throws(() => proxyURL('socks5://127.0.0.1:1080'), /HTTP proxy/);
    assert.throws(() => proxyURL('http://127.0.0.1:7890/path'), /HTTP proxy/);
    assert.throws(() => proxyURL('http://127.0.0.1:7890\r\n'), /HTTP proxy/);
  });

  it('parses macOS scutil --proxy output safely', () => {
    const enabled = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  ProxyAutoDiscoveryEnable : 0
}`;
    assert.equal(parseScutilProxy(enabled, 'https:'), 'http://127.0.0.1:7890/');
    assert.equal(parseScutilProxy(enabled, 'http:'), 'http://127.0.0.1:7890/');

    const disabled = `<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}`;
    assert.equal(parseScutilProxy(disabled, 'https:'), '');

    const pac = `<dictionary> {\n  ProxyAutoConfigEnable : 1\n}`;
    assert.throws(() => parseScutilProxy(pac, 'https:'), /PAC/);
  });

  it('validates filenames and GIDs strictly', () => {
    assert.equal(validateFilename('model.gguf'), 'model.gguf');
    assert.throws(() => validateFilename(''), /Invalid filename/);
    assert.throws(() => validateFilename('..'), /Invalid filename/);
    assert.throws(() => validateFilename('a/b.txt'), /Invalid filename/);
    assert.throws(() => validateFilename('a\\b.txt'), /Invalid filename/);
    assert.throws(() => validateFilename('bad\x00name.txt'), /Invalid filename/);
    if (process.platform === 'win32') {
      assert.throws(() => validateFilename('CON.txt'), /Windows filename/);
      assert.throws(() => validateFilename('bad?.txt'), /Windows filename/);
      assert.throws(() => validateFilename('trailing.'), /Windows filename/);
    }

    assert.equal(validateGid('0123456789abcdef'), '0123456789abcdef');
    assert.throws(() => validateGid('not-a-gid'), /Invalid GID/);
    assert.throws(() => validateGid('0123456789abcde'), /Invalid GID/);
  });

  it('strips sensitive fields in safeStatus', () => {
    const out = safeStatus({
      gid: '0123456789abcdef',
      status: 'active',
      totalLength: '1000',
      completedLength: '250',
      downloadSpeed: '50',
      files: [{ uris: [{ uri: 'https://secret.example/token=abc' }] }],
    });
    assert.deepEqual(out, {
      gid: '0123456789abcdef',
      status: 'active',
      totalLength: '1000',
      completedLength: '250',
      downloadSpeed: '50',
      progress: 25,
    });
    assert.equal('files' in out, false);
  });

  it('rejects a nonexistent ARIA2_BIN explicitly', () => {
    const prev = process.env.ARIA2_BIN;
    process.env.ARIA2_BIN = path.join(os.tmpdir(), 'definitely-missing-aria2c-bin');
    try {
      assert.throws(() => resolveAria2Binary(), /ARIA2_BIN points to a missing executable/);
    } finally {
      if (prev === undefined) delete process.env.ARIA2_BIN;
      else process.env.ARIA2_BIN = prev;
    }
  });
});

describe('unit: Magpie plugin contract & metadata', () => {
  it('satisfies Magpie package.json constraints', () => {
    assert.ok(Buffer.byteLength(PKG.magpie.name, 'utf8') <= 80);
    assert.ok(Buffer.byteLength(PKG.magpie.summary.en, 'utf8') <= 300);
    assert.ok(Buffer.byteLength(PKG.magpie.summary.zh, 'utf8') <= 300);
    assert.ok(PKG.magpie.icon.startsWith('data:image/svg+xml,'));
    assert.equal(PKG.mcpName, 'io.github.Neko-Yukari/aria2-mcp');
  });

  it('exports exactly one plugin factory returning valid tool definitions', async () => {
    const exportsList = Object.entries(magpieEntry);
    assert.equal(exportsList.length, 1);
    const [, factory] = exportsList[0];
    assert.equal(typeof factory, 'function');

    const hooks = await factory({});
    const toolEntries = Object.entries(hooks.tool);
    assert.deepEqual(
      toolEntries.map(([name]) => name),
      ['submit', 'status', 'list', 'control', 'wait'],
    );
    for (const [name, def] of toolEntries) {
      assert.match(name, /^[A-Za-z0-9_-]{1,48}$/);
      assert.equal(typeof def.description, 'string');
      assert.ok(def.description.length > 0);
      assert.equal(typeof def.args, 'object');
      assert.equal(typeof def.execute, 'function');
    }

    // Magpie wait enforces 50s cap (under Magpie's 55s per-tool limit)
    await assert.rejects(() => hooks.tool.wait.execute({ gid: '0123456789abcdef', timeout_seconds: 51 }), /1 and 50/);
  });
});

describe('integration: stdio MCP, CLI --wait, Magpie tools, and external RPC', () => {
  let httpServer;
  let httpPort;
  let tempDir;
  let dataDir;
  let downloadDir;
  let mcpProc;
  let pending;
  let nextId = 1;
  let mcpStderr = '';

  function mcpCall(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC timeout for ${method}`)), 20000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aria2-mcp-test-'));
    dataDir = path.join(tempDir, 'data');
    downloadDir = path.join(tempDir, 'downloads');

    httpServer = http.createServer((req, res) => {
      if (req.url === '/hello.txt') {
        const body = 'hello-from-aria2-mcp';
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (req.url === '/slow.bin') {
        const chunk = Buffer.alloc(1024, 0x7a);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk.length * 4,
          'Accept-Ranges': 'bytes',
        });
        let sent = 0;
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(timer);
            return;
          }
          res.write(chunk);
          sent++;
          if (sent >= 4) {
            clearInterval(timer);
            res.end();
          }
        }, 350);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpPort = httpServer.address().port;

    pending = new Map();
    mcpProc = spawn(process.execPath, [SERVER_FILE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ARIA2_DATA_DIR: dataDir },
    });
    mcpProc.stderr.on('data', (d) => {
      mcpStderr += d.toString();
    });
    const rl = readline.createInterface({ input: mcpProc.stdout });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    });
  });

  after(async () => {
    if (mcpProc) {
      mcpProc.stdin.end();
      await new Promise((resolve) => mcpProc.once('exit', resolve));
    }
    // Shut down only the isolated test aria2c daemon started in dataDir
    const rpcFile = path.join(dataDir, 'rpc.json');
    if (existsSync(rpcFile)) {
      try {
        const state = JSON.parse(await fs.readFile(rpcFile, 'utf8'));
        await fetch(`http://127.0.0.1:${state.port}/jsonrpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'shutdown',
            method: 'aria2.forceShutdown',
            params: [`token:${state.secret}`],
          }),
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      } catch {
        // Ignore cleanup errors
      }
    }
    httpServer?.close();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('completes MCP handshake, tools/list, download lifecycle, non-overwrite, pause/resume, CLI --wait, and error checks', async () => {
    const init = await mcpCall('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'test', version: '1.0' },
    });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'aria2-mcp');
    mcpProc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const ping = await mcpCall('ping', {});
    assert.deepEqual(ping.result, {});

    const tools = await mcpCall('tools/list', {});
    assert.deepEqual(
      tools.result.tools.map((t) => t.name),
      ['download_submit', 'download_status', 'download_list', 'download_control', 'download_wait'],
    );

    // Fast download + wait
    const sub1 = await mcpCall('tools/call', {
      name: 'download_submit',
      arguments: {
        url: `http://127.0.0.1:${httpPort}/hello.txt`,
        directory: downloadDir,
        filename: 'hello.txt',
        proxy: 'direct',
      },
    });
    assert.ok(!sub1.result.isError, sub1.result.content[0].text);
    const s1 = JSON.parse(sub1.result.content[0].text);
    assert.equal(s1.status, 'submitted');
    assert.equal(s1.filename, 'hello.txt');

    const w1 = await mcpCall('tools/call', {
      name: 'download_wait',
      arguments: { gid: s1.gid, timeout_seconds: 15 },
    });
    const w1Data = JSON.parse(w1.result.content[0].text);
    assert.equal(w1Data.status, 'complete');
    assert.equal(w1Data.timedOut, false);
    assert.equal(await fs.readFile(path.join(downloadDir, 'hello.txt'), 'utf8'), 'hello-from-aria2-mcp');

    // Non-overwrite check
    const subDup = await mcpCall('tools/call', {
      name: 'download_submit',
      arguments: {
        url: `http://127.0.0.1:${httpPort}/hello.txt`,
        directory: downloadDir,
        filename: 'hello.txt',
        proxy: 'direct',
      },
    });
    const sDup = JSON.parse(subDup.result.content[0].text);
    assert.notEqual(sDup.filename, 'hello.txt');
    const wDup = await mcpCall('tools/call', {
      name: 'download_wait',
      arguments: { gid: sDup.gid, timeout_seconds: 15 },
    });
    assert.equal(JSON.parse(wDup.result.content[0].text).status, 'complete');

    // Slow download: pause -> download_wait returns paused -> resume -> CLI --wait completes
    const subSlow = await mcpCall('tools/call', {
      name: 'download_submit',
      arguments: {
        url: `http://127.0.0.1:${httpPort}/slow.bin`,
        directory: downloadDir,
        filename: 'slow.bin',
        proxy: 'direct',
      },
    });
    const sSlow = JSON.parse(subSlow.result.content[0].text);

    const paused = await mcpCall('tools/call', {
      name: 'download_control',
      arguments: { gid: sSlow.gid, action: 'pause' },
    });
    assert.ok(!paused.result.isError);

    const waitPaused = await mcpCall('tools/call', {
      name: 'download_wait',
      arguments: { gid: sSlow.gid, timeout_seconds: 10 },
    });
    assert.equal(JSON.parse(waitPaused.result.content[0].text).status, 'paused');

    const resumed = await mcpCall('tools/call', {
      name: 'download_control',
      arguments: { gid: sSlow.gid, action: 'resume' },
    });
    assert.ok(!resumed.result.isError);

    const cliWait = await new Promise((resolve, reject) => {
      const cli = spawn(process.execPath, [SERVER_FILE, '--wait', sSlow.gid, '--timeout', '20'], {
        windowsHide: true,
        env: { ...process.env, ARIA2_DATA_DIR: dataDir },
      });
      let out = '';
      let err = '';
      cli.stdout.on('data', (d) => { out += d.toString(); });
      cli.stderr.on('data', (d) => { err += d.toString(); });
      cli.on('exit', (code) => resolve({ code, out, err }));
      cli.on('error', reject);
    });
    assert.equal(cliWait.code, 0, cliWait.err);
    assert.equal(JSON.parse(cliWait.out).status, 'complete');
    assert.equal((await fs.stat(path.join(downloadDir, 'slow.bin'))).size, 4096);

    // download_list + error checks
    const dlList = await mcpCall('tools/call', { name: 'download_list', arguments: {} });
    const listData = JSON.parse(dlList.result.content[0].text);
    assert.ok(listData.stopped.length >= 3);

    const badGid = await mcpCall('tools/call', { name: 'download_status', arguments: { gid: 'bad' } });
    assert.equal(badGid.result.isError, true);
    const badUrl = await mcpCall('tools/call', { name: 'download_submit', arguments: { url: 'ftp://example.com/x' } });
    assert.equal(badUrl.result.isError, true);
    const credUrl = await mcpCall('tools/call', {
      name: 'download_submit',
      arguments: { url: 'https://user:pass@example.com/x' },
    });
    assert.equal(credUrl.result.isError, true);
    const badTimeout = await mcpCall('tools/call', {
      name: 'download_wait',
      arguments: { gid: s1.gid, timeout_seconds: 999 },
    });
    assert.equal(badTimeout.result.isError, true);

    assert.equal(mcpStderr, '');
  });

  it('works in external RPC mode (ARIA2_RPC_URL + ARIA2_RPC_SECRET) and Magpie plugin execution', async () => {
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'rpc.json'), 'utf8'));
    const prevUrl = process.env.ARIA2_RPC_URL;
    const prevSecret = process.env.ARIA2_RPC_SECRET;
    process.env.ARIA2_RPC_URL = `http://127.0.0.1:${state.port}/jsonrpc`;
    process.env.ARIA2_RPC_SECRET = state.secret;
    try {
      const hooks = await magpieEntry.Aria2Tools();
      const submitted = await hooks.tool.submit.execute({
        url: `http://127.0.0.1:${httpPort}/hello.txt`,
        directory: downloadDir,
        filename: 'via-external-rpc.txt',
        proxy: 'direct',
      });
      const waited = await hooks.tool.wait.execute({ gid: submitted.gid, timeout_seconds: 15 });
      assert.equal(waited.status, 'complete');
      assert.equal(
        await fs.readFile(path.join(downloadDir, 'via-external-rpc.txt'), 'utf8'),
        'hello-from-aria2-mcp',
      );
    } finally {
      if (prevUrl === undefined) delete process.env.ARIA2_RPC_URL;
      else process.env.ARIA2_RPC_URL = prevUrl;
      if (prevSecret === undefined) delete process.env.ARIA2_RPC_SECRET;
      else process.env.ARIA2_RPC_SECRET = prevSecret;
    }
  });

  it('supports CLI --version and --help', async () => {
    for (const [flag, expectStr] of [
      ['--version', PKG.version],
      ['--help', 'ARIA2_RPC_URL'],
    ]) {
      const res = await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [SERVER_FILE, flag], { windowsHide: true });
        let out = '';
        p.stdout.on('data', (d) => { out += d.toString(); });
        p.on('exit', (code) => resolve({ code, out }));
        p.on('error', reject);
      });
      assert.equal(res.code, 0);
      assert.ok(res.out.includes(expectStr));
    }
  });
});
