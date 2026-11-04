/**
 * `browser_state` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 3）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
import { BrowserSession, formatBrowserNode } from '../browser/state.mjs';
import { sessionKey } from '../internal/sessions.mjs';
import { BROWSER_STATE_SCHEMA } from '../internal/tool-contracts.mjs';
export function registerBrowserState(env) {
  const { safeRegister, defineTracedTool, execution, sessions, refs, requireGrant, BROWSER_CAPABLE, BROWSER_CAPABILITY_NOTE, resolveBrowserEndpoint, browserSessionFor } = env;
  safeRegister(defineTracedTool({
      name: 'browser_state',
    description:
      "Read a page through the browser's own protocol (CDP) instead of looking at its pixels: the tabs that are open, the accessibility tree with a `ref` per element, or the page text. This is the authoritative view of a page — the same tree the browser builds for assistive technology — and it is much cheaper than a screenshot plus a click plus another screenshot. The endpoint is whatever this plugin was configured with (`browserEndpoint`), or a browser the plugin started; it is never guessed and never scanned for, and it is refused unless it is on this machine. Requires 电脑操作.",
    parameters: {
      view: { type: 'string', enum: ['tabs', 'ax', 'text', 'dom'], description: "What to return: 'tabs' (the open pages — the default when no tab is bound), 'ax' (the accessibility tree — the default when a tab is known), 'text' (the visible text, cut at the page), or 'dom' (a diagnostic outline; not opened yet)." },
      tab: { type: 'string', description: 'Which page: a target id from `view: tabs`, or its 1-based position in that list. A read that names a tab binds this session to it, so later reads can leave `tab` out.' },
      filter: { type: 'string', description: 'Case-insensitive substring over role, name and value. The whole tree is still collected — the reply reports `collected` and `returned` separately so you can see that — but only the matches come back.' },
      max_nodes: { type: 'integer', description: 'Node budget for `view: ax` (default 200, maximum 1000).' },
      max_chars: { type: 'integer', description: 'Character budget for `view: text`, applied inside the page (default 6000, maximum 20000).' },
      timeout_ms: { type: 'integer', description: 'Deadline for the protocol calls of this read (default 5000, maximum 30000).' },
    },
    output: {
      schema: BROWSER_STATE_SCHEMA,
      render: (_args, value) => {
        const lines = [];
        if (value.status !== undefined && value.status !== '' && value.status !== 'ok') {
          lines.push(`browser: ${value.status}${value.note === undefined ? '' : ` — ${value.note}`}`);
          return [{ type: 'text', text: lines.join('\n') }];
        }
        if (Array.isArray(value.tabs) && value.tabs.length > 0) {
          lines.push(`${value.tabs.length} page(s) in ${value.browser.endpoint}:`);
          value.tabs.forEach((tab, index) => {
            lines.push(`  ${index + 1}. ${tab.id} "${tab.title}" — ${tab.url}`);
          });
          lines.push('(pass one of these ids — or its number — as `tab` to read it)');
          return [{ type: 'text', text: lines.join('\n') }];
        }
        if (value.tab !== undefined) {
          lines.push(`tab ${value.tab.id} "${value.tab.title}" — ${value.tab.url}${value.tab.bound === true ? ' (bound to this session)' : ''}`);
        }
        if (Array.isArray(value.nodes)) {
          lines.push(`${value.nodes.length} of ${value.collected} node(s)${value.truncated === true ? ', truncated' : ''}:`);
          for (const node of value.nodes) lines.push(`  ${formatBrowserNode(node)}`);
        }
        if (typeof value.text === 'string') {
          lines.push(`${value.returnedChars} of ${value.total} character(s)${value.truncated === true ? ' (cut at the budget)' : ''}:`);
          lines.push(value.text);
        }
        if (value.note !== undefined) lines.push(value.note);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      const sessionKey = String(exec?.agent?.session?.id ?? '');
      const requestedView = String(args.view ?? '').toLowerCase();
      const endpoint = resolveBrowserEndpoint(sessionKey);
      const base = {
        path: 'cdp',
        view: ['tabs', 'ax', 'text', 'dom'].includes(requestedView) ? requestedView : 'tabs',
        browser: { endpoint, generation: 0 },
      };
      if (!BROWSER_CAPABLE) {
        return { ...base, view: 'tabs', status: 'capability_unavailable', truncated: false, refs: 0, snapshots: 0, note: BROWSER_CAPABILITY_NOTE };
      }
      if (endpoint === '') {
        return {
          ...base,
          view: 'tabs',
          status: 'unavailable',
          truncated: false,
          refs: 0,
          snapshots: 0,
          note: 'no browser endpoint is configured. Either pass the endpoint directly (`browserEndpoint`, e.g. http://127.0.0.1:9222) for a browser started with --remote-debugging-port, or point `browserUserDataDir` at a Chromium profile directory so the port is read from the DevToolsActivePort file that browser writes. Nothing is scanned for and no browser is restarted: an endpoint is either configured or absent.',
        };
      }
      if (base.view === 'dom') {
        return { ...base, status: 'ok', truncated: false, refs: 0, snapshots: 0, note: 'the DOM outline is not opened yet: the accessibility view is the one that carries references. Read `view: ax` or `view: text`.' };
      }
      let browser;
      try {
        browser = await browserSessionFor(sessionKey, endpoint);
      } catch (error) {
        const detached = new BrowserSession({ connection: { on: () => () => {}, sessions: new Map() }, sessionKey }).detachedNote(error);
        return { ...base, status: detached.status, truncated: false, refs: 0, snapshots: 0, note: detached.note };
      }
      const { connection, session } = browser;
      base.browser = {
        endpoint,
        generation: connection.generation,
        ...(connection.negotiated?.browser ? { browser: connection.negotiated.browser } : {}),
        ...(connection.negotiated?.protocolVersion ? { protocolVersion: connection.negotiated.protocolVersion } : {}),
      };
      try {
        // Target selection (§11): an explicit tab first, then this session's bound tab, and
        // otherwise the list of candidates — a read never guesses which page was meant.
        if (args.tab !== undefined && args.tab !== null && `${args.tab}` !== '') {
          if (!session.boundTargetId || session.boundTargetId !== `${args.tab}`) {
            session.boundTargetId = `${args.tab}`;
          }
        }
        const tabs = await session.tabs({ timeoutMs: args.timeout_ms });
        let target = null;
        if (args.tab !== undefined && args.tab !== null && `${args.tab}` !== '') {
          const wanted = `${args.tab}`;
          const asIndex = Number.parseInt(wanted, 10);
          target = tabs.find((one) => one.id === wanted)
            ?? (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= tabs.length ? tabs[asIndex - 1] : null);
          if (target === null) {
            return {
              ...base,
              status: 'no_target',
              tabs,
              truncated: false,
              refs: session.refs.size,
              snapshots: session.snapshots.length,
              note: `no page matches "${wanted}". The list above is what this browser has open.`,
            };
          }
        } else if (session.boundTargetId !== undefined && tabs.some((one) => one.id === session.boundTargetId)) {
          target = tabs.find((one) => one.id === session.boundTargetId);
        }
        const view = requestedView === '' ? (target === null ? 'tabs' : 'ax') : base.view;
        if (target === null) {
          // Several candidates and none named: return them rather than picking one (§11).
          return { ...base, view: 'tabs', tabs, truncated: false, refs: session.refs.size, snapshots: session.snapshots.length };
        }
        if (view === 'tabs') {
          return { ...base, view, tabs, truncated: false, refs: session.refs.size, snapshots: session.snapshots.length };
        }
        const tabValue = { id: target.id, title: target.title, url: target.url };
        if (view === 'ax') {
          // Reads are registered like every other call, so a stop cancels the read in flight
          // instead of leaving it to finish against a browser the session no longer owns (§5.1).
          const read = await execution.runSessionCall(exec, { timeoutMs: 30_000, label: 'the accessibility read' }, ({ signal }) => session.readAx({
            targetId: target.id,
            filter: args.filter,
            maxNodes: args.max_nodes,
            maxChars: args.max_chars,
            timeoutMs: Number.isFinite(Number(args.timeout_ms)) ? Number(args.timeout_ms) : undefined,
            signal,
          }));
          return {
            ...base,
            view,
            tab: { ...tabValue, bound: session.boundTargetId === target.id },
            nodes: read.nodes,
            collected: read.collected,
            returned: read.returned,
            truncated: read.truncated,
            refs: read.refs,
            snapshots: session.snapshots.length,
            documentGeneration: read.documentGeneration,
            budget: { max_nodes: read.budget.max_nodes, max_chars: read.budget.max_chars },
          };
        }
        const read = await execution.runSessionCall(exec, { timeoutMs: 30_000, label: 'the text read' }, ({ signal }) => session.readText({
          targetId: target.id,
          maxChars: args.max_chars,
          timeoutMs: Number.isFinite(Number(args.timeout_ms)) ? Number(args.timeout_ms) : undefined,
          signal,
        }));
        return {
          ...base,
          view,
          tab: { ...tabValue, bound: session.boundTargetId === target.id },
          text: read.text,
          total: read.total,
          returnedChars: read.returned_chars,
          truncated: read.truncated,
          refs: session.refs.size,
          snapshots: session.snapshots.length,
          documentGeneration: read.documentGeneration,
          budget: { max_chars: read.budget.max_chars },
        };
      } catch (error) {
        const detached = session.detachedNote(error);
        return {
          ...base,
          status: detached.status,
          truncated: false,
          refs: session.refs.size,
          snapshots: session.snapshots.length,
          note: detached.note,
        };
      }
    },
  }));
}
