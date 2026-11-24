// Shared tool definitions and execution dispatch for both stdio MCP (server.mjs) and Magpie plugin (index.mjs).
import { download, status, list, control, waitForDownload } from './service.mjs';

const stringProp = { type: 'string' };
const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export function assertArgsObject(args) {
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return args ?? {};
}

export function buildToolSpecs({ cliHint, waitMaxSeconds = 120, namePrefix = 'download_' } = {}) {
  const submitName = `${namePrefix}submit`;
  const statusName = `${namePrefix}status`;
  const listName = `${namePrefix}list`;
  const controlName = `${namePrefix}control`;
  const waitName = `${namePrefix}wait`;

  const bgHint = cliHint ? ` or run \`${cliHint} --wait <gid>\` in a background shell` : '';

  return [
    {
      name: submitName,
      shortName: 'submit',
      description:
        'Download an HTTP(S) file to disk in the background via local aria2c; returns a GID, not proof of completion. ' +
        `Call ${waitName} for short/medium files, or check ${statusName} later${bgHint} before reporting success or consuming the file. ` +
        'Defaults to the OS system proxy and Downloads; use direct or an explicit HTTP proxy when requested. ' +
        'Keep global and system proxy settings unchanged, report a proxy failure instead of silently switching to direct, and keep URLs and proxy credentials out of chat. ' +
        'Existing files stay untouched. For webpage reading, API calls, Git or package managers, use the dedicated tool. ' +
        'If a requested download feature is unsupported, explain the limitation before choosing another method.',
      inputSchema: objectSchema(
        {
          url: stringProp,
          directory: stringProp,
          filename: stringProp,
          proxy: {
            type: 'string',
            description: 'system (default), direct, or explicit http://host:port. PAC is unsupported.',
          },
        },
        ['url'],
      ),
      async execute(rawArgs) {
        const args = assertArgsObject(rawArgs);
        return download({
          url: args.url,
          ...(args.directory !== undefined ? { directory: args.directory } : {}),
          ...(args.filename !== undefined ? { filename: args.filename } : {}),
          ...(args.proxy !== undefined ? { proxy: args.proxy } : {}),
        });
      },
    },
    {
      name: statusName,
      shortName: 'status',
      description:
        'Get download progress, speed and safe error code by GID. Confirm status=complete before claiming success or using the downloaded file; ' +
        'active, waiting and paused are not completion. Report errors honestly and avoid tight polling loops.',
      inputSchema: objectSchema({ gid: stringProp }, ['gid']),
      async execute(rawArgs) {
        const args = assertArgsObject(rawArgs);
        return status(args.gid);
      },
    },
    {
      name: listName,
      shortName: 'list',
      description:
        'List background downloads (active, waiting, recently stopped) in the aria2 daemon. ' +
        `Find an existing task before submitting a duplicate; use ${statusName} for the selected GID.`,
      inputSchema: objectSchema({}),
      async execute() {
        return list();
      },
    },
    {
      name: controlName,
      shortName: 'control',
      description:
        'Pause, resume or cancel a download by GID. Cancel retains partial files and does not delete them. ' +
        `Resume continues the same GID and partial data; query ${statusName} afterward to verify the resulting state.`,
      inputSchema: objectSchema(
        {
          gid: stringProp,
          action: { type: 'string', enum: ['pause', 'resume', 'cancel'] },
        },
        ['gid', 'action'],
      ),
      async execute(rawArgs) {
        const args = assertArgsObject(rawArgs);
        return control({ gid: args.gid, action: args.action });
      },
    },
    {
      name: waitName,
      shortName: 'wait',
      description:
        `Wait up to timeout_seconds (default 30, max ${waitMaxSeconds}) for a download GID to reach complete, error, removed, or paused without tight polling. ` +
        `If timedOut=true, do not loop ${waitName} tightly: continue other work, check ${statusName} later${bgHint}.`,
      inputSchema: objectSchema(
        {
          gid: stringProp,
          timeout_seconds: {
            type: 'number',
            description: `Maximum seconds to wait (1 to ${waitMaxSeconds}, default 30).`,
          },
        },
        ['gid'],
      ),
      async execute(rawArgs, ctx) {
        const args = assertArgsObject(rawArgs);
        const timeout = args.timeout_seconds === undefined ? 30 : args.timeout_seconds;
        if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1 || timeout > waitMaxSeconds) {
          throw new Error(`timeout_seconds must be between 1 and ${waitMaxSeconds}`);
        }
        return waitForDownload(args.gid, timeout, { maxTimeout: waitMaxSeconds, signal: ctx?.abort });
      },
    },
  ];
}
