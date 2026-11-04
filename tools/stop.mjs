/**
 * `computer_stop` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
import { sessionKey } from '../internal/sessions.mjs';
export function registerComputerStop(env) {
  const { safeRegister, defineTracedTool, requireGrant, call, revokeSession, actionTimeoutMs, ctx } = env;
  safeRegister(defineTracedTool({
    name: 'computer_stop',
    description:
      "Release any mouse button or key this session is still holding down, and optionally hand the capability back to the user. Use it when a gesture was interrupted — a drag that never got its release leaves the desktop holding a button the user cannot shake off. Calling it with disable_capability turns 电脑操作 off for this session, after which every computer_* call is refused until the user switches the chip back on: that is a kill switch, not a pause. Requires 电脑操作.",
    parameters: {
      release_input: { type: 'boolean', description: 'Release anything still held down (default true).' },
      disable_capability: { type: 'boolean', description: 'Also turn the capability off for this session, so nothing can drive the desktop until the user re-enables it (default false).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          released: { type: 'array', required: true, items: { type: 'string' } },
          count: { type: 'integer', required: true },
          note: { type: 'string', required: true },
          disabled: { type: 'boolean' },
          cancelled: { type: 'integer' },
          releaseConfirmed: { type: 'boolean', description: 'Whether the worker confirmed that the input it was holding was released. The capability being off and the input being released are two different facts (§8.4).' },
          releaseError: { type: 'string', description: 'Why the release could not be confirmed, when it could not. A stop that reports success while a key may still be down is the one answer a user must never get.' },
        },
      },
      render: (_args, value) => {
        // Everything the stop actually established, said one fact at a time. The old version
        // printed "Nothing was held down." from `count`, so a release that *failed* — whose
        // reason was already in `note` — read as a clean stop (§8.4, evidence HOST03).
        const lines = [];
        if (value.disabled === true) lines.push('电脑操作 is now OFF for this session; ask the user to click the 电脑操作 chip to enable it again.');
        if (value.count === 0) {
          lines.push(value.releaseConfirmed === false
            ? 'Nothing was confirmed released: the worker was asked to unwind any held input and that did not succeed.'
            : 'Nothing was held down.');
        } else {
          lines.push(`Released: ${value.released.join(', ')}.`);
        }
        if (value.releaseConfirmed === false) {
          lines.push(`Release not confirmed: ${value.releaseError ?? value.note}`);
          lines.push('A key or a mouse button may still be down: click once yourself, or press and release shift, before doing anything else, and check the input state again.');
        }
        if (value.cancelled !== undefined && value.cancelled > 0) lines.push(`${value.cancelled} request(s) that were still running or queued were cancelled, so the steps after this point did not run.`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      const value = { released: [], count: 0, note: 'nothing was held down' };
      if (args.disable_capability === true) {
        // Turning it off is a stop, not a flag: revoke first, then cancel what is in
        // flight, then unwind anything the worker is still holding. Reporting "off" while
        // a batch is still clicking would be the worst kind of lie about a safety control.
        const outcome = await revokeSession(exec?.agent?.session?.id, 'the capability was turned off by computer_stop');
        value.released = outcome.released;
        value.count = outcome.released.length;
        value.note = outcome.error === '' ? 'the session was revoked and the desktop was unwound' : `the session was revoked, but releasing held input failed: ${outcome.error}`;
        value.disabled = true;
        value.cancelled = outcome.cancelled;
        // The release result is its own fact (§8.4): "the capability is off" and "the input
        // was confirmed released" are two different answers, and the renderer needs the
        // second one separately or it ends up printing a success it never verified.
        value.releaseConfirmed = outcome.error === '';
        if (outcome.error !== '') value.releaseError = outcome.error;
        ctx.logger?.info?.('computer-use: session %s was disabled by computer_stop (%d cancelled)', sessionKey(exec?.agent?.session?.id), outcome.cancelled);
        return value;
      }
      if (args.release_input !== false) {
        try {
          const result = await call(exec, 'release', {}, { timeoutMs: Math.max(actionTimeoutMs, 10_000) });
          value.released = Array.isArray(result.released) ? result.released.map((r) => String(r)) : [];
          value.count = Number(result.count ?? value.released.length);
          value.note = String(result.note ?? value.note);
          value.releaseConfirmed = true;
        } catch (failure) {
          // A release that failed is reported as failed. Saying "nothing was held down"
          // because the answer never arrived is the one outcome a user must never be given
          // about a key or a button that may still be down (§8.4).
          value.note = `releasing held input failed: ${failure?.message ?? failure}`;
          value.releaseConfirmed = false;
          value.releaseError = String(failure?.message ?? failure);
        }
      }
      return value;
    },
  }));
}
