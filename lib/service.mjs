// Cross-platform aria2 download engine:
// - Auto-manages a local detached aria2c RPC daemon by default (zero-config, private ACL/0700, session persistence)
// - Optionally connects to an external/remote aria2 RPC via ARIA2_RPC_URL (+ optional ARIA2_RPC_SECRET)
// - Fail-closed OS proxy resolution (Windows registry, macOS scutil, POSIX env) with pre-flight TCP check
// - Non-destructive filenames, strict input validation, and credential-free safe responses
import { promises as fs, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const TERMINAL_STATUSES = new Set(['complete', 'error', 'removed', 'paused']);
const SAFE_KEYS = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorCode'];

function defaultDataRoot() {
  if (process.env.ARIA2_DATA_DIR) return path.resolve(process.env.ARIA2_DATA_DIR);
  if (isWin) {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'aria2-mcp');
  }
  if (isMac) {
    return path.join(os.homedir(), 'Library', 'Application Support', 'aria2-mcp');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aria2-mcp');
}

export const root = defaultDataRoot();

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(all|https?|no)_proxy$/i.test(k)),
);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const windowsDir = process.env.SystemRoot || 'C:\\Windows';
const psExe = path.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function powershell(code) {
  const encoded = Buffer.from(`$ErrorActionPreference='Stop'; ${code}`, 'utf16le').toString('base64');
  const env = Object.fromEntries(Object.entries(cleanEnv).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
  const { stdout } = await exec(psExe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    env,
  });
  return JSON.parse(stdout.trim());
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findInDirShallow(dir, targetName, maxDepth = 2) {
  if (!dir || !existsSync(dir)) return null;
  const direct = path.join(dir, targetName);
  if (isFile(direct)) return direct;
  if (maxDepth <= 0) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findInDirShallow(path.join(dir, entry.name), targetName, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

export function resolveAria2Binary() {
  if (process.env.ARIA2_BIN) {
    const explicit = path.resolve(process.env.ARIA2_BIN);
    if (!isFile(explicit)) {
      throw new Error(`ARIA2_BIN points to a missing executable: ${explicit}`);
    }
    return explicit;
  }

  const binName = isWin ? 'aria2c.exe' : 'aria2c';
  const pathEnv = process.env.PATH || '';
  for (const rawDir of pathEnv.split(path.delimiter)) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (isFile(candidate)) return candidate;
  }

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const candidates = [
      findInDirShallow(path.join(localAppData, 'Programs', 'aria2'), 'aria2c.exe', 2),
      path.join(os.homedir(), 'scoop', 'shims', 'aria2c.exe'),
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'aria2c.exe'),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'aria2c.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'aria2', 'aria2c.exe'),
    ];
    for (const c of candidates) {
      if (c && isFile(c)) return c;
    }
    throw new Error(
      'aria2c.exe not found. Install aria2 (e.g. `winget install aria2.aria2` or `scoop install aria2`), or set ARIA2_BIN / ARIA2_RPC_URL.',
    );
  }

  const posixCandidates = isMac
    ? ['/opt/homebrew/bin/aria2c', '/usr/local/bin/aria2c', '/usr/bin/aria2c']
    : ['/usr/bin/aria2c', '/usr/local/bin/aria2c'];
  for (const c of posixCandidates) {
    if (isFile(c)) return c;
  }

  const hint = isMac ? 'brew install aria2' : 'sudo apt install aria2';
  throw new Error(`aria2c not found. Install aria2 (e.g. \`${hint}\`), or set ARIA2_BIN / ARIA2_RPC_URL.`);
}

function externalRpcConfig() {
  const rawUrl = process.env.ARIA2_RPC_URL?.trim();
  if (!rawUrl) return null;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('Invalid ARIA2_RPC_URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('ARIA2_RPC_URL must use http:// or https://');
  }
  const secret = process.env.ARIA2_RPC_SECRET || '';
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname.toLowerCase());
  return { url: u, secret, external: true, isLoopback };
}

async function secureRoot(dataRoot) {
  await fs.mkdir(dataRoot, { recursive: true, ...(isWin ? {} : { mode: 0o700 }) });
  if (!isWin) {
    await fs.chmod(dataRoot, 0o700);
    return;
  }
  const sid = await powershell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json -Compress');
  await exec(
    path.join(windowsDir, 'System32', 'icacls.exe'),
    [dataRoot, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`],
    { windowsHide: true, env: cleanEnv },
  );
  const check = await powershell(
    `$a=Get-Acl -LiteralPath '${dataRoot.replaceAll("'", "''")}'; @{protected=$a.AreAccessRulesProtected;allowed=@($a.Access | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress`,
  );
  if (!check.protected || check.allowed.some((s) => ![sid, 'S-1-5-18', 'S-1-5-32-544'].includes(s))) {
    throw new Error('Private aria2 directory ACL verification failed');
  }
}

function rpc(state, method, params = []) {
  return new Promise((resolve, reject) => {
    const rpcParams = state.secret ? [`token:${state.secret}`, ...params] : [...params];
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: `aria2.${method}`,
      params: rpcParams,
    });

    const isExternal = Boolean(state.url);
    const transport = isExternal && state.url.protocol === 'https:' ? https : http;
    const reqOptions = isExternal
      ? {
          protocol: state.url.protocol,
          hostname: state.url.hostname,
          port: state.url.port || (state.url.protocol === 'https:' ? 443 : 80),
          path: `${state.url.pathname || '/jsonrpc'}${state.url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        }
      : {
          host: '127.0.0.1',
          port: state.port,
          path: '/jsonrpc',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        };

    const req = transport.request(reqOptions, (res) => {
      let text = '';
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(text);
          if (data.error) reject(new Error(`aria2 RPC error ${data.error.code}`));
          else resolve(data.result);
        } catch {
          reject(new Error('Invalid aria2 RPC response'));
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new Error('aria2 RPC unavailable')));
    req.end(body);
  });
}

async function currentLocal(statePath) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    await rpc(state, 'getVersion');
    return { ...state, isLoopback: true };
  } catch {
    return null;
  }
}

export async function engine() {
  const ext = externalRpcConfig();
  if (ext) {
    await rpc(ext, 'getVersion');
    return ext;
  }

  const dataRoot = defaultDataRoot();
  const statePath = path.join(dataRoot, 'rpc.json');
  const sessionPath = path.join(dataRoot, 'downloads.session');

  let state = await currentLocal(statePath);
  if (state) return state;

  const exe = resolveAria2Binary();
  await secureRoot(dataRoot);

  const lock = path.join(dataRoot, 'startup.lock');
  let handle;
  for (let n = 0; n < 100; n++) {
    try {
      handle = await fs.open(lock, 'wx');
      await handle.writeFile(String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      state = await currentLocal(statePath);
      if (state) return state;
      const pid = Number(await fs.readFile(lock, 'utf8').catch(() => ''));
      if (pid) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') await fs.unlink(lock).catch(() => {});
        }
      }
      await sleep(100);
    }
  }
  if (!handle) throw new Error('aria2 startup lock busy; retry later');

  try {
    state = await currentLocal(statePath);
    if (state) return state;

    const previous = JSON.parse(await fs.readFile(statePath, 'utf8').catch(() => 'null'));
    if (previous?.pid) {
      let alive = false;
      try {
        process.kill(previous.pid, 0);
        alive = true;
      } catch (e) {
        if (e.code !== 'ESRCH') alive = true;
      }
      if (alive) {
        throw new Error('Existing aria2 process is not responding; retry later rather than starting a duplicate');
      }
    }

    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));

    state = { port, secret: crypto.randomBytes(32).toString('hex'), isLoopback: true };
    if (!existsSync(sessionPath)) await fs.writeFile(sessionPath, '', { flag: 'wx' });

    const config = [
      'enable-rpc=true',
      'rpc-listen-all=false',
      `rpc-listen-port=${port}`,
      `rpc-secret=${state.secret}`,
      'rpc-allow-origin-all=false',
      'disable-ipv6=true',
      'continue=true',
      'allow-overwrite=false',
      'auto-file-renaming=true',
      'auto-save-interval=10',
      'save-session-interval=10',
      `save-session=${sessionPath}`,
      `input-file=${sessionPath}`,
      'file-allocation=none',
      'check-certificate=true',
      'console-log-level=error',
      'summary-interval=0',
      'enable-color=false',
    ].join('\n');

    const conf = path.join(dataRoot, 'aria2.conf');
    await fs.writeFile(conf, config);

    const child = spawn(exe, [`--conf-path=${conf}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: cleanEnv,
    });
    let failed = false;
    child.on('error', () => {
      failed = true;
    });
    child.unref();

    for (let n = 0; n < 100; n++) {
      if (failed) throw new Error('aria2 executable could not start');
      try {
        await rpc(state, 'getVersion');
        state.pid = child.pid;
        await fs.writeFile(statePath, JSON.stringify({ port: state.port, secret: state.secret, pid: state.pid }));
        return state;
      } catch {
        await sleep(100);
      }
    }
    child.kill();
    throw new Error('aria2 startup failed');
  } finally {
    await handle.close();
    await fs.unlink(lock).catch(() => {});
  }
}

export function proxyURL(value) {
  let u;
  try {
    u = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    throw new Error('Invalid HTTP proxy');
  }
  if (u.protocol !== 'http:' || !u.hostname || u.pathname !== '/' || u.search || u.hash || /[\r\n\0]/.test(value)) {
    throw new Error('Proxy must be an HTTP proxy URL');
  }
  return u.href;
}

export function parseScutilProxy(stdout, protocol = 'https:') {
  const dict = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (m) dict[m[1]] = m[2];
  }
  if (dict.ProxyAutoConfigEnable === '1' || dict.ProxyAutoDiscoveryEnable === '1') {
    throw new Error('macOS PAC/automatic proxy discovery is unsupported; select direct or an explicit HTTP proxy');
  }
  const isHttps = protocol === 'https:';
  const enabled = isHttps ? dict.HTTPSEnable === '1' : dict.HTTPEnable === '1';
  if (!enabled) return '';
  const host = isHttps ? dict.HTTPSProxy : dict.HTTPProxy;
  const port = isHttps ? dict.HTTPSPort : dict.HTTPPort;
  if (!host) throw new Error('macOS proxy is enabled without a proxy host');
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return proxyURL(port ? `http://${hostPart}:${port}` : `http://${hostPart}`);
}

export async function resolveProxy(value, protocol = 'https:') {
  const mode = value === undefined ? process.env.ARIA2_DEFAULT_PROXY || 'system' : value;
  if (typeof mode !== 'string') throw new Error('Invalid proxy mode');
  if (mode === 'direct') return '';
  if (mode !== 'system') return proxyURL(mode);

  if (isWin) {
    const p = await powershell(
      "$p=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; @{enabled=$p.ProxyEnable;server=$p.ProxyServer;pac=$p.AutoConfigURL;autoDetect=$p.AutoDetect} | ConvertTo-Json -Compress",
    );
    if (p.pac || p.autoDetect) {
      throw new Error('Windows PAC/automatic proxy discovery is unsupported; select direct or an explicit HTTP proxy');
    }
    if (!p.enabled) return '';
    if (!p.server) throw new Error('Windows proxy is enabled without a proxy server');
    if (!p.server.includes('=')) return proxyURL(p.server);
    const entries = Object.fromEntries(p.server.split(';').map((s) => s.trim().split('=')));
    const selected = entries[protocol.slice(0, -1)];
    if (!selected) throw new Error('Windows has no proxy for this URL protocol; select direct explicitly');
    return proxyURL(selected);
  }

  if (isMac) {
    try {
      const { stdout } = await exec('/usr/sbin/scutil', ['--proxy'], { env: cleanEnv });
      const macProxy = parseScutilProxy(stdout, protocol);
      if (macProxy) return macProxy;
    } catch (err) {
      if (err?.message?.includes('macOS')) throw err;
    }
  }

  const key = protocol.slice(0, -1).toLowerCase();
  const raw =
    process.env[`${key}_proxy`] ||
    process.env[`${key.toUpperCase()}_PROXY`] ||
    process.env.all_proxy ||
    process.env.ALL_PROXY ||
    '';
  return raw ? proxyURL(raw) : '';
}

async function checkProxy(value) {
  if (!value) return;
  const u = new URL(value);
  await new Promise((resolve, reject) => {
    const socket = net.connect({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port || 80),
    });
    socket.setTimeout(5000);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    const fail = () => {
      socket.destroy();
      reject(new Error('Selected proxy is unavailable; direct fallback is disabled'));
    };
    socket.once('error', fail);
    socket.once('timeout', fail);
  });
}

const hasControl = (text, last = 0x1f) => [...text].some((c) => c.codePointAt(0) <= last);

export function validateFilename(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 180 ||
    /[/\\]/.test(value) ||
    hasControl(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new Error('Invalid filename');
  }
  if (
    isWin &&
    (/[<>:"|?*]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value))
  ) {
    throw new Error('Invalid Windows filename');
  }
  return value;
}

export function validateGid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{16}$/i.test(value)) throw new Error('Invalid GID');
  return value;
}

export function safeStatus(item) {
  return {
    ...Object.fromEntries(SAFE_KEYS.map((k) => [k, item[k]]).filter(([, v]) => v !== undefined)),
    progress: Number(item.totalLength)
      ? Math.round((Number(item.completedLength) / Number(item.totalLength)) * 10000) / 100
      : null,
  };
}

export async function download(args = {}) {
  let u;
  try {
    u = new URL(args.url);
  } catch {
    throw new Error('Invalid HTTP(S) download URL');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || hasControl(args.url, 0x20)) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  }

  const state = await engine();
  const proxy = await resolveProxy(args.proxy, u.protocol);
  if (state.isLoopback) {
    await checkProxy(proxy);
  }

  let name = args.filename;
  if (name === undefined) {
    try {
      name = validateFilename(decodeURIComponent(u.pathname.split('/').pop() || ''));
    } catch {
      name = `download-${crypto.randomUUID()}`;
    }
  }
  validateFilename(name);

  let resolvedDir;
  if (state.isLoopback) {
    const directory = args.directory ?? process.env.ARIA2_DEFAULT_DIR ?? path.join(os.homedir(), 'Downloads');
    if (
      typeof directory !== 'string' ||
      (isWin ? !/^[a-z]:[\\/]/i.test(directory) : !path.isAbsolute(directory)) ||
      hasControl(directory)
    ) {
      throw new Error(isWin ? 'Directory must be an absolute local Windows path' : 'Directory must be an absolute local path');
    }
    await fs.mkdir(directory, { recursive: true });
    if (existsSync(path.join(directory, name)) || existsSync(path.join(directory, `${name}.aria2`))) {
      const ext = path.extname(name);
      name = `${path.basename(name, ext)}-${crypto.randomUUID()}${ext}`;
    }
    resolvedDir = path.resolve(directory);
  } else if (args.directory !== undefined) {
    if (typeof args.directory !== 'string' || !args.directory || hasControl(args.directory)) {
      throw new Error('Invalid remote directory path');
    }
    resolvedDir = args.directory;
  }

  const options = {
    ...(resolvedDir ? { dir: resolvedDir } : {}),
    out: name,
    'all-proxy': proxy,
    'http-proxy': proxy,
    'https-proxy': proxy,
    'no-proxy': '',
    'allow-overwrite': 'false',
    'auto-file-renaming': 'true',
    continue: 'true',
  };

  const id = await rpc(state, 'addUri', [[u.href], options]);
  if (!state.external) {
    await rpc(state, 'saveSession').catch(() => {});
  }

  return {
    gid: id,
    ...(resolvedDir ? { directory: resolvedDir } : {}),
    filename: name,
    proxy: proxy ? 'http-proxy' : 'direct',
    status: 'submitted',
  };
}

export async function status(id) {
  return safeStatus(await rpc(await engine(), 'tellStatus', [validateGid(id), SAFE_KEYS]));
}

export async function list() {
  const state = await engine();
  const [active, waiting, stopped] = await Promise.all([
    rpc(state, 'tellActive', [SAFE_KEYS]),
    rpc(state, 'tellWaiting', [0, 100, SAFE_KEYS]),
    rpc(state, 'tellStopped', [0, 100, SAFE_KEYS]),
  ]);
  return {
    active: active.map(safeStatus),
    waiting: waiting.map(safeStatus),
    stopped: stopped.map(safeStatus),
    limitPerQueue: 100,
  };
}

export async function control({ gid: id, action } = {}) {
  validateGid(id);
  const method = { pause: 'forcePause', resume: 'unpause', cancel: 'forceRemove' }[action];
  if (!method) throw new Error('Invalid download action');
  const state = await engine();
  await rpc(state, method, [id]);
  if (!state.external) {
    await rpc(state, 'saveSession').catch(() => {});
  }
  return { gid: id, action, ...(action === 'cancel' ? { partialFilesRetained: true } : {}) };
}

export async function waitForDownload(id, timeoutSeconds, { maxTimeout = 120, signal } = {}) {
  validateGid(id);
  if (
    typeof timeoutSeconds !== 'number' ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 0 ||
    timeoutSeconds > maxTimeout
  ) {
    throw new Error(`timeout_seconds must be between 1 and ${maxTimeout}`);
  }
  const deadline = timeoutSeconds === 0 ? Infinity : Date.now() + timeoutSeconds * 1000;
  const startedAt = Date.now();

  let current = await status(id);
  while (!TERMINAL_STATUSES.has(current.status)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ...current,
        timedOut: true,
        note: 'Still in progress. Avoid tight polling: continue other work, check status later, or use the CLI --wait mode in a background command.',
      };
    }
    const interval = Date.now() - startedAt < 10_000 ? 1000 : 2000;
    await sleep(Math.min(interval, remaining), signal);
    current = await status(id);
  }

  return {
    ...current,
    timedOut: false,
    ...(current.status === 'paused'
      ? { note: 'Download is paused; call control(action="resume") to continue.' }
      : {}),
  };
}
