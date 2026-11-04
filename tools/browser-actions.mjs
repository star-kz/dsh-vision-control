/**
 * `browser_actions` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 3）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
import { BrowserSession, formatBrowserNode } from '../browser/state.mjs';
import { runActions, clampActionBudget, BROWSER_ACTIONS } from '../browser/actions.mjs';
import { sessionKey } from '../internal/sessions.mjs';
export function registerBrowserActions(env) {
  const { safeRegister, defineTracedTool, execution, sessions, requireGrant, BROWSER_CAPABLE, BROWSER_CAPABILITY_NOTE, resolveBrowserEndpoint, browserSessionFor } = env;
  safeRegister(defineTracedTool({
    name: 'browser_actions',
    description:
      "Do things on a page through the browser's own protocol: navigate, put a value in a field, click a reference from browser_state, and end with a state read — all in one call, because a browser task is a sequence rather than one action per round trip. Every step spends the same call budget, a write is sent exactly once (a click that was dispatched and then lost is reported as `actionSent: true` and `outcome: 'unknown'`, never replayed), and a step that asked to be verified is read back before this call says it worked. Requires 电脑操作.",
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: `The steps, in order (maximum 20). Actions: ${BROWSER_ACTIONS.join(', ')}.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true, enum: [...BROWSER_ACTIONS] },
            url: { type: 'string', description: 'navigate: where to go.' },
            ref: { type: 'string', description: 'click/fill: a reference from browser_state, checked against the connection, target, frame and document it was read from before it is used.' },
            value: { type: 'string', description: "fill: the text to put in the field, through the page's own input/change events so frameworks notice." },
            verify: { type: 'object', additionalProperties: true, description: 'click: what to look for afterwards (`{name: "…"}`). Without it the step is reported as `not_verified` rather than implied to have worked.' },
            filter: { type: 'string', description: 'state: substring over role, name and value.' },
            max_nodes: { type: 'integer', description: 'state: node budget (default 200, maximum 1000).' },
            max_chars: { type: 'integer', description: 'state: character budget.' },
          },
        },
      },
      tab: { type: 'string', description: 'Which page: a target id from browser_state or its 1-based position.' },
      timeout_ms: { type: 'integer', description: 'The budget for the whole call, shared by every step (default 15000, maximum 60000) — one deadline rather than one per step.' },
      state: { type: 'boolean', description: 'End the call with an accessibility read of the page, so one round trip returns what your steps did.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          browser: { type: 'object', additionalProperties: false, required: true, properties: { endpoint: { type: 'string', required: true }, generation: { type: 'integer', required: true } } },
          tab: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, title: { type: 'string', required: true }, url: { type: 'string', required: true }, bound: { type: 'boolean' } } },
          performed: { type: 'array', required: true, items: { type: 'string' } },
          verification: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          failedAt: { type: 'integer', required: true },
          actionSent: { type: 'boolean', required: true, description: 'Whether anything was sent to the page. A failure with this true means the page may already have acted — do not repeat it blindly.' },
          outcome: { type: 'string', required: true, enum: ['completed', 'failed', 'unknown', 'cancelled', 'deadline'] },
          nextStep: { type: 'integer', required: true },
          error: { type: 'string' },
          elapsedMs: { type: 'integer', required: true },
          budgetMs: { type: 'integer', required: true },
          nodes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { ref: { type: 'string', required: true }, role: { type: 'string', required: true }, name: { type: 'string', required: true }, value: { type: 'string', required: true }, states: { type: 'array', required: true, items: { type: 'string' } }, backendNodeId: { type: 'integer', required: true } } } },
          truncated: { type: 'boolean', required: true },
          collected: { type: 'integer' },
          returned: { type: 'integer' },
          status: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.status !== undefined && value.status !== '' && value.status !== 'ok' && value.performed === undefined) {
          return [{ type: 'text', text: `browser: ${value.status}${value.note === undefined ? '' : ` — ${value.note}`}` }];
        }
        const lines = [`${value.performed.length} step(s), outcome ${value.outcome}${value.actionSent ? ' (the page was touched)' : ' (nothing was sent)'}:`];
        value.performed.forEach((line, index) => lines.push(`  ${index + 1}. ${line}`));
        if (value.failedAt >= 0) lines.push(`step ${value.failedAt} failed: ${value.error ?? 'unknown error'} — look at the page, then resume from step ${value.nextStep}.`);
        for (const one of value.verification) {
          if (one.status === 'not_verified') lines.push(`step ${one.step} was not verified: ${one.note}`);
          else if (one.status !== 'ok') lines.push(`step ${one.step} verification ${one.status}: ${one.note}`);
        }
        if (Array.isArray(value.nodes)) {
          lines.push(`${value.nodes.length} of ${value.collected ?? value.nodes.length} node(s)${value.truncated === true ? ', truncated' : ''}:`);
          for (const node of value.nodes) lines.push(`  ${formatBrowserNode(node)}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      const sessionKey = String(exec?.agent?.session?.id ?? '');
      const endpoint = resolveBrowserEndpoint(sessionKey);
      const steps = Array.isArray(args.steps) ? args.steps : [];
      const base = { path: 'cdp', browser: { endpoint, generation: 0 }, performed: [], verification: [], failedAt: -1, actionSent: false, outcome: 'completed', nextStep: 0, elapsedMs: 0, budgetMs: clampActionBudget(args.timeout_ms), truncated: false };
      if (!BROWSER_CAPABLE) return { ...base, outcome: 'failed', status: 'capability_unavailable', note: BROWSER_CAPABILITY_NOTE };
      if (endpoint === '') {
        return { ...base, outcome: 'failed', status: 'unavailable', note: 'no browser endpoint is configured. Set `browserEndpoint` (e.g. http://127.0.0.1:9222) to a browser started with --remote-debugging-port.' };
      }
      if (steps.length === 0) throw new Error('[BAD_REQUEST] browser_actions needs at least one step.');
      if (steps.length > 20) throw new Error(`[BAD_REQUEST] browser_actions accepts at most 20 steps per call (got ${steps.length}).`);
      steps.forEach((step, index) => {
        const action = String(step?.action ?? '').toLowerCase();
        if (!BROWSER_ACTIONS.includes(action)) throw new Error(`[BAD_REQUEST] step ${index} has unknown action "${step?.action ?? ''}" (this build understands: ${BROWSER_ACTIONS.join(', ')}).`);
        if (action === 'navigate' && (typeof step.url !== 'string' || step.url === '')) throw new Error(`[BAD_REQUEST] step ${index} is a navigate without a url.`);
        if (action === 'click' && (typeof step.ref !== 'string' || step.ref === '')) throw new Error(`[BAD_REQUEST] step ${index} is a click without a ref; read the page with browser_state first.`);
        if (action === 'fill' && (typeof step.ref !== 'string' || step.ref === '' || typeof step.value !== 'string')) throw new Error(`[BAD_REQUEST] step ${index} is a fill without a ref and a value.`);
      });
      let browser;
      try {
        browser = await browserSessionFor(sessionKey, endpoint);
      } catch (error) {
        const detached = new BrowserSession({ connection: { on: () => () => {}, sessions: new Map() }, sessionKey }).detachedNote(error);
        return { ...base, outcome: 'failed', status: detached.status, note: detached.note };
      }
      const { connection, session } = browser;
      base.browser = { endpoint, generation: connection.generation };
      /**
       * What the sequence managed to do, kept even when a later read fails.
       *
       * The trailing state read used to share the sequence's try block, so a read that failed
       * after a successful click made the whole call report `actionSent: false` with an empty
       * `performed` list — the one answer that makes a caller repeat a click that already
       * happened (§5.2, evidence HOST01).
       */
      const ran = { performed: [], verification: [], failedAt: -1, actionSent: false, outcome: 'completed', error: '', state: null, nextStep: 0 };
      try {
        if (args.tab !== undefined && args.tab !== null && `${args.tab}` !== '') session.boundTargetId = `${args.tab}`;
        const tabs = await session.tabs({ timeoutMs: 2000 });
        let target = null;
        if (session.boundTargetId !== undefined) {
          const wanted = session.boundTargetId;
          const asIndex = Number.parseInt(wanted, 10);
          target = tabs.find((one) => one.id === wanted)
            ?? (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= tabs.length ? tabs[asIndex - 1] : null);
          // A number is a way of *choosing* a tab once, not a name for it: what gets bound is
          // the target id it resolved to, so a later tab opening or closing cannot move the
          // session onto a different page (§5.10).
          if (target !== null && session.boundTargetId !== target.id) session.boundTargetId = target.id;
        }
        if (target === null) {
          // A call whose first step is tab management does not need a page to start in: it is
          // about to make or list one. Borrow any open page as the CDP session host and let that
          // step bind the call to whatever it creates.
          const firstAction = String(steps[0]?.action ?? '').toLowerCase();
          if (firstAction === 'tabs' && tabs.length > 0) target = tabs[0];
        }
        if (target === null) {
          return { ...base, outcome: 'failed', status: 'no_target', note: `no page is bound to this session and none was named. Open tabs: ${tabs.map((one) => `${one.id} "${one.title}"`).join(', ') || '(none)'}. Pass one as \`tab\`.` };
        }
        base.tab = { id: target.id, title: target.title, url: target.url, bound: true };
        const receipt = await execution.runSessionCall(exec, { timeoutMs: clampActionBudget(args.timeout_ms) + 2000, label: 'browser_actions' }, ({ signal }) => runActions(session, { targetId: target.id, steps, timeoutMs: args.timeout_ms, signal }));
        Object.assign(ran, receipt);
        // Where the call *ended* is what the trailing state should read: `tabs create` moves the
        // call to a new page, and a receipt that reported the old one, plus a state read of it,
        // would describe a page the steps are no longer about.
        let finalTab = { id: target.id, title: target.title, url: target.url };
        if (session.boundTargetId !== undefined && session.boundTargetId !== target.id) {
          const now = await session.tabs({ timeoutMs: 2000 });
          const found = now.find((one) => one.id === session.boundTargetId);
          if (found !== undefined) finalTab = { id: found.id, title: found.title, url: found.url };
        }
        const value = { ...base, ...(() => { const { state: _stepState, ...rest } = receipt; return rest; })(), tab: { ...finalTab, bound: true }, browser: base.browser, path: 'cdp', truncated: false };
        if (args.state !== true && receipt.state !== null && receipt.state !== undefined) {
          // A `state` step's read is already in hand: it becomes this call's view of the page,
          // the same fields the `state: true` flag would have produced.
          value.nodes = receipt.state.nodes;
          value.collected = receipt.state.collected;
          value.returned = receipt.state.returned;
          value.truncated = receipt.state.truncated;
        }
        if (args.state === true && receipt.outcome !== 'cancelled') {
          // The read is its own step: it may fail, and when it does the sequence's receipt is
          // still what this call returns (§5.2 — a failed observation is not an unexecuted
          // action).
          try {
            const read = await execution.runSessionCall(exec, { timeoutMs: 20_000, label: 'the trailing state read' }, ({ signal }) => session.readAx({ targetId: finalTab.id, maxNodes: args.max_nodes, maxChars: args.max_chars, timeoutMs: args.timeout_ms, signal }));
            value.nodes = read.nodes;
            value.collected = read.collected;
            value.returned = read.returned;
            value.truncated = read.truncated;
          } catch (observation) {
            value.note = `the steps above ran, and the read at the end did not: ${observation?.message ?? observation}. What the page looks like now is unknown from here — read it again (browser_state) before deciding anything else.`;
          }
        }
        return value;
      } catch (error) {
        if (error?.receipt !== undefined) Object.assign(ran, error.receipt);
        const detached = session.detachedNote(error);
        const failedAt = ran.failedAt;
        return {
          ...base,
          performed: ran.performed,
          verification: ran.verification,
          failedAt,
          actionSent: ran.actionSent,
          // An action that was sent stays "unknown" rather than becoming "failed": the caller
          // must not repeat a click this call already delivered (§5.2).
          outcome: ran.outcome === 'completed' ? (ran.actionSent ? 'unknown' : 'failed') : ran.outcome,
          nextStep: ran.nextStep ?? (failedAt >= 0 ? failedAt + 1 : 0),
          error: ran.error === '' ? undefined : ran.error,
          status: detached.status,
          note: detached.note,
        };
      }
    },
  }));
}
