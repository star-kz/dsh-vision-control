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

    const CSS_ID = 'dsh-computer-use-style';
    const ROUTE = '/computer-use';
    const LABEL = '电脑操作';

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

    /** The monitor glyph the reference design shows beside the label. */
    function MonitorIcon() {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        React.createElement('rect', { key: 'screen', x: 1.7, y: 2.7, width: 12.6, height: 8.6, rx: 1.5 }),
        React.createElement('path', { key: 'stand', d: 'M8 11.3v2.4' }),
        React.createElement('path', { key: 'base', d: 'M5.4 13.7h5.2' }),
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
    function statusFrom(payload) {
      const control = payload.control ?? {};
      const lastAction = control.lastAction ?? null;
      // 优-P0-14：宿主 controlState 里的原始盯屏块。宿主可能已把 control.state 折成
      // 'watching'，也可能只给这个块；客户端按同一优先级自行折叠，两个版本行为一致。
      const watch = control.watch ?? null;
      return {
        phase: 'ready',
        enabled: payload.enabled === true,
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
        switchFailed: false,
      };
    }

    /**
     * A status for a read that failed, kept separate so both readers agree.
     *
     * 404 keeps its own phase: it is the one failure the user can act on by restarting the app,
     * and it must not be reported as a generic error. The status code rides on the error object
     * so a server that answers 404 with a JSON body still lands here.
     */
    function failedStatus(error) {
      const unmounted = error?.status === 404 || error?.message === 'HTTP 404';
      return {
        phase: unmounted ? 'unmounted' : 'error',
        enabled: false,
        supported: true,
        control: '',
        controlDetail: '',
        controlOwner: '',
        inFlight: 0,
        watchAlive: false,
        watchSeconds: 0,
        watchSource: '',
        switchFailed: false,
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
      if (typeof payload?.enabled !== 'boolean') throw new Error('the host did not report an enabled flag');
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
    async function requestToggle(sessionId, enabled) {
      const response = await fetch(`${ROUTE}/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...ADMISSION_HEADER },
        body: JSON.stringify({ sessionId, enabled }),
      });
      const payload = await readJson(response);
      if (!response.ok) throw replyFailure(response, payload, `HTTP ${response.status}`);
      if (payload?.ok === false) throw replyFailure(response, payload, 'the host refused the switch');
      if (typeof payload?.enabled !== 'boolean') throw new Error('the host did not report an enabled flag');
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
      if (typeof payload?.enabled !== 'boolean') throw new Error('the host did not report an enabled flag');
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
      const [status, setStatus] = React.useState({ phase: 'loading', enabled: false, supported: true, note: '', control: '', controlDetail: '', controlOwner: '', inFlight: 0, watchAlive: false, watchSeconds: 0, watchSource: '', switchFailed: false });
      const current = React.useRef({ mounted: false, epoch: 0, readId: 0, toggling: false, read: null });

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
            const next = statusFrom(payload);
            if (options.switchFailure !== undefined) {
              next.switchFailed = true;
              next.note = options.switchFailure;
            }
            setStatus(next);
            return next;
          })
          .catch((error) => {
            settle();
            if (error?.name === 'AbortError') return undefined;
            if (!accepted()) return undefined;
            console.warn('[computer-use] could not read the capability state:', error);
            // The confirming read failed as well: the failure it was confirming is still the most
            // useful thing on screen, so leave it there rather than swapping in this message.
            if (options.switchFailure !== undefined) return undefined;
            const next = failedStatus(error);
            setStatus(next);
            return next;
          });
      }, [sessionId]);

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
        ref.toggling = false;
        ref.read?.abort();
        ref.read = null;
        setStatus({ phase: 'loading', enabled: false, supported: true, note: '', control: '', controlDetail: '', controlOwner: '', inFlight: 0, watchAlive: false, watchSeconds: 0, watchSource: '', switchFailed: false });
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
      const toggle = React.useCallback(() => {
        const ref = current.current;
        if (sessionId === undefined || sessionId === null || !ref.mounted) return;

        // A chip whose host half never mounted has nothing to toggle. Re-reading the state is the
        // only useful move: it recovers on its own if the host half came up since, and it keeps
        // the failure visible instead of pretending to switch.
        if (status.phase === 'unmounted') {
          setStatus((previous) => ({ ...previous, phase: 'loading' }));
          void readState();
          return;
        }
        if (status.supported === false) return;
        if (ref.toggling) return;
        if (status.phase === 'loading') return;
        // 优-P0-14：停止排水期间禁止再提交——撤销正在落地，再一次翻转只会和它在半路相撞。
        if (controlState === 'stopping') return;
        ref.toggling = true;

        const next = !status.enabled;
        ref.readId += 1;
        ref.read?.abort();
        ref.read = null;
        // Keep the last *confirmed* position and clear the previous failure: what the user is
        // looking at now is "a switch is in flight", not the outcome of the last one.
        setStatus((previous) => ({ ...previous, phase: 'busy', note: '', switchFailed: false }));

        requestToggle(sessionId, next)
          .then((payload) => {
            if (!ref.mounted) return;
            setStatus(statusFrom(payload));
          })
          .catch((error) => {
            console.error('[computer-use] could not change the capability state:', error);
            if (!ref.mounted) return;
            const note = String(error?.message ?? error);
            setStatus((previous) => ({ ...previous, phase: 'error', note, switchFailed: true }));
            // Let the confirming read through, then ask the host what actually happened: a lost
            // response does not mean the server did not act, so the chip must not guess the old
            // value back. If that read fails too, the failure above stays on screen.
            ref.toggling = false;
            void readState({ switchFailure: note });
          })
          .finally(() => {
            ref.toggling = false;
          });
      }, [sessionId, status.enabled, status.phase, status.supported, controlState, readState]);

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
        ref.toggling = true;

        ref.readId += 1;
        ref.read?.abort();
        ref.read = null;

        requestWatchStop(sessionId)
          .then((payload) => {
            if (!ref.mounted) return;
            setStatus(statusFrom(payload));
          })
          .catch((error) => {
            console.error('[computer-use] could not stop the watch session:', error);
            if (!ref.mounted) return;
            const note = `停止盯屏没有成功：${String(error?.message ?? error)}`;
            // Let the confirming read through, then ask the host what actually happened —
            // same discipline as a failed switch: never guess the old value back.
            ref.toggling = false;
            void readState({ switchFailure: note });
          })
          .finally(() => {
            ref.toggling = false;
          });
      }, [sessionId, status.supported, status.phase, controlState, readState]);


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
      const position = status.enabled ? '已开启' : '已关闭';
      const title = unsupported
        ? `${LABEL}：当前平台不支持。${status.note}`
        : status.phase === 'unmounted'
          ? `${LABEL}：主机半没有加载，所以点击不会有反应（${status.note}）。请完全退出 DSH 再重新打开——桌面端的 profile 只在启动时组合一次；若重启后仍是这个状态，控制台里的 [computer-use] 日志会写出激活失败的原因。`
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
                  ? `${LABEL}${controlSuffix}：屏幕正在被实时采集${watchSourceText === '' ? '' : `（${watchSourceText}）`}。点击停止盯屏——授权保持开启；想关闭授权，停止之后再点一次。`
                  : status.enabled
                    ? `${LABEL}${controlSuffix}：已开启。模型可以截屏、移动鼠标、点击和输入。点击关闭。`
                    : `${LABEL}：已关闭。点击后模型可以在本会话操作这台电脑（截屏、鼠标、键盘、窗口与 UI 自动化）。`;

      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-cu-chip',
          'data-state': dataState,
          'data-control': effectiveControl,
          // Present only while the last switch attempt failed, so the dot can say so even when the
          // position itself is confirmed and the chip is otherwise rendering as on/off.
          'data-warning': switchFailed ? 'switch' : undefined,
          'aria-pressed': status.enabled === true,
          'aria-label': unsupported
            ? `${LABEL}（当前平台不支持）`
            : status.phase === 'unmounted'
              ? `${LABEL}（主机半未加载）`
              : switchFailed
                ? `${LABEL}（切换失败，当前${position}）`
                : watching
                  ? `${LABEL}（盯屏中，点击停止盯屏）`
                  : `${LABEL}${status.enabled ? `（已开启${controlSuffix === '' ? '' : controlSuffix.slice(1, -1)}）` : '（已关闭）'}`,
          title,
          disabled: unsupported || status.phase === 'loading' || status.phase === 'busy' || effectiveControl === 'stopping',
          onClick: watching ? stopWatch : toggle,
        },
        React.createElement(MonitorIcon, { key: 'icon' }),
        React.createElement('span', { className: 'dsh-cu-dot', key: 'dot' }),
      );
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
