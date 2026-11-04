/**
 * `computer_launch` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
export function registerComputerLaunch(env) {
  const { safeRegister, defineTracedTool, requireGrant, call, managedBrowsers, actionTimeoutMs } = env;
  safeRegister(defineTracedTool({
    name: 'computer_launch',
    description:
      'Start an application and return the window it opened, so the next call can act on it: this is how a task that needs "open the editor" gets started without shelling out. `target` accepts an executable path, a name on PATH, a Start-menu display name (including a localized one such as 计算器, 微信), or an installed app name. Requires 电脑操作.',
    parameters: {
      target: { type: 'string', required: true, description: 'What to start. Examples: "notepad", "C:\\Program Files\\App\\App.exe", "计算器", "Photoshop".' },
      arguments: { type: 'array', items: { type: 'string' }, description: 'Optional command-line arguments, as separate strings.' },
      wait_seconds: { type: 'number', description: 'How long to wait for the application to show a window (default 8, maximum 30). Many apps open their window well after the process starts.' },
      refresh_discovery: { type: 'boolean', description: 'Rebuild the Start-menu, app-table and usage caches before resolving (default false). They are kept for 60–120 s, which is what makes a fuzzy name cheap to resolve; refresh after installing something.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          resolvedAs: { type: 'string', required: true },
          file: { type: 'string', required: true },
          pid: { type: 'integer', required: true },
          process: { type: 'string', required: true },
          hwnd: { type: 'integer', required: true },
          title: { type: 'string', required: true },
          waitedMs: { type: 'integer', required: true },
          matchedBy: { type: 'string', required: true },
          note: { type: 'string', required: true },
          label: { type: 'string', description: 'The display name this resolved to (a Start-menu entry or an installed app), when it was not a plain path.' },
          source: { type: 'string', description: "How it was found: 'path', 'command' (a PATH lookup or an explicit command line), 'shortcut' (a Start-menu entry), 'start-app-path' (a classic app the shell lists) or 'store' (a packaged app, started through the shell)." },
          matchBasis: { type: 'string', description: "Why this resolution won: 'explicit path', 'explicit command', 'on PATH', 'exact name' or 'name match'." },
          wasRunning: { type: 'boolean', required: true, description: 'Whether it was already running when it was launched — what explains a launch that handed off to an existing instance.' },
          useCount: { type: 'integer', required: true, description: 'How often the shell remembers switching to this application. Read `useCountKnown`: 0 with useCountKnown false means "no usable history", not "never used".' },
          useCountKnown: { type: 'boolean', required: true },
          candidates: {
            type: 'array',
            description: 'The other applications the name matched, with the same signals. Present when a fuzzy name had runners-up — worth a look when the launch opened something you did not expect.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                source: { type: 'string', required: true },
                matchBasis: { type: 'string', required: true },
                isRunning: { type: 'boolean', required: true },
                useCount: { type: 'integer', required: true },
                useCountKnown: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`Started ${value.process} (pid ${value.pid}) as a ${value.resolvedAs}: ${value.file}`];
        if (value.label !== undefined && value.label !== value.file) lines.push(`Resolved through ${value.source ?? 'a name'}: "${value.label}"${value.matchBasis === undefined ? '' : ` (${value.matchBasis})`}.`);
        if (value.hwnd !== 0) {
          lines.push(`Its window: hwnd=${value.hwnd} "${value.title}" — pass this hwnd to computer_windows, computer_ui or the batch's focus step to act on it.`);
        } else {
          lines.push('No window appeared within the wait.');
        }
        if (value.process === 'ApplicationFrameHost') {
          lines.push('That process name is the host Windows gives packaged (Store) apps, not the app itself — act on the window handle, not on the process name.');
        }
        if (value.note !== '') lines.push(value.note);
        if (value.wasRunning === true) lines.push('It was already running, so this launch may have handed off to that instance rather than starting a new one.');
        lines.push(value.useCountKnown === true
          ? `The shell remembers ${value.useCount} switch(es) to it.`
          : 'No usable shell history for it (that is not the same as never used).');
        if (Array.isArray(value.candidates) && value.candidates.length > 0) {
          lines.push(`Other candidates the name matched: ${value.candidates.map((one) => `"${one.label}" (${one.source}${one.isRunning ? ', running' : ''}${one.useCountKnown ? `, used ${one.useCount}x` : ''})`).join('; ')} — if the wrong application opened, name one of these exactly.`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      if (typeof args.target !== 'string' || args.target.trim() === '') throw new Error('[BAD_REQUEST] computer_launch needs a target.');
      const result = await call(exec, 'launch', {
        target: args.target,
        arguments: Array.isArray(args.arguments) ? args.arguments.map((a) => String(a)) : undefined,
        waitSeconds: args.wait_seconds,
        refresh: args.refresh_discovery === true ? true : undefined,
      }, { timeoutMs: Math.max(actionTimeoutMs, 40_000) });
      const value = {
        resolvedAs: String(result.resolvedAs ?? ''),
        file: String(result.file ?? ''),
        pid: Number(result.pid ?? 0),
        process: String(result.process ?? ''),
        hwnd: Number(result.hwnd ?? 0),
        title: String(result.title ?? ''),
        waitedMs: Number(result.waitedMs ?? 0),
        matchedBy: String(result.matchedBy ?? ''),
        note: String(result.note ?? ''),
        wasRunning: result.wasRunning === true,
        useCount: Number(result.useCount ?? 0),
        useCountKnown: result.useCountKnown === true,
      };
      // A browser this plugin started is the one instance whose provenance is known (§10): the
      // debugging flags it was launched with are recorded here, so `browser_state` and
      // `browser_actions` can attach to it without anything having to be configured.
      const launchArgs = Array.isArray(args.arguments) ? args.arguments.map((one) => String(one)) : [];
      const portFlag = launchArgs.find((one) => one.startsWith('--remote-debugging-port='));
      const dirFlag = launchArgs.find((one) => one.startsWith('--user-data-dir='));
      if (portFlag !== undefined || dirFlag !== undefined) {
        const port = portFlag === undefined ? 0 : Number.parseInt(portFlag.slice('--remote-debugging-port='.length), 10);
        managedBrowsers.set(String(exec?.agent?.session?.id ?? ''), {
          endpoint: Number.isFinite(port) && port > 0 ? `http://127.0.0.1:${port}` : '',
          port: Number.isFinite(port) ? port : 0,
          profileDir: dirFlag === undefined ? '' : dirFlag.slice('--user-data-dir='.length),
          pid: Number(result.pid ?? 0),
        });
      }
      if (typeof result.label === 'string' && result.label !== '') value.label = result.label;
      if (typeof result.source === 'string' && result.source !== '') value.source = result.source;
      if (typeof result.matchBasis === 'string' && result.matchBasis !== '') value.matchBasis = result.matchBasis;
      if (Array.isArray(result.candidates) && result.candidates.length > 0) {
        value.candidates = result.candidates.map((one) => ({
          label: String(one?.label ?? ''),
          source: String(one?.source ?? ''),
          matchBasis: String(one?.matchBasis ?? ''),
          isRunning: one?.isRunning === true,
          useCount: Number(one?.useCount ?? 0),
          useCountKnown: one?.useCountKnown === true,
        }));
      }
      return value;
    },
  }));
}
