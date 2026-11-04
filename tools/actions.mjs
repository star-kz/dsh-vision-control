/**
 * `computer_actions` 工具注册体 —— 重构-1 从 index.js 逐字迁出（批次 3）。
 *
 * 行为不变：下面的对象字面量与原 index.js 块逐字一致；它用到的 apply() 闭包依赖经
 * `env` 注入（由 index.js 在装配期构建的 toolEnv 提供）。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decorateFailure } from '../internal/failures.mjs';
import { normalizeCaptureSpec, resolveFormat, screenshotEnvelope } from '../internal/capture.mjs';
import { WAIT_CONDITION_SCHEMA, BATCH_STEP_SCHEMA, BATCH_VALUE_SCHEMA, shotValue, stateValue, renderState } from '../internal/tool-contracts.mjs';
export function registerComputerActions(env) {
  const { safeRegister, defineTracedTool, captureService, refs, requireGrant, call, reportAttachment, markObservation, normalizeTextTarget, shotRoot, actionTimeoutMs, ctx } = env;
  safeRegister(defineTracedTool({
    name: 'computer_actions',
    description:
      'Perform several computer actions in ONE call, optionally ending with a screenshot, an accessibility read, or both. Steps: click, type, key, scroll, drag, move, paste, focus, clipboard, and the UI Automation steps. Use it when you already know the next few steps — one call instead of a chain, a round trip saved per step. Steps run in order; if one fails the earlier ones have already happened and the result names the failing index. `evidence` reports whether the screen changed — if it says nothing moved, do not repeat that coordinate. Requires 电脑操作.',
    parameters: {
      steps: {
        type: 'array',
        required: true,
        description: 'The actions to perform, in order (maximum 50).',
        items: BATCH_STEP_SCHEMA,
      },
      // 新-P1-02 B / workerfeat A.1: the rehearsal switch.
      dry_run: {
        type: 'boolean',
        description: "Rehearse this batch instead of performing it (default false): every check a real run would do — target resolution, the window guard, the deadline arithmetic, each step's own preflight — runs for real, but nothing is dispatched to the desktop. The reply is a rehearsal receipt: a per-step verdict list (`steps`), `allOk`, and `wouldStopAt` naming the first step a real run would refuse (-1: none). `actionSent` is always false and the desktop is never touched, so asking costs nothing but the round trip. Use it to validate a long or risky sequence before committing to it.",
      },
      screenshot: {
        type: 'boolean',
        description: 'Capture one screenshot after the last step, in the same round trip. Implied by any `screenshot` step.',
      },
      state: {
        type: 'object',
        additionalProperties: false,
        description: 'End the call with an accessibility read too, so one round trip returns what your steps did. Same keys as computer_ui; `{}` reads the focused window.',
        properties: {
          hwnd: { type: 'integer', description: 'Window to read; omit for the window that has focus.' },
          filter: { type: 'string', description: 'Case-insensitive substring over name, automation id and control type.' },
          name: { type: 'string', description: 'Substring match against the accessible name.' },
          control_type: { type: 'string', description: "Control type to require, e.g. 'Button', 'Document'." },
          automation_id: { type: 'string', description: 'Exact automation id.' },
          max_depth: { type: 'integer', description: 'Tree depth to walk, 1 to 10.' },
          max_nodes: { type: 'integer', description: 'Node budget, 10 to 1500.' },
          patterns: { type: 'boolean', description: 'Probe each node for the patterns it supports (default true).' },
          skip_empty: { type: 'boolean', description: 'Omit anonymous container nodes (default true).' },
          since: { type: 'string', description: 'A snapshot id from an earlier read (the `snapshot` field). Only what changed since then comes back, with a `delta` summary — for watching a long operation without re-reading a tree that did not move. A snapshot the worker no longer holds is not guessed at: the full tree comes back and `delta.known` says why.' },
          prune: { type: 'boolean', description: "Same as computer_ui's `prune`." },
          text: {
            type: 'object',
            additionalProperties: false,
            description: "Same as computer_ui's `text`, applied to this trailing observation: `{}` = the focused control and its selection, `document`/`selected` on request, all sharing `max_text_chars`. A field that could not be read reports why instead of coming back empty.",
            properties: {
              focused: { type: 'boolean', description: 'As in computer_ui: the focused control as one line.' },
              selection: { type: 'boolean', description: 'As in computer_ui: the text selected inside the target.' },
              document: { type: 'boolean', description: 'As in computer_ui: the document behind the target.' },
              selected: { type: 'boolean', description: 'As in computer_ui: what a list or tree has selected.' },
            },
          },
          text_target: {
            type: 'object',
            additionalProperties: false,
            description: "Same as computer_ui's `text_target`: a `ref` from a read, or an exact selector.",
            properties: {
              ref: { type: 'string', description: 'A [s#.#] marker from a read.' },
              automation_id: { type: 'string', description: 'Exact AutomationId.' },
              name: { type: 'string', description: 'Accessible name substring.' },
              control_type: { type: 'string', description: 'Control type, e.g. Edit.' },
              class_name: { type: 'string', description: 'Exact window class.' },
              index: { type: 'integer', description: 'Which match, 0-based.' },
              hwnd: { type: 'integer', description: 'Window to look in.' },
            },
          },
          max_text_chars: { type: 'integer', description: 'Shared text budget (default 2000, maximum 16000).' },
          max_selected: { type: 'integer', description: 'Selected items listed (default 20, maximum 100).' },
          // 新-P1-03 / ocr O.1: same shape as computer_ui's `ocr`; the worker reads it
          // off the trailing state request (12-batching.ps1 passes `ocr = $s.ocr` on).
          ocr: {
            type: 'object',
            additionalProperties: false,
            description: "Same as computer_ui's `ocr`, applied to this trailing observation: `{}` reads the window's pixels with Windows OCR (unverified lines — prefer `text` whenever the tree can answer).",
            properties: {
              language: { type: 'string', description: "BCP-47 language tag for the recognizer (e.g. 'zh-CN')." },
              max_lines: { type: 'integer', description: 'How many lines to return at most (default 40, maximum 200).' },
              points: { type: 'boolean', description: 'Attach a clickable centre point to each line (default true).' },
            },
          },
        },
      },
      // 优-P0-10：这里原本还有一份步骤级语义的 `wait_for` 键，被下面批级定义（同对象字面量
      // 双写、后者胜）覆盖，模型永远看不到它。已删；步骤级语义移交 tool-contracts.mjs 的
      // BATCH_STEP_SCHEMA.condition（由 dev-failures 施工）。
      evidence: {
        type: 'boolean',
        description: 'Fingerprint the screen before and after the steps and report whether it changed (default true). One-sided evidence: "unchanged" is a strong claim that nothing visible happened, while "changed" is inconclusive.',
      },
      stop_on_window_change: {
        type: 'boolean',
        description: 'Stop the batch if the window in front changes partway through (default true): the remaining steps would go into a window you never chose. The reply names the step that was not run. A change you *expected* belongs in expected_transitions, which lets that one through while the guard catches the rest.',
      },
      expected_transitions: {
        type: 'array',
        description: "Windows this sequence may end up in — a dialog it opens, an 'export complete' box it waits for. Each entry matches by `to` (hwnd), `title` (substring), `process` (substring) or `pid`; the string 'any' accepts whatever comes to the front. A matching change is followed and reported in `transitions`; a non-matching one still stops the batch.",
        items: { type: 'object', additionalProperties: true },
      },
      deadline_ms: {
        type: 'integer',
        description: "One budget for this whole call, shared by every wait inside it (default: none). Without it each wait is bounded only by its own timeout_ms, so five 30 s waits quietly claim two and a half minutes. A wait cut short reports `timeoutFrom: 'deadline'`.",
      },
      settle_ms: {
        type: 'integer',
        description: 'Batch-wide settle floor for every capture in this call — see computer_screenshot.settle_ms.',
      },
      stability_ms: {
        type: 'number',
        description: 'Batch-wide stability budget for every capture in this call — see computer_screenshot.stability_ms.',
      },
      stable: {
        type: 'boolean',
        description: 'A plain switch for the same wait, for every capture in this call: false skips it, true asks for the backend\'s default budget. An explicit `stability_ms` — here or on the step — wins.',
      },
      save_path: {
        type: 'string',
        description: 'Absolute path for the capture — see computer_screenshot.save_path. The extension picks the format unless `format` is given.',
      },
      scale: {
        type: 'number',
        description: 'Downscale the capture before encoding (default 1). 0.5 halves both edges; the envelope reports the mapping back to click coordinates.',
      },
      format: {
        type: 'string',
        enum: ['jpeg', 'png'],
        description: "Capture format — see computer_screenshot.format.",
      },
      wait_for: {
        ...WAIT_CONDITION_SCHEMA,
        description: "Wait for a condition *after* the steps and before the trailing capture or read: \"do this, and come back when the result is there\". The worker polls it, so one call replaces the click / read / \"not yet\" / wait / read-again loop, and it returns the moment the condition holds instead of at the end of a sleep chosen before anyone knew how fast the app would be. The reply's `waits` says what it saw and how long it took. Give it a `timeout_ms` too (default 30000).",
      },
      timeout_ms: { type: 'integer', description: 'For the batch-level `wait_for`: how long to keep checking before giving up (default 30000, maximum 120000). A timeout is reported in `waits`, not thrown.' },
      poll_ms: { type: 'integer', description: 'For the batch-level `wait_for`: how often to check (default 120, range 20 to 2000).' },
      window: {
        type: 'integer',
        description: 'Aim this call\'s captures at one window instead of the screen: it renders itself, so the frame is that window even while something covers it. A window capture ignores `display`, and a `region` is then read as a rectangle *of that window*.',
      },
      require_window: {
        type: 'boolean',
        description: 'Only meaningful together with `window`: refuse rather than fall back to the screen if that window cannot render its own pixels, because a fallback shows whatever covers it.',
      },
      display: {
        type: 'integer',
        description: 'Aim this call\'s captures at one display, by index as reported by computer_screenshot. Ignored when `window` is given.',
      },
      region: {
        type: 'object',
        additionalProperties: false,
        description: 'Aim this call\'s captures at one rectangle: absolute virtual-desktop pixels (the same meaning computer_screenshot gives it), cut out of the window\'s own pixels when `window` is also given, so a covered window\'s panel can still be read. Pass region_space: \'window\' to give the numbers inside the window instead.',
        properties: {
          x: { type: 'integer', required: true, description: 'Left edge.' },
          y: { type: 'integer', required: true, description: 'Top edge.' },
          width: { type: 'integer', required: true, description: 'Width in pixels.' },
          height: { type: 'integer', required: true, description: 'Height in pixels.' },
        },
      },
      region_space: {
        type: 'string',
        enum: ['screen', 'window'],
        description: "Which space `region` is in, spelled the same way computer_screenshot spells it: 'screen' (the default) is absolute virtual-desktop pixels; 'window' is pixels of the window named by `window`, which then has to be given.",
      },
      surface: {
        type: 'string',
        enum: ['window', 'client'],
        description: "With `window`: 'window' (the default) delivers the whole window, 'client' delivers the client area only (title bar, borders and resize grips cropped away).",
      },
      clip: {
        type: 'boolean',
        description: "With `window` and a region: take the part of the rectangle that exists inside the window instead of refusing when it runs past its edge (default false). The reply says what was actually captured.",
      },
    },
    output: {
      schema: BATCH_VALUE_SCHEMA,
      render: (_args, value) => {
        // 新-P1-02 B2 / workerfeat A.2: a rehearsal receipt gets its own voice and must
        // never say the steps ran — nothing was dispatched — so it returns before the
        // ordinary "Performed …" head below can be reached.
        if (value.dryRun === true) {
          const blocks = [{
            type: 'text',
            text: value.allOk === true
              ? `彩排完成 (dry run — every check ran for real and nothing was dispatched to the desktop): all ${value.count} step(s) would be accepted; a real run would not stop anywhere (wouldStopAt = -1).`
              : `彩排完成 (dry run — every check ran for real and nothing was dispatched to the desktop): a real run would stop at step ${value.wouldStopAt}. Steps after it were rehearsed assuming the earlier steps do what they say.`,
          }];
          if (Array.isArray(value.steps) && value.steps.length > 0) {
            blocks.push({
              type: 'text',
              text: `per-step verdicts (they describe the desktop at rehearsal time):\n${value.steps.map((one) => `  ${one.step}. ${one.action}: ${one.verdict}${one.detail === '' ? '' : ` — ${one.detail}`}${one.warning === undefined ? '' : `\n     warning: ${one.warning}`}${one.budgetLeftMs === undefined ? '' : ` (${one.budgetLeftMs} ms of deadline left on reaching it)`}`).join('\n')}`,
            });
          }
          if (value.outcome === 'dry-run-deadline') {
            blocks.push({ type: 'text', text: `The call's ${value.deadlineMs ?? 'given'} ms deadline would be spent before step ${value.wouldStopAt} could start — give the real run a larger deadline_ms, or split the sequence.` });
          } else if (value.outcome === 'dry-run-reobserve') {
            blocks.push({ type: 'text', text: 'The window in front is not the one this batch would be in, and no expected_transitions entry covers it. Observe again (computer_windows, computer_ui) and declare the transition, or pass stop_on_window_change: false.' });
          }
          for (const transition of value.transitions ?? []) {
            blocks.push({
              type: 'text',
              text: `window transition: step ${transition.atStep} would move the front from hwnd ${transition.from} to hwnd ${transition.to} ('${transition.title}' [${transition.process}]) — allowed because expected_transitions matched it by ${transition.matchedBy}.`,
            });
          }
          if (value.waitForNote !== undefined) blocks.push({ type: 'text', text: `wait_for: ${value.waitForNote}` });
          if (value.trailing !== undefined) {
            const parts = Object.entries(value.trailing).map(([k, v]) => `${k}: ${v}`);
            if (parts.length > 0) blocks.push({ type: 'text', text: `trailing observations — ${parts.join('; ')}.` });
          }
          if (value.timing !== undefined) blocks.push({ type: 'text', text: `the rehearsal took ${value.timing.workerMs} ms inside the backend.` });
          return blocks;
        }
        const head = value.failedAt >= 0
          ? `${value.canceled === true ? 'Cancelled at' : 'Performed'} ${value.count} step(s), then step ${value.failedAt} ${value.canceled === true ? 'was not run' : 'failed'}: ${value.error ?? 'unknown error'}`
          : `Performed ${value.count} step(s) in one call`;
        const blocks = [{ type: 'text', text: `${head}\n${value.performed.map((line, index) => `  ${index}. ${line}`).join('\n')}` }];
        if (value.timing !== undefined) {
          const queued = value.timing.queueMs === undefined ? '' : `, ${value.timing.queueMs} ms of it queued behind another call`;
          const starting = value.timing.startMs === undefined ? '' : `, ${value.timing.startMs} ms of it waiting for the worker to start`;
          blocks.push({
            type: 'text',
            text: `timing: ${value.timing.workerMs} ms inside the backend (every step, plus any capture and its encoding)${starting}${queued}, ${value.timing.admitMs} ms to attach the image`,
          });
        }
        if (value.canceled === true) {
          blocks.push({
            type: 'text',
            text: 'The call was cancelled, so the steps after this point did not run. The steps that did run were really performed — observe the screen before deciding what to do next, and do not assume a cancellation means nothing happened.',
          });
        }
        // The budget, said in the caller's terms (§5.7): "the deadline was spent" and "a
        // blocking call ran longer than the deadline" are different facts, and only the second
        // one means the plugin did not stop in time.
        if (value.outOfBudget === true) {
          blocks.push({
            type: 'text',
            text: `The call stopped because its ${value.deadlineMs ?? 'given'} ms deadline was spent before step ${value.failedAt} could start. The ${value.count} step(s) listed above really ran. Nothing was sent for the step that refused, so decide from what is on screen now (computer_screenshot or computer_ui) and give the next call a larger deadline_ms (or split the sequence) — repeating this call with the same budget will stop in the same place.`,
          });
        } else if (value.partial === true) {
          blocks.push({
            type: 'text',
            text: `Step ${value.failedAt} (${value.progress?.[value.failedAt]?.action ?? 'the step'}) landed only partly: the input it sent did not all reach the desktop, so the application is now in a state that is neither "before" nor "after" that step. Observe it (computer_screenshot or computer_ui) before sending anything else — repeating the step as it stands would apply the part that already landed a second time.`,
          });
        } else if (value.deadlineMet === false && value.overDeadlineMs !== undefined && value.overDeadlineMs > 0) {
          blocks.push({
            type: 'text',
            text: `This call ran ${value.overDeadlineMs} ms past its ${value.deadlineMs} ms deadline before it returned. A blocking call inside the worker cannot be interrupted from here, so the number is real rather than clamped to the budget — check whether it was still on the right side of what you asked for.`,
          });
        }
        if (value.evidence !== undefined && value.failedAt < 0) {
          const how = value.evidence.reused === true
            ? ' The "after" reading came from a frame this call had already taken, so no second frame was grabbed for it.'
            : '';
          blocks.push({
            type: 'text',
            text: (value.evidence.changed
              ? `evidence: the region (${value.evidence.x},${value.evidence.y}) ${value.evidence.width}x${value.evidence.height} is not pixel-identical to before the steps. That is weak evidence — a blinking caret, an animation or a clock changes it too — so treat "changed" as inconclusive and read the state instead.`
              : `evidence: the region (${value.evidence.x},${value.evidence.y}) ${value.evidence.width}x${value.evidence.height} is pixel-identical to before the steps — the input was delivered but produced no visible difference at all. Do not simply repeat the same coordinate: observe with computer_ui, act on a control instead, or drive the app from the keyboard.`) + how,
          });
        }
        if (value.state !== undefined) blocks.push({ type: 'text', text: renderState(value.state) });
        if (value.observation !== undefined) {
          const which = value.observation.what === 'capture' ? 'capture' : 'read';
          blocks.push({
            type: 'text',
            text: `The ${which} at the end of this call failed (${value.observation.error}). ${value.observation.note ?? 'The steps above did run — what the window looks like now is simply not known from here.'}`,
          });
        }
        for (const report of value.waits ?? []) {
          const budget = report.timeoutFrom === 'default' ? ' (default budget)' : report.timeoutFrom === 'deadline' ? " (this call's deadline, not the step's own timeout)" : '';
          const held = report.heldMs === undefined || report.stableMs === undefined ? '' : ` It held for ${report.heldMs} ms of the ${report.stableMs} ms asked for.`;
          if (report.outcome === 'unavailable') {
            blocks.push({
              type: 'text',
              text: `wait_for: ${report.what} — it could not be observed at all: ${report.polls} check(s) over ${report.waitedMs} ms${budget}. The last check said: ${report.observed}. That is not the same statement as the condition being false — the provider would not answer, or the read was cut short — so look at the window yourself (computer_ui or computer_screenshot) instead of waiting longer.`,
            });
            continue;
          }
          blocks.push({
            type: 'text',
            text: report.satisfied
              ? `wait_for: ${report.what} — it became true after ${report.waitedMs} ms (${report.polls} check(s) inside a ${report.timeoutMs} ms budget${budget}). ${report.observed}.${held}`
              : `wait_for: ${report.what} — it never became true: ${report.polls} check(s) over ${report.waitedMs} ms${budget}, and the last one saw this: ${report.observed}.${report.heldMs !== undefined && report.stableMs !== undefined ? ' It was seen true, but not for the whole time asked for.' : ''} ${value.nextStep !== undefined ? `The steps after it were not run (the batch stopped at step ${value.nextStep}); the steps before it did run.` : 'The steps before it did run;'} decide whether to wait longer (raise timeout_ms), look at the window (computer_ui or computer_screenshot), or act on what is there now.`,
          });
        }
        for (const transition of value.transitions ?? []) {
          blocks.push({
            type: 'text',
            text: `window transition: step ${transition.atStep} moved the front from hwnd ${transition.from} to hwnd ${transition.to} ('${transition.title}' [${transition.process}]) — followed because expected_transitions matched it by ${transition.matchedBy}.`,
          });
        }
        if (value.failedAt >= 0 && value.actionSent === false) {
          blocks.push({
            type: 'text',
            text: 'nothing was sent to the desktop by this call: the steps that ran were reads, and the step that stopped it failed before it sent anything. That is the one failure mode where repeating the call cannot double an effect.',
          });
        }
        if (value.failedAt >= 0 && value.nextStep !== undefined) {
          blocks.push({
            type: 'text',
            text: `continue from step ${value.nextStep} once you have looked — \`wroteSteps\` lists the steps that did send input, so you know what the desktop has already been told.`,
          });
        }
        if (value.captureUsed !== undefined && value.captureUsed.from === 'retaken') {
          blocks.push({
            type: 'text',
            text: 'the frame below was captured after the last step: a screenshot step earlier in the batch had already produced one, but a write came after it, so the older frame would have shown the state before your steps finished.',
          });
        }
        if (value.captureUsed !== undefined && value.captureUsed.from === 'step-stale') {
          blocks.push({
            type: 'text',
            text: 'the frame below came from a screenshot step that ran before this batch\'s last write, so it shows the state before the steps finished. Pass screenshot: true with a save_path (or add a screenshot step at the end) if you need the state after them.',
          });
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
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (steps.length === 0) throw new Error('[BAD_REQUEST] computer_actions needs at least one step');
      if (steps.length > 50) throw new Error('[BAD_REQUEST] computer_actions accepts at most 50 steps per call');
      // Same rule as computer_click: a frame id that is present but empty was meant to be
      // cited, and clicking absolute coordinates instead is a substitution nobody notices.
      const emptyFrameStep = steps.findIndex((step) => typeof step?.from_frame === 'string' && step.from_frame.trim() === '');
      if (emptyFrameStep >= 0) {
        throw new Error(`[BAD_REQUEST] step ${emptyFrameStep} has an empty from_frame; pass a frame id from computer_screenshot, or omit it to use absolute coordinates.`);
      }
      // A step names one way to move: a point, a delta, or a path. Accepting two of them
      // would mean the worker quietly preferring one, which is the kind of substitution a
      // caller only discovers after the pointer has moved somewhere it did not choose.
      steps.forEach((step, index) => {
        const action = String(step?.action ?? '').toLowerCase();
        const hasDelta = Number.isFinite(Number(step?.dx)) || Number.isFinite(Number(step?.dy));
        if (action === 'move' && hasDelta) {
          if (Number.isFinite(Number(step?.x)) || Number.isFinite(Number(step?.y))) {
            throw new Error(`[BAD_REQUEST] step ${index} is a relative move (dx/dy) and also gives x/y: pick one — a delta or a destination point.`);
          }
          if (typeof step?.from_frame === 'string' && step.from_frame !== '') {
            throw new Error(`[BAD_REQUEST] step ${index} is a relative move (dx/dy) and also cites from_frame: a frame names a point in an image, which a delta is not.`);
          }
        }
        if (action === 'drag' && Array.isArray(step?.path) && step.path.length > 0) {
          const alsoCorners = ['from_x', 'from_y', 'to_x', 'to_y'].filter((name) => step[name] !== undefined);
          if (alsoCorners.length > 0) {
            throw new Error(`[BAD_REQUEST] step ${index} is a path drag and also gives ${alsoCorners.join('/')}: a path already names where the gesture starts and ends.`);
          }
          if (step.path.length < 2) throw new Error(`[BAD_REQUEST] step ${index} has a drag path of one point, so there is nothing to drag.`);
          if (step.path.length > 64) throw new Error(`[BAD_REQUEST] step ${index} has a drag path of ${step.path.length} points; the most is 64.`);
        }
      });
      // A frame is a citation of a capture, and the pixels belong to the conversation that
      // took it: the worker is shared between conversations, the images are not (A08).
      steps.forEach((step) => {
        if (typeof step?.from_frame === 'string') refs.assertFrameOwnership(exec?.agent?.session?.id, step.from_frame);
      });
      // Every step's target protection is checked before the first one runs, for the same
      // reason the worker validates the whole batch up front: a step 6 that cannot be
      // allowed must not be discovered after steps 1-5 have already moved the desktop.
      steps.forEach((step, index) => {
        if (typeof step?.ref === 'string' && step.ref !== '') refs.assertRefOwnership(exec?.agent?.session?.id, step.ref);
      });
      const format = resolveFormat(args.format, args.save_path);
      const wantsShot = args.screenshot === true || steps.some((step) => step?.action === 'screenshot');
      let shotPath;
      if (wantsShot) {
        await mkdir(shotRoot, { recursive: true });
        shotPath = args.save_path ?? captureService.nextCapturePath(shotRoot, format);
      }
      // A batch that waits for a condition must not be killed by the transport while it
      // waits. The worker owns the budget, so its own report is what says whether that
      // budget was respected; this is only the ceiling above it. A step-level budget counts
      // too, and the batch default fills in for a condition that names none.
      const waitBudget = (waitFor) => (
        waitFor?.timeout_ms ?? (waitFor === undefined ? undefined : args.timeout_ms)
      );
      // 优-P0-09：固定 `wait` 步（seconds×1000）也计入 transport 预算——否则模型从未声明
      // deadline，第三个 wait 步却被隐式 deadline 裁成 deadline-partial，DEADLINE_EXHAUSTED
      // 不说真话。
      const batchWaits = [
        waitBudget(args.wait_for),
        ...steps.filter((step) => step?.action === 'wait_for').map(waitBudget),
        ...steps.filter((step) => step?.action === 'wait').map((step) => Number(step?.seconds) * 1000),
      ]
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
      // One budget for the whole call, shared by every wait inside it (C04). The transport
      // timeout is what would otherwise cut a batch off from the outside with nothing in the
      // reply to show for it, so the worker's own deadline is set inside it, and a wait ended
      // by that deadline says so (`timeoutFrom: 'deadline'`) instead of pretending the step's
      // own timeout expired.
      const transportMs = Math.max(actionTimeoutMs, 60_000, batchWaits.length === 0 ? 0 : Math.max(...batchWaits) + 20_000);
      const deadlineMs = Number.isFinite(Number(args.deadline_ms)) && Number(args.deadline_ms) > 0
        ? Number(args.deadline_ms)
        : Math.max(5_000, transportMs - 10_000);
      // Same normalisation as the single-shot capture: with `window`, a region is that
      // window's own pixels; without it, screen pixels (A01).
      const spec = normalizeCaptureSpec({
        window: args.window,
        region: args.region,
        regionSpace: args.region_space,
        surface: args.surface,
        display: args.display,
        clip: args.clip,
      });
      const result = await call(exec, 'batch', {
        steps,
        // 新-P1-02 B2 / workerfeat A.1: the rehearsal flag rides the same request; the
        // worker reads either spelling, and lease.mjs bypasses the write lease for it.
        dryRun: args.dry_run === true ? true : undefined,
        surface: spec.surface,
        settleMs: args.settle_ms,
        stabilityMs: args.stability_ms,
        stable: args.stable,
        screenshot: args.screenshot === true,
        evidence: args.evidence ?? true,
        stopOnWindowChange: args.stop_on_window_change !== false,
        expectedTransitions: Array.isArray(args.expected_transitions) ? args.expected_transitions : undefined,
        deadlineMs,
        // A trailing observation takes the same text configuration as a standalone read
        // (B1): the whole point is that "do these steps, then tell me what the field says"
        // does not need a second call. `text_target` is validated here as well, so a
        // contradictory target is refused before anything on the desktop is touched.
        state: args.state === undefined ? undefined : { ...args.state, text_target: normalizeTextTarget(args.state.text_target) },
        path: shotPath,
        scale: args.scale,
        format,
        // Where the captures point, and the condition the call waits for. Both are the
        // same thing the single-step tools take, spelled the way the worker reads it.
        window: spec.window,
        requireWindow: args.require_window === true ? true : undefined,
        display: spec.display,
        region: spec.region,
        regionSpace: spec.regionSpace,
        clip: spec.clip,
        // A step's own `timeout_ms` / `poll_ms` win; the batch-level ones are the default for
        // conditions that name none. `computer_actions` owns both spellings, so the
        // resolution happens here rather than in the worker.
        waitFor: args.wait_for === undefined ? undefined : {
          ...args.wait_for,
          timeout_ms: args.wait_for.timeout_ms ?? args.timeout_ms,
          poll_ms: args.wait_for.poll_ms ?? args.poll_ms,
        },
        // A step-level wait is forwarded as it is; the worker reads `timeout_ms`/`poll_ms`
        // off the step, and the step's own default is the same 30 s the schema documents.
      }, { interactive: true, timeoutMs: transportMs, dryRun: args.dry_run === true });
      // The batch's own captures use the pacing arguments above, and the queue time is what
      // the call spent waiting for the worker before any of it started.
      const queueMs = Number(result?.__bridgeTiming?.queueMs ?? 0);
      // §7.5: a batch that spent seconds waiting for the worker to start is not a batch whose
      // steps were slow, and the reply has to be able to say which of the two happened.
      const startMs = Number(result?.__bridgeTiming?.startMs ?? 0);
      const value = {
        performed: Array.isArray(result.performed) ? result.performed.map((line) => String(line)) : [],
        count: Number(result.count ?? 0),
        failedAt: Number(result.failedAt ?? -1),
      };
      if (typeof result.error === 'string' && result.error !== '') value.error = decorateFailure(result.error);
      if (result.canceled === true) value.canceled = true;
      // Running out of budget is its own fact (§5.7): the step that refused did so because the
      // call was over, not because its arguments were wrong, and the two call for different
      // next moves. `outOfBudget` is what the worker sets on the step that refused; the three
      // deadline numbers are measured, never clamped to the budget.
      if (typeof result.outOfBudget === 'boolean') value.outOfBudget = result.outOfBudget;
      if (typeof result.partial === 'boolean') value.partial = result.partial;
      if (Array.isArray(result.partialSteps) && result.partialSteps.length > 0) {
        value.partialSteps = result.partialSteps.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      }
      // §5.2: what became of every step, not just the ones that "performed" something.
      if (Array.isArray(result.progress) && result.progress.length > 0) {
        value.progress = result.progress.map((one) => ({
          step: Number(one?.step ?? 0),
          action: String(one?.action ?? ''),
          state: String(one?.state ?? 'not-run'),
        }));
      }
      if (result.observation !== null && result.observation !== undefined && result.observation.failed === true) {
        value.observation = {
          failed: true,
          error: String(result.observation.error ?? 'the observation at the end of the call failed'),
        };
        if (typeof result.observation.what === 'string' && result.observation.what !== '') value.observation.what = result.observation.what;
        if (typeof result.observation.note === 'string' && result.observation.note !== '') value.observation.note = result.observation.note;
      }
      if (Number.isFinite(Number(result.deadlineMs)) && Number(result.deadlineMs) > 0) value.deadlineMs = Number(result.deadlineMs);
      if (Number.isFinite(Number(result.overDeadlineMs)) && Number(result.overDeadlineMs) >= 0) value.overDeadlineMs = Number(result.overDeadlineMs);
      if (typeof result.deadlineMet === 'boolean') value.deadlineMet = result.deadlineMet;
      // The ActionReceipt (B07): what was sent, what happened, and where to continue are
      // three separate facts, and a failure that hides the first two is the kind a caller
      // retries blindly.
      if (typeof result.outcome === 'string' && result.outcome !== '') value.outcome = result.outcome;
      if (typeof result.action_sent === 'boolean') value.actionSent = result.action_sent;
      if (Array.isArray(result.wroteSteps)) value.wroteSteps = result.wroteSteps.map((n) => Number(n)).filter((n) => Number.isFinite(n));
      // 新-P1-02 B2 / workerfeat A.2: the rehearsal receipt. `dryRun` is the unmixable
      // marker — a receipt that carries it never touched the desktop — so the render
      // below branches on it before any "performed" wording can be reached.
      if (result.dryRun === true) {
        value.dryRun = true;
        value.allOk = result.allOk === true;
        value.wouldStopAt = Number.isFinite(Number(result.wouldStopAt)) ? Number(result.wouldStopAt) : -1;
        value.steps = (Array.isArray(result.steps) ? result.steps : []).map((one) => {
          const report = {
            step: Number(one?.step ?? 0),
            action: String(one?.action ?? ''),
            verdict: String(one?.verdict ?? ''),
            dispatched: one?.dispatched === true,
            detail: String(one?.detail ?? ''),
          };
          if (one?.point !== null && one?.point !== undefined) {
            report.point = { x: Number(one.point.x ?? 0), y: Number(one.point.y ?? 0) };
          }
          if (typeof one?.via === 'string' && one.via !== '') report.via = one.via;
          if (typeof one?.frame === 'string' && one.frame !== '') report.frame = one.frame;
          if (typeof one?.warning === 'string' && one.warning !== '') report.warning = one.warning;
          if (Number.isFinite(Number(one?.elapsedMs))) report.elapsedMs = Number(one.elapsedMs);
          if (Number.isFinite(Number(one?.budgetLeftMs))) report.budgetLeftMs = Number(one.budgetLeftMs);
          return report;
        });
        if (Array.isArray(result.lines)) value.lines = result.lines.map((line) => String(line));
        if (typeof result.note === 'string' && result.note !== '') value.note = result.note;
        if (Number.isFinite(Number(result.deadlineLeftMs))) value.deadlineLeftMs = Number(result.deadlineLeftMs);
        // The trailing observations a rehearsal never produces are reported, not taken.
        if (typeof result.waitFor === 'string' && result.waitFor !== '') value.waitForNote = result.waitFor;
        if (result.trailing !== null && result.trailing !== undefined && typeof result.trailing === 'object') {
          value.trailing = { ...result.trailing };
        }
      }
      if (Number.isFinite(Number(result.nextStep)) && Number(result.nextStep) >= 0) value.nextStep = Number(result.nextStep);
      if (Array.isArray(result.transitions) && result.transitions.length > 0) {
        value.transitions = result.transitions.map((one) => {
          const entry = {
            atStep: Number(one?.atStep ?? 0),
            from: Number(one?.from ?? 0),
            to: Number(one?.to ?? 0),
            title: String(one?.title ?? ''),
            process: String(one?.process ?? ''),
            matchedBy: String(one?.matchedBy ?? ''),
          };
          if (typeof one?.note === 'string' && one.note !== '') entry.note = one.note;
          return entry;
        });
      }
      if (result.captureUsed !== null && result.captureUsed !== undefined) {
        const used = result.captureUsed;
        value.captureUsed = {
          from: String(used.from ?? 'step'),
          stepIndex: Number.isFinite(Number(used.stepIndex)) ? Number(used.stepIndex) : -1,
          afterLastWrite: used.afterLastWrite === true,
        };
        if (typeof used.note === 'string' && used.note !== '') value.captureUsed.note = used.note;
      }
      if (Array.isArray(result.waits) && result.waits.length > 0) {
        value.waits = result.waits.map((report) => {
          const one = {
            what: String(report?.what ?? ''),
            satisfied: report?.satisfied === true,
            waitedMs: Number(report?.waitedMs ?? 0),
            polls: Number(report?.polls ?? 0),
            timeoutMs: Number(report?.timeoutMs ?? 0),
            timeoutFrom: String(report?.timeoutFrom ?? 'explicit'),
            pollMs: Number(report?.pollMs ?? 0),
            observed: String(report?.observed ?? ''),
          };
          if (Number.isFinite(Number(report?.stableMs)) && Number(report.stableMs) > 0) one.stableMs = Number(report.stableMs);
          if (Number.isFinite(Number(report?.heldMs)) && Number(report.heldMs) >= 0 && one.stableMs !== undefined) one.heldMs = Number(report.heldMs);
          if (typeof report?.status === 'string' && report.status !== '') one.status = report.status;
          if (typeof report?.outcome === 'string' && report.outcome !== '') one.outcome = report.outcome;
          if (typeof report?.timeoutKind === 'string' && report.timeoutKind !== '') one.timeoutKind = report.timeoutKind;
          if (Number.isFinite(Number(report?.pollBackoffTo)) && Number(report.pollBackoffTo) > 0) one.pollBackoffTo = Number(report.pollBackoffTo);
          if (typeof report?.error === 'string' && report.error !== '') one.error = report.error;
          if (report?.window !== null && report?.window !== undefined) {
            one.window = {
              hwnd: Number(report.window.hwnd ?? 0),
              title: String(report.window.title ?? ''),
              process: String(report.window.process ?? ''),
              pid: Number(report.window.pid ?? 0),
            };
          }
          if (report?.control !== null && report?.control !== undefined) {
            const n = report.control;
            one.control = {
              depth: Number(n.depth ?? 0),
              name: String(n.name ?? ''),
              controlType: String(n.controlType ?? 'ControlType.Unknown'),
              automationId: String(n.automationId ?? ''),
              className: String(n.className ?? ''),
              enabled: n.enabled === true,
              offscreen: n.offscreen === true,
              x: Number(n.x ?? 0),
              y: Number(n.y ?? 0),
              width: Number(n.width ?? 0),
              height: Number(n.height ?? 0),
              patterns: Array.isArray(n.patterns) ? n.patterns.map((p) => String(p)) : [],
              ref: String(n.ref ?? ''),
            };
          }
          return one;
        });
      }
      if (result.evidence !== null && result.evidence !== undefined) {
        value.evidence = {
          changed: result.evidence.changed === true,
          before: String(result.evidence.before ?? ''),
          after: String(result.evidence.after ?? ''),
          x: Number(result.evidence.x ?? 0),
          y: Number(result.evidence.y ?? 0),
          width: Number(result.evidence.width ?? 0),
          height: Number(result.evidence.height ?? 0),
        };
        if (result.evidence.reused === true) value.evidence.reused = true;
      }
      if (result.state !== null && result.state !== undefined) {
        // `searched` is the caller's intent, not something the backend reports: it is
        // what tells the model whether it is looking at a match list or a whole tree.
        const stateArgs = args.state ?? {};
        const searched = [stateArgs.filter, stateArgs.name, stateArgs.control_type, stateArgs.automation_id]
          .some((value) => typeof value === 'string' && value !== '');
        const state = stateValue(result.state, searched, undefined);
        markObservation(exec, `ui|${state.window.hwnd}|${state.mode}|batch-state|${JSON.stringify(args.state ?? {})}`, state);        // The batch's trailing read mints refs too, so the session owns them the same way
        // it owns the ones computer_ui returned.
        refs.noteSnapshot(exec?.agent?.session?.id, state.snapshot);
        value.state = state;
      }
      if (result.shot !== null && result.shot !== undefined) {
        const shotMedia = result.shot.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const admitStarted = Date.now();
        const admitted = await captureService.admit(ctx, result.shot.path, shotMedia, result.shot.format === 'jpeg' ? 'screen.jpg' : 'screen.png', exec?.agent?.session?.id);
        await reportAttachment(exec, result.shot, admitted);
        const workerMs = Number(result.elapsedMs ?? 0);
        const admissionMs = Date.now() - admitStarted;
        value.shot = shotValue(result.shot, admitted);
        refs.noteFrame(exec?.agent?.session?.id, value.shot.frame);
        const timing = { workerMs, admitMs: admissionMs };
        if (queueMs > 0) timing.queueMs = Math.round(queueMs);
        if (startMs > 0) timing.startMs = Math.round(startMs);
        value.timing = timing;
      } else if (Number.isFinite(result.elapsedMs)) {
        const timing = { workerMs: Number(result.elapsedMs), admitMs: 0 };
        if (queueMs > 0) timing.queueMs = Math.round(queueMs);
        if (startMs > 0) timing.startMs = Math.round(startMs);
        value.timing = timing;
      }
      return value;
    },
  }));
}
