/**
 * Browser half of @k-launcher/dsh-vision-control (DSH-Vision-Control / dsh-视-驭) — the 「电脑操作」 icon chip.
 *
 * It registers one entry into the composer's official `conversation.input.left`
 * list slot, which the shell renders in the tool row between the permission and
 * plan chips and the model selector — the position the reference design shows.
 * The entry is a toggle with one refinement: clicking it flips the capability for the
 * Session this composer belongs to, and the host refuses every `computer_*` tool call
 * while it is off — but while a watch session is alive (the chip says 盯屏中), a click
 * stops the watch first and leaves the capability itself on.
 *
 * The chip talks to its host half over the plugin's own JSON route. Those routes
 * are registered through `ctx.webServer`, so they sit on the same origin as the
 * page and a relative fetch reaches them without touching the authenticated
 * `/api` surface.
 *
 * Everything is written against the host's own theme variables (`--dsw-*`) so
 * the control follows light/dark and any future theme without a private palette.
 */
window.__ModuleLoader__.load({
  id: '@k-launcher/dsh-vision-control',
  factory(require) {
    const reactModule = require('react');
    /** The platform seed may hand back a namespace object; accept both shapes. */
    const React = reactModule !== null && typeof reactModule === 'object' && typeof reactModule.createElement === 'function'
      ? reactModule
      : reactModule?.default;

    const reactDomModule = require('react-dom');
    const ReactDOM = reactDomModule !== null && typeof reactDomModule === 'object' && typeof reactDomModule.createPortal === 'function'
      ? reactDomModule
      : reactDomModule?.default;

    const CSS_ID = 'dsh-computer-use-style';
    const ROUTE = '/computer-use';
    const LABEL = '电脑操作';
    const MODE_ORDER = ['disabled', 'watch', 'control'];
    const MODE_DETAILS = {
      disabled: { label: '禁用功能' },
      watch: { label: '仅观看' },
      control: { label: '观看+操作' },
    };

    /**
     * 优-P0-01 授权面三件套的头件：宿主 `admitStateRequest` 要求每个 /computer-use/*
     * 请求都带这个自定义头，缺了就是 403。跨站 simple request 发不出自定义头，
     * 预检又不命中 exact 路由，CSRF 在这一层卡死。全部三条 fetch（state 读/写、
     * watch 停止）共用同一份。
     */
    const ADMISSION_HEADER = { 'X-DSH-Computer-Use': '1' };

    /**
     * The control states the host reports, named for a user.
     *
     * A chip that can only say on/off cannot express the state a user most needs to see
     * after pressing stop on something that is mid-batch: "stopping" is not "off" yet, and
     * saying off while the desktop is still being unwound is exactly the lie the review
     * called out.
     *
     * `watching`（优-P0-14）：watch 会话存活（含 60s 宽限期的温热）且没有调用在飞、
     * 也不在撤销排水时——屏幕正在被实时采集，「眼睛睁着必须看得见」。优先级
     * stopping > busy > watching > ready > observing。
     */
    const CONTROL_LABEL = {
      off: '未开启',
      observing: '仅观察',
      ready: '可操作',
      busy: '执行中',
      watching: '盯屏中',
      stopping: '停止中',
      stopped: '已停止',
    };

    /**
     * How often the chip re-reads the state while the host reports something in motion.
     *
     * A settled chip is *not* left alone — see {@link IDLE_SYNC_MS} — because the capability can
     * be changed from somewhere else (another page toggling the same Session, or a
     * `computer_stop` call). What this faster rate buys is the two moments a user is watching:
     * a batch running, and a stop draining.
     */
    const CONTROL_POLL_MS = 1500;

    /**
     * How often a *settled* chip re-reads the state.
     *
     * The chip used to stop reading as soon as it saw `ready` / `off` / `stopped`, and that
     * effect's dependencies were `[sessionId, readState]` — so nothing ever restarted it. Another
     * page, or a tool that disables the capability for the Session, left this page showing a
     * stale switch. A low-frequency read while the page is visible is the cheap fix; the sync
     * loop pauses while the document is hidden and reads immediately on focus or visibility
     * restore, so a background tab costs nothing.
     */
    const IDLE_SYNC_MS = 5000;

    const CSS = `
.dsh-cu-chip {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  max-width: 160px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family);
  font-size: var(--dsw-font-xs-13, 13px);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .12s ease, color .12s ease, border-color .12s ease;
}
.dsh-cu-chip:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-cu-chip:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color);
  outline-offset: -1px;
}
.dsh-cu-chip[data-state="on"] {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
}
.dsh-cu-chip[data-state="on"]:hover:not(:disabled) {
  color: var(--dsw-alias-brand-primary);
}
.dsh-cu-chip[data-state="busy"],
.dsh-cu-chip:disabled {
  opacity: .55;
  cursor: default;
}
.dsh-cu-chip[data-state="error"],
.dsh-cu-chip[data-state="unmounted"] {
  color: var(--dsw-alias-state-error-primary);
}
/* The host half never mounted, so there is nothing to switch: say so in the cursor. */
.dsh-cu-chip[data-state="unmounted"] {
  cursor: help;
}
.dsh-cu-chip[data-state="unsupported"] {
  color: var(--dsw-alias-label-tertiary);
  cursor: not-allowed;
}
.dsh-cu-chip[data-state="unsupported"]:hover {
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cu-chip .dsh-cu-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: .45;
}
.dsh-cu-chip[data-state="on"] .dsh-cu-dot {
  opacity: 1;
}
/* What the control is doing right now, next to whether it is on. */
.dsh-cu-chip[data-control="busy"] .dsh-cu-dot,
.dsh-cu-chip[data-control="stopping"] .dsh-cu-dot {
  background: var(--dsw-alias-state-warning-primary, currentColor);
  opacity: 1;
  animation: dsh-cu-pulse 1.1s ease-in-out infinite;
}
/* 盯屏中同样脉冲——眼睛睁着就是活动态；但保留 chip 自身颜色（开启时是品牌色），
   不用警示色：盯屏是正常工作的活，busy/stopping 才是要收敛的排水。 */
.dsh-cu-chip[data-control="watching"] .dsh-cu-dot {
  opacity: 1;
  animation: dsh-cu-pulse 1.1s ease-in-out infinite;
}
.dsh-cu-chip[data-control="stopped"] .dsh-cu-dot {
  opacity: .35;
}
/* A switch that did not come back. The position may be perfectly confirmed and rendering as
   on/off, so the warning rides on the dot instead of on data-state. */
.dsh-cu-chip[data-warning="switch"] .dsh-cu-dot {
  background: var(--dsw-alias-state-error-primary, currentColor);
  opacity: 1;
}
.dsh-cu-root {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dsh-cu-chip {
  min-width: 26px;
  justify-content: center;
  gap: 0;
  padding: 0 5px;
}
.dsh-cu-mode-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  vertical-align: middle;
}
.dsh-cu-menu {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 138px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-label-tertiary);
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-interactive-bg-hover));
  box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
  font-family: var(--dsw-font-family);
}
.dsh-cu-mode-item {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: var(--dsw-font-xs-13, 13px);
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-cu-mode-item:hover,
.dsh-cu-mode-item[aria-checked="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-cu-mode-item[aria-checked="true"] {
  color: var(--dsw-alias-brand-primary);
}
.dsh-cu-mode-item:focus-visible,
.dsh-cu-watch-stop:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color);
  outline-offset: -1px;
}
.dsh-cu-watch-stop {
  box-sizing: border-box;
  min-height: 24px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-label-tertiary);
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-family: var(--dsw-font-family);
  font-size: var(--dsw-font-xs-13, 13px);
  white-space: nowrap;
  cursor: pointer;
}
.dsh-cu-watch-stop:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-cu-watch-stop:disabled {
  opacity: .55;
  cursor: default;
}
.dsh-cu-error {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 1001;
  width: max-content;
  max-width: 280px;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md, 6px);
  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-state-error-primary);
  font-family: var(--dsw-font-family);
  font-size: var(--dsw-font-xs-13, 13px);
  line-height: 1.4;
  white-space: normal;
  box-shadow: 0 4px 16px rgb(0 0 0 / 16%);
}
@keyframes dsh-cu-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: .6; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-cu-chip[data-control="busy"] .dsh-cu-dot,
  .dsh-cu-chip[data-control="stopping"] .dsh-cu-dot,
  .dsh-cu-chip[data-control="watching"] .dsh-cu-dot {
    animation: none;
  }
}
`;

    /**
     * One consistent 24-pixel line-icon family for all three permission modes.
     * These are vectors, not platform-dependent emoji; currentColor follows the DSH theme.
     */
    function ModeIcon({ mode }) {
      const shapes = mode === 'watch'
        ? [
            React.createElement('path', { key: 'eye', d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z' }),
            React.createElement('circle', { key: 'pupil', cx: 12, cy: 12, r: 2.8 }),
          ]
        : mode === 'unknown'
          ? [
              React.createElement('rect', { key: 'screen', x: 3, y: 4, width: 18, height: 12, rx: 2 }),
              React.createElement('path', { key: 'stand', d: 'M8 20h8M12 16v4' }),
              React.createElement('path', { key: 'question', d: 'M9.3 8.5a2.7 2.7 0 0 1 5.2 1c0 1.8-2.5 2-2.5 3.5M12 14.5h.01' }),
            ]
          : [
              React.createElement('rect', { key: 'screen', x: 3, y: 4, width: 18, height: 12, rx: 2 }),
              React.createElement('path', { key: 'stand', d: 'M8 20h8M12 16v4' }),
              mode === 'disabled'
                ? React.createElement('path', { key: 'slash', d: 'M4 4l16 16' })
                : React.createElement('path', { key: 'pointer', d: 'M13 8.5 18.5 14l-3 .5 2 3-2 1-2-3-2 2Z' }),
            ];
      return React.createElement(
        'svg',
        {
          className: `dsh-cu-mode-icon dsh-cu-mode-icon-${mode}`,
          'data-icon': mode,
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        shapes,
      );
    }

    /**
     * Turn a `/computer-use/state` payload into the chip's own status.
     *
     * The payload's *shape* is not re-checked here: {@link requestState} and
     * {@link requestToggle} already refused anything without a boolean `enabled`, so by the time
     * a payload reaches this function it is one the chip can render.
     * @param payload - the host's JSON reply.
     * @returns the status object the chip renders from.
     */
    function statusFrom(payload, switchFailure = '') {
      const mode = MODE_ORDER.includes(payload.mode)
        ? payload.mode
        : payload.enabled === true ? 'control' : 'disabled';
      const control = payload.control ?? {};
      const lastAction = control.lastAction ?? null;
      // 优-P0-14：宿主 controlState 里的原始盯屏块。宿主可能已把 control.state 折成
      // 'watching'，也可能只给这个块；客户端按同一优先级自行折叠，两个版本行为一致。
      const watch = control.watch ?? null;
      return {
        phase: 'ready',
        mode,
        enabled: mode !== 'disabled',
        supported: payload.supported !== false,
        note: payload.reason ?? '',
        control: typeof control.state === 'string' ? control.state : '',
        controlDetail: lastAction !== null && typeof lastAction.what === 'string' ? lastAction.what : '',
        controlOwner: typeof control.lease?.owner === 'string' ? control.lease.owner : '',
        inFlight: Number.isFinite(control.inFlight) ? Number(control.inFlight) : 0,
        // 盯屏会话存活（含 60s 宽限期的温热）：以「会话存活」而非「正在出图」为判据，
        // 模型思考的间隙期不闪烁。
        watchAlive: watch !== null && watch.alive === true,
        watchSeconds: watch !== null && Number.isFinite(watch.seconds) ? Number(watch.seconds) : 0,
        watchSource: watch !== null && typeof watch.source === 'string' ? watch.source : '',
        // Whether the *last switch attempt* failed. Kept separate from `phase` because the two
        // questions are different: "what position is the capability in" can be answered again by
        // a read, while "your click did not take" stays true until the next successful switch.
        switchFailed: switchFailure !== '',
        ...(switchFailure !== '' ? { note: switchFailure } : {}),
      };
    }

    /**
     * A status for a read that failed, kept separate so both readers agree.
     *
     * 404 keeps its own phase: it is the one failure the user can act on by restarting the app,
     * and it must not be reported as a generic error. The status code rides on the error object
     * so a server that answers 404 with a JSON body still lands here.
     */
    function failedStatus(error, previous = {}) {
      const unmounted = error?.status === 404 || error?.message === 'HTTP 404';
      const confirmed = MODE_ORDER.includes(previous.mode);
      return {
        phase: unmounted ? 'unmounted' : 'error',
        mode: confirmed ? previous.mode : null,
        confirmed,
        enabled: confirmed && previous.enabled === true,
        supported: previous.supported !== false,
        control: typeof previous.control === 'string' ? previous.control : '',
        controlDetail: typeof previous.controlDetail === 'string' ? previous.controlDetail : '',
        controlOwner: typeof previous.controlOwner === 'string' ? previous.controlOwner : '',
        inFlight: Number.isFinite(previous.inFlight) ? previous.inFlight : 0,
        watchAlive: previous.watchAlive === true,
        watchSeconds: Number.isFinite(previous.watchSeconds) ? previous.watchSeconds : 0,
        watchSource: typeof previous.watchSource === 'string' ? previous.watchSource : '',
        switchFailed: previous.switchFailed === true,
        note: unmounted
          ? '主机半未加载：/computer-use/state 返回 404'
          : String(error?.message ?? error),
      };
    }

    /**
     * 已盯时长的人话（盯屏标签与提示用）：小于一分钟说秒，小于一小时说分钟，
     * 再长说小时+分。0 或未知返回空串，不占位置。
     */
    function formatWatchDuration(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return '';
      const whole = Math.floor(seconds);
      if (whole < 60) return `${whole} 秒`;
      const minutes = Math.floor(whole / 60);
      if (minutes < 60) return `${minutes} 分钟`;
      return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    }

    /**
     * Read a reply's JSON body without letting a malformed body hide the HTTP status.
     * @param response - the fetch reply.
     * @returns the decoded body, or `undefined` when it is not JSON.
     */
    async function readJson(response) {
      try {
        return await response.json();
      } catch {
        return undefined;
      }
    }

    /**
     * Build the failure for a reply the chip will not accept.
     *
     * The server's own `error` string is preferred over `HTTP <code>`, because "HTTP 500" tells a
     * user nothing while the host's message names the actual refusal. The status is kept on the
     * error so {@link failedStatus} can still recognise 404.
     * @param response - the fetch reply.
     * @param payload - its decoded body, when it had one.
     * @param fallback - message for a body with no `error` of its own.
     * @returns the error to reject with.
     */
    function replyFailure(response, payload, fallback) {
      const message = typeof payload?.error === 'string' && payload.error !== ''
        ? payload.error
        : fallback;
      const error = new Error(message);
      error.status = response.status;
      return error;
    }

    /**
     * Read one Session's capability state.
     *
     * Both readers go through here so that "what counts as a usable reply" is decided once:
     * the HTTP status, the host's own `ok` flag, and the *type* of `enabled` are all checked.
     * A reply that fails any of them is an error, not a state — treating `{ok: false}` as
     * "off" is how a chip ends up lying about the switch.
     * @param sessionId - the Session to ask about.
     * @param signal - abort signal for a read that is being superseded.
     * @returns the host's payload.
     */
    async function requestState(sessionId, signal) {
      const response = await fetch(`${ROUTE}/state?sessionId=${encodeURIComponent(sessionId)}`, {
        signal,
        headers: { accept: 'application/json', ...ADMISSION_HEADER },
      });
      const payload = await readJson(response);
      if (!response.ok) throw replyFailure(response, payload, `HTTP ${response.status}`);
      if (payload?.ok === false) throw replyFailure(response, payload, 'the host refused the read');
      if (!MODE_ORDER.includes(payload?.mode) && typeof payload?.enabled !== 'boolean') {
        throw new Error('the host did not report a valid mode or legacy enabled flag');
      }
      return payload;
    }

    /**
     * Ask the host to switch one Session's capability.
     *
     * The reply is the authority on the new state: turning it off is a *stop* on the host side
     * (revoke, cancel in flight, unwind what the worker is holding), so the answer only arrives
     * once that has happened, and its `enabled` / `control` are what the chip must show.
     * @param sessionId - the Session to switch.
     * @param enabled - the target value.
     * @returns the host's payload.
     */
    async function requestMode(sessionId, mode) {
      const response = await fetch(`${ROUTE}/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ADMISSION_HEADER },
        body: JSON.stringify({ sessionId, mode }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw replyFailure(response, payload, `HTTP ${response.status}`);
      if (payload?.ok === false) throw replyFailure(response, payload, 'the host refused the switch');
      if (!MODE_ORDER.includes(payload?.mode) && typeof payload?.enabled !== 'boolean') {
        throw new Error('the host did not report a valid mode or legacy enabled flag');
      }
      return payload;
    }

    /**
     * Stop the live watch session (优-P0-14「盯屏中」态的点击动作).
     *
     * 只闭眼、不动授权：盯屏是「授权开启」之上的一个活动，停掉它不该把授权一起收回。
     * 回执是与 state 相同形状的完整权威状态，芯片照旧以回执为准。
     * @param sessionId - the Session the chip belongs to.
     * @returns the host's payload.
     */
    async function requestWatchStop(sessionId) {
      const response = await fetch(`${ROUTE}/watch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ADMISSION_HEADER },
        body: JSON.stringify({ sessionId, action: 'stop' }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw replyFailure(response, payload, `HTTP ${response.status}`);
      if (payload?.ok === false) throw replyFailure(response, payload, 'the host refused to stop watching');
      if (!MODE_ORDER.includes(payload?.mode) && typeof payload?.enabled !== 'boolean') {
        throw new Error('the host did not report a valid mode or legacy enabled flag');
      }
      return payload;
    }

    /**
     * The chip itself.
     *
     * Three pieces of state, and the split between them is the whole point:
     *
     *   * `status` — what is rendered. React state, so a change redraws.
     *   * `current` — the request bookkeeping (session epoch, read sequence, in-flight toggle,
     *     current read's AbortController, mounted flag). A ref, because a click has to *see*
     *     "a switch is already in flight" synchronously: a second click in the same render pass
     *     must be refused, and `setStatus` is not visible until the next render.
     *   * the host's reply — the only thing allowed to declare the capability on or off.
     *
     * Every reply is accepted only if its epoch *and* read sequence still match, which is what
     * keeps a slow GET from overwriting a POST that already landed, and keeps a previous
     * Session's reply from touching the next Session's chip.
     * @param props - slot props; `sessionId` identifies the Session to enable.
     */
    function ComputerUseChip(props) {
      const sessionId = props?.sessionId;
      const [status, setStatus] = React.useState({ phase: 'loading', mode: null, enabled: false, supported: true, note: '', control: '', controlDetail: '', controlOwner: '', inFlight: 0, watchAlive: false, watchSeconds: 0, watchSource: '', switchFailed: false });
      const current = React.useRef({ mounted: false, epoch: 0, readId: 0, mutationId: 0, toggling: false, read: null });
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [activeMode, setActiveMode] = React.useState('disabled');
      const [menuPosition, setMenuPosition] = React.useState({ top: 8, left: 8 });
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const menuRef = React.useRef(null);
      const itemRefs = React.useRef([]);
      const restoreFocusRef = React.useRef(false);
      const switchFailureRef = React.useRef('');

      // 优-P0-14 盯屏折叠：宿主可能已把 control.state 折成 'watching'，也可能只给
      // control.watch 原始块；无论哪种，「watch 会话存活且非 busy/stopping」时芯片
      // 都说盯屏中——优先级 stopping>busy>watching>ready>observing 在客户端兜底，
      // 宿主规格落地前后行为一致（缺 watch 块时 watchAlive 为 false，一切照旧）。
      const controlState = typeof status.control === 'string' ? status.control : '';
      const watching = status.watchAlive === true && controlState !== 'busy' && controlState !== 'stopping';
      const effectiveControl = watching ? 'watching' : controlState;

      /**
       * Read the state and, if this read is still the current one, show it.
       *
       * Called by the session effect, by the sync loop, and after a failed switch. It refuses to
       * start while a switch is in flight — the POST reply is authoritative then, and a
       * concurrent GET could only race it.
       * @param options.switchFailure - when set, this read is *confirming* a switch that did not
       *   come back. Its message is carried into the confirmed status, so a successful read does
       *   not silently erase the failure; and a read that fails too leaves the failure on screen
       *   instead of replacing it with its own.
       * @returns the status it applied, or `undefined` when it declined or was superseded.
       */
      const readState = React.useCallback((options = {}) => {
        const ref = current.current;
        if (sessionId === undefined || sessionId === null || !ref.mounted) return Promise.resolve(undefined);
        if (ref.toggling) return Promise.resolve(undefined);

        const epoch = ref.epoch;
        const readId = ++ref.readId;
        // Supersede the read already on the wire: even if its abort loses the race, its reply
        // fails the `readId` check below.
        ref.read?.abort();
        const controller = new AbortController();
        ref.read = controller;

        const settle = () => {
          if (ref.read === controller) ref.read = null;
        };
        /** Only a reply whose epoch and sequence still match may write state. */
        const accepted = () => ref.mounted && ref.epoch === epoch && ref.readId === readId;

        return requestState(sessionId, controller.signal)
          .then((payload) => {
            settle();
            if (!accepted()) return undefined;
            if (options.switchFailure !== undefined) switchFailureRef.current = String(options.switchFailure);
            const next = statusFrom(payload, switchFailureRef.current);
            setStatus(next);
            return next;
          })
          .catch((error) => {
            settle();
            if (error?.name === 'AbortError') return undefined;
            if (!accepted()) return undefined;
            console.warn('[computer-use] could not read the capability state:', error);
            if (options.switchFailure !== undefined) switchFailureRef.current = String(options.switchFailure);
            const warning = switchFailureRef.current;
            let next;
            setStatus((previous) => {
              const failure = failedStatus(error, previous);
              next = warning === '' ? failure : { ...failure, note: warning, switchFailed: true };
              return next;
            });
            return next;
          });
      }, [sessionId]);

      const closeMenu = React.useCallback((restoreFocus = true) => {
        restoreFocusRef.current = restoreFocus;
        setMenuOpen(false);
      }, []);

      const updateMenuPosition = React.useCallback(() => {
        const rect = triggerRef.current?.getBoundingClientRect?.();
        if (!rect) return;
        const menuWidth = 156;
        const menuHeight = 112;
        const margin = 8;
        const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 1280;
        const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 800;
        const left = Math.max(margin, Math.min(rect.right - menuWidth, viewportWidth - menuWidth - margin));
        let top = rect.top - menuHeight - 6;
        if (top < margin) top = Math.min(rect.bottom + 6, viewportHeight - menuHeight - margin);
        const next = { top: Math.max(margin, top), left };
        setMenuPosition((previous) => previous.top === next.top && previous.left === next.left ? previous : next);
      }, []);

      const openMenu = React.useCallback(() => {
        const ref = current.current;
        if (!ref.mounted || ref.toggling || status.supported === false || status.phase === 'loading'
          || status.phase === 'busy' || controlState === 'stopping') return;
        // Preserve the old recovery path: a missing host half is retried, not presented as a
        // menu whose choices could not possibly succeed.
        if (status.phase === 'unmounted') {
          setStatus((previous) => ({ ...previous, phase: 'loading' }));
          void readState();
          return;
        }
        updateMenuPosition();
        setActiveMode(MODE_ORDER.includes(status.mode) ? status.mode : status.enabled ? 'control' : 'disabled');
        setMenuOpen(true);
      }, [status.mode, status.enabled, status.supported, status.phase, controlState, readState, updateMenuPosition]);

      // Focus after the closed/open render, when refs point at the current DOM elements.
      React.useEffect(() => {
        if (!menuOpen) {
          if (restoreFocusRef.current) {
            restoreFocusRef.current = false;
            triggerRef.current?.focus?.();
          }
          return;
        }
        restoreFocusRef.current = false;
        const index = Math.max(0, MODE_ORDER.indexOf(activeMode));
        itemRefs.current[index]?.focus?.();
      }, [menuOpen, activeMode]);

      // A root contains both the trigger and its absolutely-positioned menu. Pointer-down is used
      // so the menu closes before an outside control consumes the click; Escape works from either
      // the trigger or an item. Both listeners are removed as soon as the menu closes/unmounts.
      React.useEffect(() => {
        if (!menuOpen || typeof document === 'undefined') return undefined;
        const onPointerDown = (event) => {
          if (!rootRef.current?.contains?.(event.target) && !menuRef.current?.contains?.(event.target)) closeMenu(true);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeMenu(true);
          }
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [menuOpen, closeMenu]);

      // The menu is portalled to document.body, so it is a real overlay rather than
      // composer content. Keep its fixed anchor correct on viewport and scroll changes.
      React.useEffect(() => {
        if (!menuOpen) return undefined;
        updateMenuPosition();
        window.addEventListener('resize', updateMenuPosition);
        window.addEventListener('scroll', updateMenuPosition, true);
        return () => {
          window.removeEventListener('resize', updateMenuPosition);
          window.removeEventListener('scroll', updateMenuPosition, true);
        };
      }, [menuOpen, updateMenuPosition]);

      // Session identity owns the request lifecycle. Changing Session is not a re-read of the same
      // chip: it invalidates every reply still on the wire, drops any in-flight switch, and shows
      // loading until this Session's own first read lands. The cleanup is what makes an unmounted
      // chip incapable of writing state — no reply may outlive the effect that started it.
      React.useEffect(() => {
        const ref = current.current;
        if (sessionId === undefined || sessionId === null) return undefined;
        ref.mounted = true;
        ref.epoch += 1;
        ref.readId += 1;
        ref.mutationId += 1;
        ref.toggling = false;
        ref.read?.abort();
        ref.read = null;
        switchFailureRef.current = '';
        setMenuOpen(false);
        setActiveMode('disabled');
        setStatus({ phase: 'loading', mode: null, enabled: false, supported: true, note: '', control: '', controlDetail: '', controlOwner: '', inFlight: 0, watchAlive: false, watchSeconds: 0, watchSource: '', switchFailed: false });
        void readState();
        return () => {
          ref.mounted = false;
          ref.epoch += 1;
          ref.readId += 1;
          ref.toggling = false;
          ref.read?.abort();
          ref.read = null;
        };
      }, [sessionId, readState]);

      // Keep syncing, not just while something is moving.
      //
      // A chip that stops reading once it sees `ready` / `off` / `stopped` goes stale the moment
      // the capability is changed anywhere else — another page on the same Session, or a
      // `computer_stop` call that disables it. So the loop always re-arms: fast while the host
      // reports `busy` / `stopping`, slow when settled, paused while the document is hidden, and
      // read immediately on focus or visibility restore rather than waiting out the interval.
      //
      // The next read is armed from *what the read returned*, never from the rendered status: a
      // read that returns the same value changes no dependency, so an effect keyed on the status
      // would poll once and then go stale. Arming after the reply also makes overlapping requests
      // impossible by construction.
      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined;
        const doc = typeof document === 'undefined' ? undefined : document;
        const win = typeof window === 'undefined' ? undefined : window;
        let stopped = false;
        let timer = null;

        const arm = (ms) => {
          if (stopped) return;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(tick, ms);
        };
        const tick = () => {
          if (stopped) return;
          timer = null;
          if (doc?.visibilityState === 'hidden') {
            arm(IDLE_SYNC_MS);
            return;
          }
          void readState().then((next) => {
            if (stopped) return;
            // 盯屏中同样快读：已盯时长在走、模型也可能随时停看；轮询是本地请求，零 token。
            const inMotion = next !== undefined && (next.control === 'busy' || next.control === 'stopping' || next.watchAlive === true);
            arm(inMotion ? CONTROL_POLL_MS : IDLE_SYNC_MS);
          });
        };
        /** Come back from a background tab, or a window the user just refocused, right away. */
        const wake = () => {
          if (stopped) return;
          if (timer !== null) clearTimeout(timer);
          tick();
        };

        doc?.addEventListener?.('visibilitychange', wake);
        win?.addEventListener?.('focus', wake);
        arm(CONTROL_POLL_MS);
        return () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          doc?.removeEventListener?.('visibilitychange', wake);
          win?.removeEventListener?.('focus', wake);
        };
      }, [sessionId, readState]);

      /**
       * Switch the capability, once.
       *
       * The order here is the fix for "clicking does not reliably control the state":
       *  1. `ref.toggling` is set **synchronously**, before any React state, so a second click in
       *     the same render pass is refused — `status.phase === 'busy'` cannot do that job,
       *     because the render that would show it has not happened yet.
       *  2. The read already in flight is invalidated *before* the POST, so a slow GET cannot come
       *     back and repaint the switch with the value it read a moment ago.
       *  3. The UI shows `busy` and keeps the last *confirmed* `enabled`; it does not paint the
       *     target value as if it had already succeeded.
       *  4. The reply decides. On failure the chip says so and then asks the host what the truth
       *     is — a lost response does not mean the server did not act, so it must not "restore"
       *     the old value by guessing.
       */
      const selectMode = React.useCallback((mode) => {
        const ref = current.current;
        closeMenu(true);
        if (sessionId === undefined || sessionId === null || !ref.mounted || !MODE_ORDER.includes(mode)) return;
        if (status.supported === false || ref.toggling || status.phase === 'loading'
          || status.phase === 'busy' || controlState === 'stopping') return;
        // Choosing the already-confirmed radio is a no-op, not a needless host mutation.
        if (mode === status.mode) return;
        ref.toggling = true;
        const epoch = ref.epoch;
        const mutationId = ++ref.mutationId;
        const accepted = () => ref.mounted && ref.epoch === epoch && ref.mutationId === mutationId;

        // Invalidate the previous GET before the POST. Even an abort that loses the wire race
        // cannot pass readState's sequence check and overwrite this mutation's authoritative reply.
        ref.readId += 1;
        ref.read?.abort();
        ref.read = null;
        // Keep the old mode visible until the server confirms the requested one.
        setStatus((previous) => ({ ...previous, phase: 'busy', note: '', switchFailed: false }));

        requestMode(sessionId, mode)
          .then((payload) => {
            if (!accepted()) return;
            switchFailureRef.current = '';
            setStatus(statusFrom(payload));
          })
          .catch((error) => {
            if (!accepted()) return;
            console.error('[computer-use] could not change the capability mode:', error);
            const note = String(error?.message ?? error);
            switchFailureRef.current = note;
            setStatus((previous) => ({ ...previous, phase: 'error', note, switchFailed: true }));
            // A lost reply is not proof that the host did nothing. Confirm its actual state while
            // retaining the visible failure instead of guessing the target or old mode.
            ref.toggling = false;
            void readState({ switchFailure: note });
          })
          .finally(() => {
            if (ref.mutationId === mutationId) ref.toggling = false;
          });
      }, [sessionId, status.mode, status.phase, status.supported, controlState, readState, closeMenu]);

      /**
       * Stop the watch session, leaving the capability on (优-P0-14).
       *
       * 复用 toggle 的全部纪律：`toggling` 锁同步落下（同一渲染里的第二击被拒）、
       * 在飞的读先作废（慢 GET 不能拿旧值重画）、回执是权威（答复到了才改画面）。
       * 失败走 switchFailure 确认读：「这次点击没生效」必须留在屏幕上，不能被下一次
       * 轮询悄悄抹掉。
       */
      const stopWatch = React.useCallback(() => {
        const ref = current.current;
        if (sessionId === undefined || sessionId === null || !ref.mounted) return;
        if (status.supported === false) return;
        if (ref.toggling) return;
        if (status.phase === 'loading') return;
        if (controlState === 'stopping') return;
        closeMenu(true);
        ref.toggling = true;
        const epoch = ref.epoch;
        const mutationId = ++ref.mutationId;
        const accepted = () => ref.mounted && ref.epoch === epoch && ref.mutationId === mutationId;

        ref.readId += 1;
        ref.read?.abort();
        ref.read = null;

        requestWatchStop(sessionId)
          .then((payload) => {
            if (!accepted()) return;
            switchFailureRef.current = '';
            setStatus(statusFrom(payload));
          })
          .catch((error) => {
            if (!accepted()) return;
            console.error('[computer-use] could not stop the watch session:', error);
            const note = `停止盯屏没有成功：${String(error?.message ?? error)}`;
            switchFailureRef.current = note;
            setStatus((previous) => ({ ...previous, phase: 'error', note, switchFailed: true }));
            // Let the confirming read through, then ask the host what actually happened —
            // same discipline as a failed switch: never guess the old value back.
            ref.toggling = false;
            void readState({ switchFailure: note });
          })
          .finally(() => {
            if (ref.mutationId === mutationId) ref.toggling = false;
          });
      }, [sessionId, status.supported, status.phase, controlState, readState, closeMenu]);


      if (sessionId === undefined || sessionId === null) return null;

      const unsupported = status.supported === false;
      const dataState = unsupported
        ? 'unsupported'
        : status.phase === 'ready' ? (status.enabled ? 'on' : 'off') : status.phase;
      const controlLabel = CONTROL_LABEL[effectiveControl] ?? '';
      const watchDuration = formatWatchDuration(status.watchSeconds);
      const watchSourceText = status.watchSource === 'screen' ? '整个屏幕'
        : status.watchSource === 'camera' ? '摄像头'
        : status.watchSource === 'file' ? '文件回放'
        : status.watchSource === 'obs' ? 'OBS 源'
        : '';
      // Only the control states worth saying out loud go into the tooltip: "可操作" is the
      // normal case and would just be noise next to "已开启".
      const controlSuffix = status.enabled && (effectiveControl === 'busy' || effectiveControl === 'stopping' || effectiveControl === 'stopped' || effectiveControl === 'watching')
        ? `（${controlLabel}${effectiveControl === 'busy' && status.controlDetail !== '' ? `：${status.controlDetail}` : ''}${effectiveControl === 'watching' && watchDuration !== '' ? `：已盯 ${watchDuration}` : ''}${status.inFlight > 1 ? `，${status.inFlight} 个调用` : ''}）`
        : '';
      // 芯片保持纯图标（用户明确要求：删文字只留图标+状态点）；状态细节全部走 tooltip
      // （controlSuffix）与 aria-label，状态由 data-control 属性驱动 CSS 让状态点变色表达。
      // "Your click did not take" and "the position is X" are two facts, and the chip can hold
      // both: a confirming read may re-establish the position, but it must not erase the failure.
      const switchFailed = status.switchFailed === true;
      const position = MODE_DETAILS[status.mode]?.label ?? '禁用功能';
      const title = unsupported
        ? `${LABEL}：当前平台不支持。${status.note}`
        : status.phase === 'unmounted'
          ? status.confirmed === true
            ? `${LABEL}：主机半未加载（${status.note}），当前无法读回状态。图标仍是最后一次确认过的模式「${position}」。请完全退出 DSH 再重新打开；若重启后仍无法读取，控制台里的 [computer-use] 日志会写出激活失败的原因。`
            : `${LABEL}：未能确认状态，尚未确认模式；主机半没有加载（${status.note}）。请完全退出 DSH 再重新打开；若重启后仍是这个状态，控制台里的 [computer-use] 日志会写出激活失败的原因。`
          : status.phase === 'error' && status.confirmed === false
            ? switchFailed
              ? `${LABEL}：这次切换没有成功（${status.note}），随后也没能读回状态；此前从未确认过这个 Session 的模式。点击可以重试。`
              : `${LABEL}：未能确认状态（${status.note}）。这个 Session 尚未确认过模式，因此不会把它误显示为禁用；点击可以重试。`
          : switchFailed && status.phase === 'error'
            // The switch failed *and* nothing could be read back, so the position on screen is
            // the last one ever confirmed — not a fresh report. Say both, because "the switch did
            // not take" and "we could not check" are different things to act on.
            ? `${LABEL}：这次切换没有成功（${status.note}），随后也没能读回状态。芯片上仍是最后一次确认过的位置「${position}」，点击可以重试。`
            : switchFailed
              ? `${LABEL}：这次切换没有成功（${status.note}）。主机现在报告的是「${position}」——芯片显示的就是它。点击可以再试一次。`
              : status.phase === 'error'
                ? `${LABEL}：未能确认状态（${status.note}）。芯片上显示的仍是最后一次确认过的状态，点击可以重试。`
                : watching
                  ? `${LABEL}${controlSuffix}：屏幕正在被实时采集${watchSourceText === '' ? '' : `（${watchSourceText}）`}。可用旁边的“停止盯屏”按钮结束采集；点击模式图标可切换权限。`
                  : status.mode === 'control'
                    ? `${LABEL}${controlSuffix}：观看+操作。模型可以截屏、移动鼠标、点击和输入；点击可切换模式。`
                    : status.mode === 'watch'
                      ? `${LABEL}${controlSuffix}：仅观看。模型只能使用只读观察、影子运行和回放，不能写入鼠标键盘或启动 active 操控；点击可切换模式。`
                      : `${LABEL}：已禁用。模型不会看到电脑工具或相关提示，直接调用也会被拒绝；点击可选择其他模式。`;

      const stopping = effectiveControl === 'stopping';
      const mode = MODE_ORDER.includes(status.mode)
        ? status.mode
        : status.enabled === true ? 'control' : status.phase === 'ready' ? 'disabled' : 'unknown';
      const modeDetails = MODE_DETAILS[mode] ?? { label: status.phase === 'loading' ? '正在读取模式' : '未能确认状态' };
      const triggerLabel = stopping
        ? `${LABEL}（${modeDetails.label}、停止中）`
        : unsupported
          ? `${LABEL}（当前平台不支持）`
          : status.phase === 'unmounted'
            ? status.confirmed === true
              ? `${LABEL}（${modeDetails.label}，状态读取失败）`
              : `${LABEL}（未能确认状态）`
            : `${LABEL}（${modeDetails.label}）`;
      const triggerTitle = stopping ? `${LABEL}：停止中，请等待撤销完成。` : title;

      const onTriggerKeyDown = (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        openMenu();
      };
      const onMenuKeyDown = (event) => {
        const index = Math.max(0, MODE_ORDER.indexOf(activeMode));
        let nextIndex;
        if (event.key === 'ArrowDown') nextIndex = (index + 1) % MODE_ORDER.length;
        else if (event.key === 'ArrowUp') nextIndex = (index + MODE_ORDER.length - 1) % MODE_ORDER.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = MODE_ORDER.length - 1;
        if (nextIndex !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          setActiveMode(MODE_ORDER[nextIndex]);
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          selectMode(activeMode);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
        } else if (event.key === 'Tab') {
          closeMenu(false);
        }
      };

      const trigger = React.createElement(
        'button',
        {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-cu-chip',
          'data-state': dataState,
          'data-mode': mode,
          'data-control': effectiveControl,
          'data-warning': switchFailed ? 'switch' : undefined,
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          'aria-label': triggerLabel,
          title: triggerTitle,
          disabled: unsupported || status.phase === 'loading' || status.phase === 'busy' || stopping,
          onClick: () => { if (menuOpen) closeMenu(true); else openMenu(); },
          onKeyDown: onTriggerKeyDown,
        },
        React.createElement(ModeIcon, { mode }),
      );
      const menu = menuOpen && !stopping ? React.createElement(
        'div',
        {
          key: 'menu', ref: menuRef, className: 'dsh-cu-menu', role: 'menu',
          'aria-label': '电脑操作模式', 'data-overlay': 'computer-use-mode',
          style: { top: `${menuPosition.top}px`, left: `${menuPosition.left}px` },
          onKeyDown: onMenuKeyDown,
        },
        MODE_ORDER.map((itemMode, index) => {
          const details = MODE_DETAILS[itemMode];
          return React.createElement(
            'button',
            {
              key: itemMode,
              ref: (node) => { itemRefs.current[index] = node; },
              type: 'button',
              className: 'dsh-cu-mode-item',
              role: 'menuitemradio',
              'aria-checked': itemMode === mode,
              tabIndex: itemMode === activeMode ? 0 : -1,
              onClick: () => selectMode(itemMode),
            },
            React.createElement(ModeIcon, { key: 'icon', mode: itemMode }),
            React.createElement('span', { key: 'label' }, details.label),
          );
        }),
      ) : null;
      const watchStop = watching ? React.createElement(
        'button',
        {
          key: 'watch-stop',
          type: 'button',
          className: 'dsh-cu-watch-stop',
          disabled: status.phase === 'busy',
          onClick: stopWatch,
        },
        '停止盯屏',
      ) : null;
      const error = status.note && (switchFailed || status.phase === 'error') ? React.createElement(
        'div', {
          key: 'error', className: 'dsh-cu-error', role: 'alert',
          // The menu is portaled to body, so an ancestor :has rule cannot see it.
          // Reserve the 112px menu + 6px gap inline instead.
          style: menuOpen ? { bottom: 'calc(100% + 118px)' } : undefined,
        }, status.note,
      ) : null;
      const menuOverlay = menu ? ReactDOM.createPortal(menu, document.body) : null;
      return React.createElement('div', { className: 'dsh-cu-root', ref: rootRef }, trigger, menuOverlay, watchStop, error);
    }

    /**
     * Client plugin body.
     * @param ctx - the browser-side Cordis context.
     */
    function apply(ctx) {
      try {
        if (document.getElementById(CSS_ID) === null) {
          const style = document.createElement('style');
          style.id = CSS_ID;
          style.textContent = CSS;
          document.head.appendChild(style);
        }
        // Deliberately not wrapped in ctx.effect: slots.inject already runs the
        // callback inside its own effect, waits until the slot is actually
        // declared, and re-runs it whenever that declaration changes epochs. The
        // callback returns the registration disposer, which is what it expects.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
          { name: 'conversation.input.left', id: 'computer-use', order: 40, label: LABEL },
          ComputerUseChip,
        ));
        console.info('[computer-use] composer chip registered');
      } catch (error) {
        console.error('[computer-use] apply failed:', error);
      }
    }

    return { apply, inject: ['slots'] };
  },
});
