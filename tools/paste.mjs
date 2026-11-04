/**
 * `computer_paste` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 1）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
export function registerComputerPaste(env) {
  const { safeRegister, defineTracedTool, requireGrant, call, normalizeTextTarget } = env;
  safeRegister(defineTracedTool({
    name: 'computer_paste',
    description:
      "Put text into the focused control by pasting rather than typing: typing sends each character as a synthesized keystroke, which some editors and any IME-hostile app mangle, while a paste is one atomic gesture and the only dependable way to move a long or non-ASCII string. The user's clipboard is borrowed and put back, and `restoreStatus` says which of the six outcomes happened — including \"something else wrote to the clipboard after us, so its newer content was kept\". `require_restore: true` refuses instead of pasting when the clipboard cannot be put back; `verify` with a readable control confirms the text arrived rather than only that keys were sent. Focus the target field first (click it, or computer_ui_action with 'focus'). Requires 电脑操作.",
    parameters: {
      text: { type: 'string', required: true, description: 'The text to paste.' },
      restore: { type: 'boolean', description: "Put the user's previous clipboard content back afterwards (default true). Set false if you are about to read what you pasted, or to keep your text on the clipboard for a later paste." },
      require_restore: { type: 'boolean', description: "Refuse before writing anything when the clipboard cannot be saved and put back (another application holds it open, or it holds formats this path cannot restore). For when the user's clipboard matters more than this paste; the default acts and reports what happened." },
      verify: {
        type: 'object',
        additionalProperties: false,
        description: 'A control to read back after the paste, turning "the events were sent" into a postcondition: the reply says whether the pasted text is in it. Same shape as computer_ui\'s text_target. Without it the caller only learns that the keys went out.',
        properties: {
          ref: { type: 'string', description: 'A [s#.#] marker from a computer_ui read.' },
          automation_id: { type: 'string' },
          name: { type: 'string' },
          control_type: { type: 'string' },
          class_name: { type: 'string' },
          index: { type: 'integer' },
          hwnd: { type: 'integer', description: 'Window to read in; defaults to into_hwnd.' },
        },
      },
      into_hwnd: { type: 'integer', description: 'Only send if this window (an hwnd from computer_windows) is the one that would receive it; a mismatch is refused before anything is sent. Same guard as computer_type.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pasted: { type: 'integer', required: true },
          restored: { type: 'boolean', required: true },
          savedUser: { type: 'boolean', required: true },
          restoreStatus: {
            type: 'string',
            required: true,
            enum: ['restored', 'not_requested', 'skipped_external_change', 'unsupported_original_format', 'failed_busy', 'failed_other'],
            description: 'What happened to the clipboard: `restored` (borrowed content is back), `not_requested` (restore was off), `skipped_external_change` (somebody wrote to it after us, so their newer content was kept), `unsupported_original_format` (the original was an image/files/markup that this path cannot put back), `failed_busy` (another application held it open), `failed_other`.',
          },
          restoreNote: { type: 'string', description: 'The sentence behind a restore_status that is not `restored`.' },
          eventsSent: { type: 'integer', required: true, description: 'Keyboard events the paste actually delivered — 0 means nothing was sent.' },
          foreground: { type: 'string', required: true },
          clipboard: {
            type: 'object',
            additionalProperties: false,
            required: true,
            description: 'The clipboard sequence numbers this borrow was judged against: the change from `seqBefore` to `seqAfterWrite` is our write, and any further change is somebody else\'s.',
            properties: {
              formatsBefore: { type: 'array', items: { type: 'string' }, required: true },
              seqBefore: { type: 'integer', required: true },
              seqAfterWrite: { type: 'integer', required: true },
            },
          },
          pasteVerification: {
            type: 'object',
            additionalProperties: false,
            description: 'Present when `verify` named a control to read back.',
            properties: {
              status: { type: 'string', required: true, enum: ['verified', 'absent', 'unknown'] },
              source: { type: 'string' },
              note: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [`Pasted ${value.pasted} character(s) into ${value.foreground} (${value.eventsSent} key event(s) sent).`];
        const restore = value.restoreStatus ?? (value.restored ? 'restored' : 'failed_other');
        const wording = {
          restored: "The user's previous clipboard content was restored.",
          not_requested: 'The clipboard was left holding the pasted text (restore was off).',
          skipped_external_change: "The clipboard was NOT restored: something else wrote to it after this paste, and that newer content was left in place rather than deleted.",
          unsupported_original_format: "The clipboard was NOT fully restored: what was there before was not text this path can put back.",
          failed_busy: 'The clipboard could NOT be restored: another application was holding it open. It now holds the pasted text.',
          failed_other: 'The clipboard could NOT be restored: the write failed.',
        };
        lines.push(wording[restore] ?? `Clipboard restore: ${restore}.`);
        if (value.restoreNote !== undefined) lines.push(value.restoreNote);
        if (value.pasteVerification !== undefined) {
          const verification = value.pasteVerification;
          if (verification.status === 'verified') lines.push(`Verified: ${verification.note ?? 'the pasted text is in the control'}.`);
          else if (verification.status === 'absent') lines.push('NOT verified: the control was read and the pasted text is not in it — the paste did not arrive.');
          else lines.push(`Not verified: ${verification.note ?? 'the control could not be read back'}.`);
        }
        lines.push('A paste lands wherever the keyboard focus is; without `verify` the reply cannot confirm it arrived.');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      if (typeof args.text !== 'string' || args.text === '') throw new Error('[BAD_REQUEST] computer_paste needs the text to paste.');
      const verify = normalizeTextTarget(args.verify);
      const result = await call(exec, 'paste', {
        intoHwnd: args.into_hwnd,
        text: args.text,
        restore: args.restore,
        requireRestore: args.require_restore === true ? true : undefined,
        verify,
      }, { interactive: true });
      const fg = result.foreground ?? {};
      const value = {
        pasted: Number(result.pasted ?? 0),
        restored: result.restored === true,
        savedUser: result.savedUser === true,
        restoreStatus: String(result.restoreStatus ?? (result.restored === true ? 'restored' : 'failed_other')),
        eventsSent: Number(result.eventsSent ?? result.events ?? 0),
        foreground: `${fg.title ? `"${fg.title}"` : '(untitled window)'}${fg.process ? ` [${fg.process}]` : ''}`,
        clipboard: {
          formatsBefore: Array.isArray(result.clipboard?.formatsBefore) ? result.clipboard.formatsBefore.map((one) => String(one)) : [],
          seqBefore: Number(result.clipboard?.seqBefore ?? -1),
          seqAfterWrite: Number(result.clipboard?.seqAfterWrite ?? -1),
        },
      };
      if (typeof result.restoreNote === 'string' && result.restoreNote !== '') value.restoreNote = result.restoreNote;
      if (result.pasteVerification !== undefined && result.pasteVerification !== null) {
        value.pasteVerification = {
          status: String(result.pasteVerification.status ?? 'unknown'),
          ...(typeof result.pasteVerification.source === 'string' && result.pasteVerification.source !== '' ? { source: result.pasteVerification.source } : {}),
          ...(typeof result.pasteVerification.note === 'string' && result.pasteVerification.note !== '' ? { note: result.pasteVerification.note } : {}),
        };
      }
      return value;
    },
  }));
}
