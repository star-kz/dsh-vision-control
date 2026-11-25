import { buildModePrompt } from './modes.mjs';

/** Register one dynamic system-prompt slice. Disabled/subagents contribute no text. */
export function registerModePrompt(ctx, { getMode, isSubagent = () => false } = {}) {
  if (typeof ctx?.systemPrompt?.context !== 'function' || typeof getMode !== 'function') return undefined;
  return ctx.systemPrompt.context({
    name: 'computer-use:mode',
    order: 760,
    required: true,
    interpolate: false,
    text(context) {
      const session = context?.session ?? context?.agent?.session;
      if (!session || isSubagent(context?.agent)) return '';
      return buildModePrompt(getMode(session.id));
    },
  });
}
