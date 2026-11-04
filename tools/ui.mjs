/**
 * `computer_ui` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 2）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { join } from 'node:path';
import { resolveFormat, screenshotEnvelope } from '../internal/capture.mjs';
import { UIA_STATE_SCHEMA, stateValue, renderState } from '../internal/tool-contracts.mjs';
export function registerComputerUi(env) {
  const { safeRegister, defineTracedTool, captureService, refs, restartBackend, requireGrant, PROFILE_COOLDOWN_MS, capabilityForHwnd, capabilityNote, call, capture, reportAttachment, markObservation, normalizeTextTarget, actionTimeoutMs, ctx, getLastLegacyRestartMs, setLastLegacyRestartMs } = env;
  safeRegister(defineTracedTool({
    name: 'computer_ui',
    description:
      'Read the Windows UI Automation tree of a window: control types, names, automation ids, rectangles, and supported patterns. Give a `filter` or an exact `name` to get only the matching nodes — several times faster than dumping a whole tree, so prefer it when you know what you are looking for. The reply names the window it came from and says when the tree is unchanged since your last read. Rows render compact (ref, type, name, patterns) because that is what acting needs; `compact: false` adds geometry and diagnostics, and `screenshot: true` returns pixels and tree in one call. Requires 电脑操作.',
    parameters: {
      hwnd: { type: 'integer', description: 'Window handle from computer_windows. Omit to inspect the window that currently has focus.' },
      filter: { type: 'string', description: 'Case-insensitive substring matched against name, automation id, and control type. Matching happens in the backend, which is much faster than dumping the tree and filtering afterwards.' },
      name: { type: 'string', description: 'Exact substring match against the accessible name only — the narrowest and fastest search.' },
      control_type: { type: 'string', description: "Match the control type, e.g. 'Button', 'Edit', 'ListItem'." },
      automation_id: { type: 'string', description: 'Exact automation id match; becomes a server-side query rather than a scan.' },
      max_depth: { type: 'integer', description: 'Tree depth to walk, 1 to 10 (default 5). Ignored when a filter is given, because a search looks at every descendant.' },
      max_nodes: { type: 'integer', description: 'Node budget, 10 to 1500 (default 250). A filtered read usually returns far fewer.' },
      max_visited: { type: 'integer', description: 'Traversal budget: how many nodes the walk may look at before it stops, separate from the node budget (default: generous, derived from the node budget; 0 means no limit). Use a small value to bound a huge or hostile tree, or a large one when a read came back marked as traversal-truncated.' },
      patterns: { type: 'boolean', description: 'Probe which UI Automation patterns each node supports (invoke/value/text/select/toggle/expand/scroll_item). Default true; false is noticeably faster when you only need names and rectangles.' },
      skip_empty: { type: 'boolean', description: 'Omit nodes with no name, no automation id and no patterns — usually anonymous layout containers that crowd out the controls you actually want. Default true; set false for the literal tree.' },
      compact: { type: 'boolean', description: 'Render rows short by default: ref, type, name and patterns. Pass false to also get each row\'s centre, the omitted-node counts and the pruning notes. The returned value always carries the full geometry; this only decides what the text spells out.' },
      skip_if_degraded: {
        type: 'boolean',
        description: "With `hwnd`: skip the tree walk when this window was already read as degraded or unavailable within the last 90 s, and return that conclusion instead (default false). Only this explicit form skips: asking for a read is itself new evidence, so an ordinary call always reads.",
      },
      since: { type: 'string', description: 'A snapshot id from an earlier read — see computer_ui.since. Only what changed comes back, with a `delta` summary.' },
      prune: { type: 'boolean', description: 'Fold away what nobody can use — zero-area scaffolding, runs of similar siblings, and the lowest-priority rows when the budget is tight. Shape-preserving: children are re-parented, every surviving row keeps its context, and a node with an automation id or a pattern is never dropped (default true; false gives the raw provider output).' },
      screenshot: { type: 'boolean', description: 'Also capture the screen in the same call, so one round trip gives both the pixels and the tree. With `hwnd` the capture is of *that window* (it renders itself, so whatever covers it is irrelevant), so both halves describe the same thing.' },
      save_path: { type: 'string', description: 'With `screenshot`: write the capture here instead of the plugin temp directory.' },
      scale: { type: 'number', description: 'With `screenshot`: downscale the capture (0.5 halves both edges and roughly quarters the bytes and vision tokens).' },
      format: { type: 'string', enum: ['jpeg', 'png'], description: "With `screenshot`: 'jpeg' (default, a quarter of the bytes) or 'png' for lossless detail." },
      settle_ms: { type: 'integer', description: 'When a write happened just before this read, the floor on how old that write must be before the tree is read (default 300, maximum 5000); time already spent counts. See computer_screenshot.settle_ms.' },
      text: {
        type: 'object',
        additionalProperties: false,
        description: 'Also return the text this read is about, so "read the window, then read the field" is one call. `{}` gives the focused control and what is selected in it; `document: true` reads the document behind it, `selected: true` lists what a list or tree has selected. Every field shares one `max_text_chars` budget, and a field that could not be read says why (`unsupported`, `unavailable`, `budget_exhausted`) instead of coming back empty. The target is the focused control when it belongs to this window, otherwise the text-providing row of this read; if that is still ambiguous the block says `target_required` and you pass text_target.',
        properties: {
          focused: { type: 'boolean', description: 'The focused control as one line: type - name - value (default true once `text` is given).' },
          selection: { type: 'boolean', description: 'The text selected inside the target (default true once `text` is given).' },
          document: { type: 'boolean', description: 'The document behind the target, up to the budget. Off unless asked for — it is the expensive one.' },
          selected: { type: 'boolean', description: 'The items a list or tree has selected (SelectionPattern).' },
        },
      },
      text_target: {
        type: 'object',
        additionalProperties: false,
        description: "Which control `text` reads when the default is not the one you mean: a `ref` from a read, or an exact selector — both at once is refused, because a ref names one element and a selector names a rule. Without it only the focused control and this read's own rows are considered: the read never scans the window, and answers `target_required` rather than guessing.",
        properties: {
          ref: { type: 'string', description: 'A [s#.#] marker from a computer_ui read; a stale one is reported as unavailable.' },
          automation_id: { type: 'string', description: 'Exact AutomationId.' },
          name: { type: 'string', description: 'Substring of the accessible name.' },
          control_type: { type: 'string', description: "Control type to require, e.g. 'Edit'." },
          class_name: { type: 'string', description: 'Exact window class.' },
          index: { type: 'integer', description: 'Which match when several do, 0-based (default 0).' },
          hwnd: { type: 'integer', description: "Window to look in; defaults to this read's window." },
        },
      },
      max_text_chars: { type: 'integer', description: 'Character budget shared by every text field of this read (default 2000, maximum 16000).' },
      max_selected: { type: 'integer', description: 'How many selected items `text.selected` lists (default 20, maximum 100).' },
      // 新-P1-03 / ocr O.1: the OCR add-on. Only the object form is exposed here (the
      // schema dialect has no oneOf); the worker also tolerates `true` / a language
      // string, but a caller should not rely on what the schema does not declare.
      ocr: {
        type: 'object',
        additionalProperties: false,
        description: "Also read the window's pixels with Windows OCR and return the recognized text lines — the fallback for surfaces the accessibility tree cannot speak for (a canvas, an image, a game, a legacy owner-drawn panel). `{}` uses the defaults. Every line comes back marked unverified — OCR mistakes pixels for letters without telling you, so prefer the `text` block whenever the tree can answer, and treat OCR lines as leads to confirm (computer_screenshot) before acting on them. Costs a capture and an OCR pass inside the worker; the bitmap is read and discarded, never attached.",
        properties: {
          language: { type: 'string', description: "BCP-47 language tag for the recognizer (e.g. 'zh-CN', 'en-US'). Default: the system's display language." },
          max_lines: { type: 'integer', description: 'How many lines to return at most (default 40, maximum 200).' },
          points: { type: 'boolean', description: 'Attach a clickable centre point to each line (default true). Points are what let you click text that only OCR can see.' },
        },
      },
      captures: {
        type: 'string',
        enum: ['self', 'related'],
        description: "Also capture pixels: 'self' (with screenshot: true) is that window, 'related' captures the window *and* the windows that belong to it — a dialog, a popup menu, a tool window — one frame each, which is how a popup that is its own window becomes visible in the same reply as the tree. Needs `hwnd`; popups come first, two frames by default and three at most, and every frame has its own frame id.",
      },
      max_captures: { type: 'integer', description: "With captures: 'related', how many frames to take (default 2, maximum 3)." },
    },
    output: {
      schema: UIA_STATE_SCHEMA,
      render: (args, value) => {
        const blocks = [{ type: 'text', text: renderState(value, args?.compact !== false) }];
        // B02: a window this conversation has already read as degraded or unavailable says so
        // here, so the next read is *interpreted* instead of trusted blindly. Deliberately
        // scoped to this window: another window of the same application gets its own probe,
        // because one unreadable panel is not a statement about the application.
        const known = capabilityNote(value.window?.hwnd, value.window?.process, value.window?.pid);
        if (known !== '') blocks.push({ type: 'text', text: known });
        // A read that declined to walk the tree says so in its own words (skip_if_degraded).
        if (typeof value.note === 'string' && value.note !== '') blocks.push({ type: 'text', text: value.note });
        if (value.frames !== undefined) {
          blocks.push({ type: 'text', text: `${value.frames.length} related frame(s), popup first: ${value.frames.map((frame) => `[${frame.frame}] ${frame.relation} z=${frame.zRankKnown === true ? frame.zRank : 'unknown'} hwnd=${frame.windowHwnd} ${frame.width}x${frame.height}`).join('; ')}` });
          for (const frame of value.frames) {
            if (frame.image !== undefined) blocks.push({ type: 'image', attachment: frame.image });
          }
          if (Array.isArray(value.omitted) && value.omitted.length > 0) {
            blocks.push({ type: 'text', text: `not captured: ${value.omitted.map((one) => `hwnd ${one.hwnd} — ${one.reason}`).join('; ')}` });
          }
        }
        if (value.shot === undefined) return blocks;
        blocks.push({ type: 'text', text: screenshotEnvelope(value.shot) });
        if (value.shot.image === undefined) {
          blocks.push({ type: 'text', text: value.shot.note ?? `The image is at ${value.shot.path}.` });
          return blocks;
        }
        blocks.push({ type: 'image', attachment: value.shot.image });
        return blocks;
      },
    },
    async execute(args, exec) {
      requireGrant(exec);
      // The one path that may decline to read: the caller said this probe is optional, and this
      // window was already found degraded or unavailable recently. It answers with that
      // conclusion (and how old it is) instead of paying for the same expensive walk again.
      if (args.skip_if_degraded === true && Number.isFinite(Number(args.hwnd)) && Number(args.hwnd) !== 0) {
        const known = capabilityForHwnd(args.hwnd, String(exec?.agent?.session?.id ?? ''));
        if (known !== undefined && known.state !== 'available' && Date.now() - known.observedAt < PROFILE_COOLDOWN_MS) {
          const ageS = Math.round((Date.now() - known.observedAt) / 1000);
          return {
            window: { hwnd: Number(args.hwnd), title: '', process: String(known.app), pid: Number(known.pid ?? 0) },
            nodes: [],
            truncated: false,
            searched: false,
            mode: 'skipped-degraded',
            digest: '',
            walked: 0,
            skipped: 0,
            note: `this window was read as ${known.state} ${ageS}s ago (${known.evidence}), and skip_if_degraded was set, so the tree was not walked again. Leave that argument out to read it anyway (asking is itself evidence), or work from a capture instead.`,
          };
        }
      }
      const search = [args.filter, args.name, args.control_type, args.automation_id].some((value) => typeof value === 'string' && value !== '');
      const textTarget = normalizeTextTarget(args.text_target);
      const treeArgs = {
        hwnd: args.hwnd,
        filter: args.filter,
        name: args.name,
        controlType: args.control_type,
        automationId: args.automation_id,
        patterns: args.patterns,
        skipEmpty: args.skip_empty,
        prune: args.prune,
        since: args.since,
        settleMs: args.settle_ms,
        // B1: the text this read is about travels with it, on one shared budget.
        text: args.text,
        textTarget,
        maxTextChars: args.max_text_chars,
        maxSelected: args.max_selected,
        // 新-P1-03 / ocr O.1: the OCR request rides the same read.
        ocr: args.ocr,
        maxDepth: Math.min(10, Math.max(1, args.max_depth ?? 5)),
        maxNodes: Math.min(1500, Math.max(10, args.max_nodes ?? 250)),
        // §7.4 第 2 条: the traversal budget, separate from the node budget. Left unset unless
        // the caller names it, so no existing read becomes truncated by this feature; the
        // worker derives a generous default of its own and says when it was hit.
        ...(Number.isFinite(Number(args.max_visited)) && Number(args.max_visited) >= 0
          ? { maxVisited: Math.min(200000, Math.max(0, Math.floor(Number(args.max_visited)))) }
          : {}),
      };
      let result = await call(exec, 'uitree', treeArgs, { timeoutMs: Math.max(actionTimeoutMs, 45_000) });
      // A tree served by the MSAA bridge is not this window's tree. The worker says so; the
      // process is replaced and the read is retried once, because a worker that is serving the
      // bridge for a process stays that way and every later read would be a different, poorer
      // view of the same window.
      let restarted = false;
      if (result.legacy === true && Date.now() - getLastLegacyRestartMs() > 60_000) {
        // Once a minute at most: a genuinely legacy application answers this way for every read,
        // and replacing the worker each time would turn a diagnosis into a thrash.
        setLastLegacyRestartMs(Date.now());
        await restartBackend();
        restarted = true;
        result = await call(exec, 'uitree', treeArgs, { timeoutMs: Math.max(actionTimeoutMs, 45_000) });
      }
      let cachedShot;
      // A related capture on a read (8.txt §7): the tree of the window the caller named plus
      // one frame per window that belongs to it. The frames ride the same reply, so "the
      // menu is open — which item is where" stays one call.
      let relatedFrames;
      let relatedOmitted;
      if (args.captures === 'related') {
        if (!Number.isFinite(Number(args.hwnd)) || Number(args.hwnd) <= 0) {
          throw new Error("[BAD_REQUEST] captures: 'related' needs `hwnd`: it captures that window and the windows that belong to it.");
        }
        const related = await call(exec, 'screenshot', {
          window: Number(args.hwnd),
          captures: 'related',
          maxCaptures: args.max_captures,
          path: args.save_path,
          scale: args.scale,
          format: resolveFormat(args.format, args.save_path),
          settleMs: args.settle_ms,
        }, { timeoutMs: Math.max(actionTimeoutMs, 45_000) });
        relatedFrames = [];
        for (const one of Array.isArray(related?.captures) ? related.captures : []) {
          const frameType = one.format === 'jpeg' ? 'image/jpeg' : 'image/png';
          const frameAdmitted = await captureService.admit(ctx, one.path, frameType, one.format === 'jpeg' ? 'screen.jpg' : 'screen.png', exec?.agent?.session?.id);
          await reportAttachment(exec, one, frameAdmitted);
          const entry = {
            frame: String(one.frame ?? ''),
            windowHwnd: Number(one.windowHwnd ?? args.hwnd),
            relation: String(one.relation ?? 'self'),
            x: Number(one.x ?? 0),
            y: Number(one.y ?? 0),
            width: Number(one.width ?? 0),
            height: Number(one.height ?? 0),
            path: String(one.path ?? ''),
          };
          if (Number.isFinite(Number(one.ownerHwnd))) entry.ownerHwnd = Number(one.ownerHwnd);
          if (Number.isFinite(Number(one.zRank))) entry.zRank = Number(one.zRank);
          entry.zRankKnown = one.zRankKnown === true;
          if (typeof one.windowTitle === 'string' && one.windowTitle !== '') entry.windowTitle = one.windowTitle;
          if (Number.isFinite(Number(one.imageWidth))) entry.imageWidth = Number(one.imageWidth);
          if (Number.isFinite(Number(one.imageHeight))) entry.imageHeight = Number(one.imageHeight);
          if (Number.isFinite(Number(one.effectiveScale ?? one.scale))) entry.scale = Number(one.effectiveScale ?? one.scale);
          if (typeof one.source === 'string' && one.source !== '') entry.source = one.source;
          if (typeof one.note === 'string' && one.note !== '') entry.note = one.note;
          if (frameAdmitted?.image !== undefined) entry.image = frameAdmitted.image;
          refs.noteFrame(exec?.agent?.session?.id, entry.frame);
          relatedFrames.push(entry);
        }
        if (relatedFrames.length === 0) {
          const why = (Array.isArray(related?.omitted) ? related.omitted : []).map((one) => `hwnd ${one.hwnd}: ${one.reason}`).join('; ');
          throw new Error(`[CAPTURE_SURFACE_UNAVAILABLE] hwnd ${Number(args.hwnd)} and the windows that belong to it could not be captured${why === '' ? '' : ` — ${why}`}.`);
        }
        if (Array.isArray(related.omitted) && related.omitted.length > 0) relatedOmitted = related.omitted.map((row) => ({ ...row }));
      }
      if (args.screenshot === true) {
        const format = resolveFormat(args.format, args.save_path);
        // The tree and the pixels have to be of the same thing. A read of hwnd 42 that
        // returned a picture of the screen was two observations in one reply, and the
        // second one was whatever happened to be in front.
        const viaWindow = Number.isFinite(Number(args.hwnd)) && Number(args.hwnd) > 0;
        const { shot, path } = await capture(exec, {
          path: args.save_path,
          scale: args.scale,
          format,
          window: viaWindow ? Number(args.hwnd) : undefined,
          settleMs: args.settle_ms,
        });
        const mediaType = shot.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const admitted = await captureService.admit(ctx, path, mediaType, shot.format === 'jpeg' ? 'screen.jpg' : 'screen.png', exec?.agent?.session?.id);
        await reportAttachment(exec, shot, admitted);
        cachedShot = { shot, admitted };
      }
      const value = stateValue(result, search, cachedShot);
      if (relatedFrames !== undefined) {
        value.frames = relatedFrames;
        if (relatedOmitted !== undefined) value.omitted = relatedOmitted;
      }
      if (value.shot !== undefined) refs.noteFrame(exec?.agent?.session?.id, value.shot.frame);
      if (restarted) {
        value.note = result.legacy === true
          ? 'the worker was restarted because it was answering through the legacy accessibility bridge, and this read still came back from it; treat the control types and ids as approximate'
          : 'the worker was answering through the legacy accessibility bridge and was restarted; this tree comes from the replacement';
      }
      // The key names the read, so a delta against one snapshot is not mistaken for a
      // repeat of the full read with the same selectors.
      markObservation(exec, `ui|${value.window.hwnd}|${value.mode}|${args.filter ?? ''}|${args.name ?? ''}|${args.control_type ?? ''}|${args.automation_id ?? ''}|${args.max_depth ?? ''}|${args.max_nodes ?? ''}|${args.patterns ?? ''}|${args.skip_empty ?? ''}|since=${args.since ?? ''}|prune=${args.prune ?? ''}|text=${args.text === undefined ? 'off' : JSON.stringify(args.text)}|tt=${textTarget === undefined ? '' : 'set'}|mtc=${args.max_text_chars ?? ''}`, value);
      // The refs in this read now belong to this conversation: acting on one from
      // another conversation is refused before it can pin an element nobody here chose.
      refs.noteSnapshot(exec?.agent?.session?.id, value.snapshot);
      return value;
    },
  }));
}
