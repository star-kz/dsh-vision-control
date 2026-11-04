/**
 * `computer_ui_action` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 2）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
import { UIA_ACTION_LIST } from '../internal/failures.mjs';
export function registerComputerUiAction(env) {
  const { safeRegister, defineTracedTool, refs, requireGrant, call, actionTimeoutMs } = env;
  safeRegister(defineTracedTool({
    name: 'computer_ui_action',
    description:
      "Act on a window through Windows UI Automation instead of moving the mouse: invoke a button, set an edit field's value, read it back, read a document's text, select text inside one, scroll an item into view, toggle a checkbox, select a list item, expand a menu, or focus a control. This is far more reliable than clicking pixels, handles off-screen controls, sets Chinese text correctly, and works without stealing the user's focus, so prefer it whenever computer_ui can identify the control. Requires 电脑操作.",
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: `One of: ${UIA_ACTION_LIST.map((a) => `'${a}'`).join(', ')}. The window actions ('close'/'minimize'/'maximize'/'restore') go through the window pattern: no foreground needed, no synthesized input — unlike alt+F4. 'legacy_action' fires the MSAA default action, the only way into some older controls. The same list is available inside computer_actions as step actions, so anything that works here works as a step there.`,
      },
      hwnd: { type: 'integer', description: 'Window handle from computer_windows. Omit to act inside the window that currently has focus.' },
      ref: {
        type: 'string',
        description:
          "The [s#.#] marker computer_ui printed next to a node: that exact element, pinned to the read that produced it. The window is read again and the element is matched by its ancestor path, automation id, control type and position, so it survives a tree that moved underneath you; the receipt reports `reresolved` when it was found somewhere other than where it was read, and `drift` in pixels. A ref from before a worker restart, or from a pruned snapshot, is refused with [STALE_REF] rather than re-guessed.",
      },
      automation_id: { type: 'string', description: "Exact AutomationId, as reported by computer_ui. The most stable selector when present." },
      name: { type: 'string', description: 'Case-insensitive substring of the accessible name, e.g. "保存" or "Save".' },
      control_type: { type: 'string', description: "Control type to require, e.g. 'Button', 'Edit', 'ListItem', 'MenuItem', 'TabItem', 'Document'." },
      class_name: { type: 'string', description: 'Exact window class of the control, as reported by computer_ui — a last resort when a control has neither a name nor an automation id.' },
      index: { type: 'integer', description: 'Which match to use when several match, 0-based (default 0).' },
      value: { type: 'string', description: "The text to write for 'set_value'." },
      text: { type: 'string', description: "For 'select_text': the text to locate inside the element." },
      prefix: { type: 'string', description: "For 'select_text': text that must appear immediately before the match, to pick the right occurrence when the string repeats. An ambiguous match is refused rather than resolved to the first hit." },
      suffix: { type: 'string', description: "For 'select_text': text that must appear immediately after the match." },
      selection_type: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'], description: "For 'select_text': select the match (default), or collapse onto its start/end to place the caret there." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          value: { type: 'string' },
          truncated: { type: 'boolean' },
          verified: { type: 'boolean' },
          rect: {
            type: 'object',
            additionalProperties: false,
            description: "For 'click_text': the screen rectangle of the matched text range — what was actually clicked.",
            properties: {
              x: { type: 'integer', required: true },
              y: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          matched: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              name: { type: 'string', required: true },
              controlType: { type: 'string', required: true },
              automationId: { type: 'string', required: true },
              x: { type: 'integer', required: true },
              y: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              patterns: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          ref: { type: 'string' },
          reresolved: { type: 'boolean' },
          drift: { type: 'integer' },
          resolvedVia: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const type = value.matched.controlType.replace('ControlType.', '');
        const label = value.matched.name ? `"${value.matched.name}"` : `(unnamed ${type})`;
        const centre = value.matched.width > 0
          ? ` centre=(${Math.round(value.matched.x + value.matched.width / 2)},${Math.round(value.matched.y + value.matched.height / 2)})`
          : '';
        // The ref moved: say so on every receipt, because the caller pinned a position
        // and got a different one. It is the difference between "it worked" and "it
        // worked on the element that is there now".
        const moved = value.reresolved === true
          ? ` (the ref's element had moved: re-resolved ${value.drift === undefined ? '' : `${value.drift}px `}from where it was read)`
          : '';
        if (value.action === 'get_value') {
          return [{ type: 'text', text: `${type} ${label}${centre} currently holds: ${value.value ?? ''}${moved}` }];
        }
        if (value.action === 'set_value') {
          // Report what the control holds now, not what was asked for: those differ
          // exactly when the write did not take, which is the case worth surfacing.
          const write = value.verified === true
            ? `Set ${type} ${label}${centre} to ${JSON.stringify(value.value ?? '')}.`
            : `Asked ${type} ${label}${centre} to hold ${JSON.stringify(value.value ?? '')}, but the control reports something else now — read it back with get_value before relying on it.`;
          return [{ type: 'text', text: `${write}${moved}` }];
        }
        if (value.action === 'get_text') {
          const note = value.truncated === true ? ' (truncated)' : '';
          return [{ type: 'text', text: `${type} ${label}${centre} text${note}:\n${value.value ?? ''}` }];
        }
        if (value.action === 'select_text') {
          return [{ type: 'text', text: `Selected ${JSON.stringify(value.value ?? '')} in ${type} ${label}${centre}.${moved}` }];
        }
        if (value.action === 'get_caret') {
          const where = value.rect === undefined ? '' : ` at (${value.rect.x},${value.rect.y})`;
          const line = value.value === '' ? '' : ` on line: ${value.value}`;
          return [{ type: 'text', text: `Caret${where}${line}` }];
        }
        if (value.action === 'click_text' || value.action === 'locate_text') {
          const where = value.rect === undefined ? '' : ` at (${Math.round(value.rect.x + value.rect.width / 2)},${Math.round(value.rect.y + value.rect.height / 2)})`;
          const verb = value.action === 'click_text' ? 'Clicked' : 'Located';
          return [{ type: 'text', text: `${verb} ${JSON.stringify(value.value ?? '')}${where} inside ${type} ${label}.${moved}` }];
        }
        return [{ type: 'text', text: `${value.action} on ${type} ${label}${centre} succeeded.${moved}` }];
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      const action = String(args.action ?? '').toLowerCase();
      if (!UIA_ACTION_LIST.includes(action)) {
        throw new Error(`[BAD_REQUEST] computer_ui_action needs one of ${UIA_ACTION_LIST.join(', ')}; got '${args.action ?? ''}'`);
      }

      if (args.ref === undefined && args.automation_id === undefined && args.name === undefined && args.control_type === undefined && args.class_name === undefined) {
        throw new Error('[BAD_REQUEST] computer_ui_action needs at least one selector: ref, automation_id, name, control_type, or class_name.');
      }
      // A ref is pinned to the read that minted it, and a read belongs to one
      // conversation. Refusing a foreign ref here is what keeps "this exact element" from
      // meaning "this exact element in someone else's window".
      refs.assertRefOwnership(exec?.agent?.session?.id, args.ref);
      if (action === 'set_value' && typeof args.value !== 'string') {
        throw new Error("[BAD_REQUEST] computer_ui_action with action 'set_value' needs a value.");
      }
      if (action === 'select_text' && typeof args.text !== 'string') {
        throw new Error("[BAD_REQUEST] computer_ui_action with action 'select_text' needs the text to locate.");
      }
      const result = await call(exec, 'uiact', {
        action,
        hwnd: args.hwnd,
        ref: args.ref,
        automationId: args.automation_id,
        name: args.name,
        controlType: args.control_type,
        className: args.class_name,
        index: args.index ?? 0,
        value: args.value,
        text: args.text,
        prefix: args.prefix,
        suffix: args.suffix,
        selectionType: args.selection_type,
      }, { interactive: true, timeoutMs: Math.max(actionTimeoutMs, 45_000) });
      const outcome = {
        action: result.action,
        matched: {
          name: String(result.matched?.name ?? ''),
          controlType: String(result.matched?.controlType ?? 'ControlType.Unknown'),
          automationId: String(result.matched?.automationId ?? ''),
          x: Number(result.matched?.x ?? 0),
          y: Number(result.matched?.y ?? 0),
          width: Number(result.matched?.width ?? 0),
          height: Number(result.matched?.height ?? 0),
          patterns: Array.isArray(result.matched?.patterns) ? result.matched.patterns.map((p) => String(p)) : [],
        },
      };
      // `value` is added only for the actions where it means something. It must be
      // omitted rather than set to undefined: a present-but-undefined key still
      // fails a `type: 'string'` check, because the host validates the object it
      // received and not a JSON round-trip of it.
      if (action === 'get_value' || action === 'set_value' || action === 'get_text' || action === 'select_text' || action === 'click_text' || action === 'locate_text' || action === 'get_caret') {
        outcome.value = String(result.value ?? '');
      }
      // A write that reports success and did not happen is the failure the caller is
      // least equipped to notice, so set_value reads the control back and says whether
      // the control now holds what it was asked to hold. A mismatch is reported rather
      // than refused: fields legitimately transform what they are given (uppercasing,
      // masking, truncation), and the actionable fact is what it holds now.
      if (action === 'set_value') {
        outcome.verified = outcome.value === String(args.value ?? '');
      }
      if (action === 'get_text') outcome.truncated = result.truncated === true;
      if ((action === 'click_text' || action === 'locate_text' || action === 'get_caret') && result.rect !== undefined && result.rect !== null) {
        outcome.rect = {
          x: Number(result.rect.x ?? 0),
          y: Number(result.rect.y ?? 0),
          width: Number(result.rect.width ?? 0),
          height: Number(result.rect.height ?? 0),
        };
      }
      // Only present when the action was addressed by ref, and only when the element
      // was actually found somewhere other than where the ref was read.
      if (typeof result.ref === 'string' && result.ref !== '') {
        outcome.ref = result.ref;
        if (result.reresolved === true) {
          outcome.reresolved = true;
          outcome.drift = Number(result.drift ?? 0);
        }
        // How the ref was re-found: `automation-id` means one provider query answered it,
        // `tree-walk` means the window's tree had to be read. Useful when a ref action
        // feels slow, and it is the measurable half of "don't fetch the tree twice".
        if (typeof result.resolvedVia === 'string' && result.resolvedVia !== '') outcome.resolvedVia = result.resolvedVia;
      }
      return outcome;
    },
  }));
}
