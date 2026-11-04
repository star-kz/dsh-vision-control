/**
 * Host half of @k-launcher/dsh-vision-control — the "电脑操作" capability.
 *
 * It owns three things:
 *   1. a lazy singleton PowerShell backend (screenshots, SendInput, UI Automation);
 *   2. the `computer_*` tools the model calls, each gated on a per-Session grant;
 *   3. two small JSON routes the composer chip uses to read and flip that grant.
 *
 * The grant is deliberately per Session and off by default. Handing a model the
 * mouse and keyboard is a bigger step than reading files, so it is something the
 * user turns on for one conversation and can turn off again, which is exactly
 * what the chip in the composer expresses.
 */
import { importHostModule } from './internal/host-packages.mjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PowerShellBackend, ComputerUseBackendError } from './backend/bridge.js';
import { CdpConnection } from './browser/connection.mjs';
import { BrowserSession } from './browser/state.mjs';
import { applyTokenGuard } from './internal/token-guard.mjs';
import { applyAppLaunch } from './internal/app-launch.mjs';
import { applySeeNow } from './see/apply.mjs';
import {
  RELEASE_PATH,
  hashFileOnDisk,
  workerBuildOnDiskAsync,
  buildReadsCount,
  setBuildCacheEnabled,
} from './internal/build-check.mjs';
import {
  PACKAGE_ROOT,
  readPackageManifest,
  summarizeRelease,
  verifyRelease,
} from './internal/release-manifest.mjs';
import { claimInstance, describeInstance, releaseInstance } from './internal/instance-registry.mjs';
import { detectHost } from './internal/preflight.mjs';
import {
  backendMessage,
  decorateFailure,
  withOutcomeNote,
  isIdempotentCall,
  STEP_ACTION_LIST,
} from './internal/failures.mjs';
import {
  CONTROLLER_IDLE_MS,
  movesDesktop,
  claimController,
  noteAction,
  beginWrite,
  finishWrite,
  leaseReport,
} from './internal/lease.mjs';
import { sessionKey, createSessions } from './internal/sessions.mjs';
import { combineSignals, describeCall, createExecutionRegistry } from './internal/execution.mjs';
import { createAuditLog, auditDescribe } from './internal/audit.mjs';
import { resolveFormat, createCaptureService } from './internal/capture.mjs';
import { createRefRegistry } from './internal/refs.mjs';
import {
  SCREENSHOT_VALUE_SCHEMA,
  FRAME_ITEM_PROPERTIES,
  // 内容摘要 memo 与它的上限：`markObservation` 留在入口（它是"这次观察是否重复上次"的记账，
  // 属于会话级逻辑），而 memo 本身按内容寻址，放在契约层。
  observedDigests,
  OBSERVED_DIGEST_LIMIT,
} from './internal/tool-contracts.mjs';
import { createSchemaVisibility } from './internal/schema-visibility.mjs';
import { collectDoctorReport } from './internal/doctor.mjs';
import { applyDegraded } from './internal/degraded.mjs';
import { registerBrowserState } from './tools/browser-state.mjs';
import { registerBrowserActions } from './tools/browser-actions.mjs';
import { registerComputerActions } from './tools/actions.mjs';
import { registerComputerScreenshot } from './tools/screenshot.mjs';
import { registerComputerUi } from './tools/ui.mjs';
import { registerComputerUiAction } from './tools/ui-action.mjs';
import { registerComputerClick } from './tools/click.mjs';
import { registerComputerDrag } from './tools/drag.mjs';
import { registerComputerScroll } from './tools/scroll.mjs';
import { registerComputerType } from './tools/type.mjs';
import { registerComputerKey } from './tools/key.mjs';
import { registerComputerWindows } from './tools/windows.mjs';
import { registerComputerDigest } from './tools/digest.mjs';
import { registerComputerClipboard } from './tools/clipboard.mjs';
import { registerComputerPaste } from './tools/paste.mjs';
import { registerComputerLaunch } from './tools/launch.mjs';
import { registerComputerStop } from './tools/stop.mjs';

/**
 * 宿主自带的 `defineTool`，按**绝对路径**解析后取用。
 *
 * 不能写成静态 `import ... from '@deepseek-ai/dsh-tools'`：`dsh plugin add` 用的是 `link:`，
 * 模块位于解压目录（`D:\DSH-Plugins\...`），Node 会从那里逐级向上找 `node_modules`，永远
 * 找不到应用里那份；整行随之导入失败，宿主本身却一切正常——用户看到的只是"装好了，但输入框
 * 里没有「电脑操作」按钮"，没有任何报错。解析策略见 internal/host-packages.mjs。
 *
 * 失败时**先留一条结构化诊断再抛**（研究报告 P1-A 的短期要求）：此时 `apply()` 还一行都没跑，
 * 宿主日志里只有一句 import 失败；把 stage / code / 尝试过的候选 / 运行时类型打出来，离线也能
 * 定位，而不用靠"再装一遍看看"。
 *
 * 1.40.3 起不再直接抛出：失败会走 `internal/degraded.mjs` 的**降级挂载**——不带任何工具、
 * 不启动 worker，只把 `/computer-use/status` 与 `/computer-use/doctor` 挂成 503 + 结构化
 * 失败原因。"整个 404"与"装好了但没反应"之间，至少要留下一条能读的入口。
 */
let hostTools = null;
let bootstrapError = null;
try {
  hostTools = await importHostModule('@deepseek-ai/dsh-tools');
} catch (error) {
  bootstrapError = error;
  const diagnostic = {
    stage: 'resolve/import',
    specifier: '@deepseek-ai/dsh-tools',
    code: error?.code ?? 'HOST_PACKAGE_IMPORT_FAILED',
    message: String(error?.message ?? error),
    resolution: error?.resolution ?? null,
    executable: process.execPath ?? '',
    electron: process.versions.electron ?? null,
    node: process.versions.node ?? '',
    at: new Date().toISOString(),
  };
  try {
    console.error(`computer-use: BOOTSTRAP_FAILED ${JSON.stringify(diagnostic)}`);
  } catch { /* stderr may be gone; the degraded row below still records it */ }
}
const defineTool = hostTools?.defineTool;

/** Stable Loader identity. */
export const name = 'computer-use';

/**
 * Services this plugin cannot work without.
 *
 * `webServer` is deliberately NOT listed: it exists only to carry the composer
 * chip's state route, and a headless or scripted profile has no chip. Requiring
 * it there would block the tools too, in exactly the deployment where unattended
 * computer control is most useful. The routes register through a scoped
 * `ctx.inject` when a web server is actually present.
 *
 * 降级挂载时 `tools` 不可用（正是它导入失败的），所以这里必须为空：否则 row 会停在
 * PENDING 等一个永远不会出现的服务，连那条只读路由都挂不上。
 */
export const inject = bootstrapError === null ? ['tools'] : [];

/**
 * Plugin version echoed by the status route.
 *
 * Read from package.json rather than written here a second time (8.txt §3): the two
 * copies had already drifted apart once — the package said 1.19.1 while the chip and
 * every diagnostic still reported 1.19.0 — and "which build is this?" is exactly the
 * question a version is for. An unreadable manifest degrades to a version that is
 * obviously not a release rather than to a plausible wrong number.
 */
const VERSION = (() => {
  const manifest = readPackageManifest(PACKAGE_ROOT).manifest;
  return typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0-unversioned';
})();

/**
 * The behaviour contract these two halves speak.
 *
 * Bumped when the arguments or the meaning of a reply changes in a way an older worker
 * would misread. The worker publishes its own number at startup and the host refuses to
 * drive one that answers differently, because the alternative is a model discovering a
 * half-applied upgrade three actions into a task.
 */
const WORKER_PROTOCOL = 2;

/**
 * The worker capabilities this host cannot do its job without.
 *
 * Every name here is something this work added to the worker's own behaviour, and the host
 * reports or acts on each one: without it the reply would be read as if it meant something else
 * (a read with no `traversal`, a batch with no `progress`). §13.7 asks that host and worker roll
 * back as a set; this list is how a half-applied rollback is refused instead of tolerated.
 */
const REQUIRED_WORKER_CAPABILITIES = ['reply.traversal', 'reply.pushdown', 'input.partial', 'deadline.enforced', 'release.independent'];

/** Route prefix owned by this plugin. */
const ROUTE = '/computer-use';

/** Chip label, kept in one place because the host reports it to the client. */
const LABEL = '电脑操作';

/**
 * Whether this build can actually drive the desktop.
 *
 * The backend is SendInput + GDI + UI Automation, so it is Windows-only. On any
 * other platform the plugin still loads (it is a normal profile row) but must
 * report itself unavailable and refuse every call, rather than offering tools
 * that fail at execution time with a confusing internal error. This mirrors the
 * "not-applicable / below-minimum / supported" three-state capability gate that
 * the reference design uses: an unsupported platform is a state the chip shows,
 * not a surprise the model discovers.
 */
const SUPPORTED = process.platform === 'win32';

/** Why the capability is unavailable, phrased for both the chip and the model. */
const UNSUPPORTED_REASON = `电脑操作目前只实现了 Windows（SendInput + GDI + UI Automation），当前平台是 ${process.platform}。`;

/** How the model is told to obtain the grant. */
const GRANT_HINT = '若要使用电脑操作，请让用户在输入框工具栏点击「电脑操作」开启该能力，然后重试。';

/**
 * Why a subagent can never drive the desktop, however the deployment is configured.
 *
 * Delegated subagents run with the scope they were started with; a capability that
 * moves the mouse and keyboard is exactly the kind of thing that must not be
 * reachable by widening a scope from the inside. The message tells the child what to
 * do instead — hand the step back to the parent — rather than just denying it.
 */
const SUBAGENT_REFUSAL = '电脑操作不对子代理开放：子代理的权限范围在启动时就固定了，不能从会话内部放宽。请把需要操作电脑的这一步交回主代理执行。';

/** Cap on a JSON request body accepted from the chip. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 削-4：from_frame 回执的 frame 子 schema——曾在 computer_click / computer_drag /
 * computer_scroll 三处逐字拷贝（grep `attached-ignored` ×3 实证），抽成共享常量消灭漂移源。
 * 语义变更只许改这里。
 */
const FRAME_RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    fromImage: { type: 'object', additionalProperties: false, required: true, properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } } },
    projected: { type: 'object', additionalProperties: false, required: true, properties: { x: { type: 'integer', required: true }, y: { type: 'integer', required: true } } },
    scale: { type: 'number', required: true },
    source: { type: 'string', required: true },
    drift: { type: 'integer' },
    note: { type: 'string' },
    mapping: { type: 'string', description: "Which transform projected this point: 'encoded-1:1' when the delivered image is the encoded one, 'attached-rescaled(...)' when the host resized it on the way to the model, or 'attached-ignored(...)' when the reported size could not be a rescale of this capture." },
    guard: { type: 'string', description: "Why the point was allowed: 'root' (the target window, or a child of it), 'owned-by-target' (a dialog or popup menu that belongs to the target), 'allowed-transition' (a window this call named in allow_windows), 'uia-agrees' (the accessibility element under the point belongs to the target window although WindowFromPoint named something else), 'unavailable' (nothing could be read under the point, so it was not verified) or 'no-target' (a screen frame names no window). A point covered by a different window of the *same process* is not in this list — it is refused as [TARGET_OCCLUDED], because a shared pid does not make it the same window." },
    recovered: { type: 'boolean', description: 'True when the target window had to be brought forward once for this point to be legal — set only when allow_activate was asked for and the guard had seen another process under the point.' },
  },
};

/**
 * HOST-SPEC-2: 宿主校验返回值必须是无损 JSON——递归拷贝，把 undefined 一律落成 null
 * （与 see/apply.mjs:34-44 那份同形，index.js 自留一份，避免跨目录导入）。
 * @param value - 任意后端回执。
 * @returns 无 undefined 的纯 JSON 值。
 */
function toLosslessJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toLosslessJson(v);
  return out;
}

/**
 * Human-readable message for a backend failure, with the two cases the model can
 * actually act on called out.
 * @param error - the thrown value.
 * @returns model-facing text.
 */

/**
 * A `/computer-use/state` request rejected by the admission fence, carrying the
 * HTTP status the route should answer with.
 */
class StateRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * `/computer-use/state` 授权面三件套的前两件（优-P0-01；第三件"会话归属"在路由里，
 * 因为要问 `ctx.agents`）：
 *
 *   1. 自定义头 `X-DSH-Computer-Use: 1`——跨站 simple request 发不出自定义头，
 *      预检又不会命中这条 exact 路由，CSRF 在这一层直接卡死；
 *   2. `Sec-Fetch-Site` 非 cross-site，且 `Origin` 在带的时候必须与 `Host` 同 authority
 *      （与宿主 /api 面 `isTrustedApiRequest` 同一判定模型；宿主有防护则零成本双保险，
 *      无防护则这是唯一防线）。
 *
 * @param req - the incoming request.
 * @returns null when admitted, otherwise the StateRequestError to answer with.
 */
function admitStateRequest(req) {
  if (req.headers?.['x-dsh-computer-use'] !== '1') {
    return new StateRequestError(403, 'missing X-DSH-Computer-Use header');
  }
  if (req.headers?.['sec-fetch-site'] === 'cross-site') {
    return new StateRequestError(403, 'cross-site requests are not admitted');
  }
  const origin = req.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return new StateRequestError(403, 'unparseable Origin header');
    }
    if ((originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') || originUrl.host !== req.headers?.host) {
      return new StateRequestError(403, 'Origin does not match this host');
    }
  }
  return null;
}

/**
 * Read and parse a bounded JSON body.
 * @param req - the incoming request stream.
 * @returns the parsed object, or an empty object for an empty body.
 */
async function readJsonBody(req) {
  // Content-Type 闸：没有这个闸，一个 text/plain 的 CORS simple request 可以不经预检直达
  // 端点被当 JSON 裸解析（优-P0-01）。只认 application/json（允许带 charset 等参数）。
  const contentType = req.headers?.['content-type'];
  if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('application/json')) {
    throw new StateRequestError(415, 'content-type must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new StateRequestError(413, 'request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

/**
 * Send one JSON response.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}


/**
 * Host half entry point.
 * @param ctx - the plugin context carrying `tools` and `webServer`.
 * @param config - deployment configuration for this plugin row.
 */
export function apply(ctx, config = {}) {
  // 降级挂载：宿主依赖没导入成功时，只挂两条只读路由，不注册工具、不启动 worker。
  if (bootstrapError !== null) {
    applyDegraded(ctx, config, bootstrapError);
    return;
  }

  /**
   * §A: one owner per host.
   *
   * Every `apply()` used to create its own grant table, visibility manager, backend state and
   * the same fixed `/computer-use/*` routes. A second mount therefore failed on the duplicate
   * status route — after it had already registered tools — and the preset that carried it
   * broke. The claim below happens **before** any of that. It is keyed on `ctx.root` (or a
   * per-context fallback for test contexts), so two module copies in one host see the same
   * registry while two independent hosts in one process stay isolated.
   */
  const claim = claimInstance({
    ctx,
    packageName: '@k-launcher/dsh-vision-control',
    version: VERSION,
    root: PACKAGE_ROOT,
  });
  if (!claim.ok) {
    const existing = claim.existing;
    ctx?.logger?.error?.(
      `computer-use: DUPLICATE_INSTANCE — ${existing.packageName}@${existing.version} is already mounted from ${existing.root}; this copy ${VERSION}@${PACKAGE_ROOT} was not mounted. Remove the duplicate bundle/preset row; the first instance keeps its tools and routes.`,
    );
    return;
  }
  /** This instance's slot in the host-wide registry. */
  const instance = claim.record;
  const releaseOwnership = () => releaseInstance(claim.registry, instance);
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => releaseOwnership, 'computer-use: single-instance ownership');
    } catch (error) {
      // A host without a working effect surface cannot tell us when to release. The record
      // would then outlive the plugin; say so rather than pretending the claim is durable.
      ctx?.logger?.warn?.(`computer-use: could not register instance ownership (${String(error)}); duplicate-mount detection may report a stale owner until restart`);
    }
  } else if (typeof ctx?.on === 'function') {
    ctx.on('dispose', releaseOwnership);
  }

  /**
   * §G: the whole release identity, not just worker.ps1.
   *
   * Computed once per apply. A shipped `release-manifest.json` is compared with the files on
   * disk; a source checkout without one still reports its computed id so "which build is this?"
   * has an answer. A mismatch is logged loudly here and reported as a fatal finding by doctor.
   */
  const release = verifyRelease(PACKAGE_ROOT, { version: VERSION });
  const host = detectHost();
  if (release.present && !release.matches) {
    ctx?.logger?.error?.(
      `computer-use: RELEASE_BUILD_MISMATCH — installed files do not match ${release.manifestPath} (computed ${release.buildId}, manifest ${release.manifest?.releaseBuildId ?? '?'}). This is a half-applied upgrade; reinstall the whole package and restart. Details: ${JSON.stringify(release.checks ?? {})}`,
    );
  }
  const defaultEnabled = config.defaultEnabled === true;
  const shotRoot = typeof config.shotDir === 'string' && config.shotDir.trim() !== ''
    ? config.shotDir
    : join(tmpdir(), 'dsh-computer-use');
  const actionTimeoutMs = Number.isFinite(config.actionTimeoutMs) ? config.actionTimeoutMs : 20_000;
  // 优-P1-01：30s → 60s——实测冷启动分布 5.5-63s，30s 会撞出"假超时"。
  const startTimeoutMs = Number.isFinite(config.startTimeoutMs) ? config.startTimeoutMs : 60_000;
  // §13.6: the read optimisation has a controlled off switch, so a regression can be attributed
  // rather than guessed at. Turning it on changes only whether the digest is remembered.
  setBuildCacheEnabled(config.verifyWorkerBuildEveryCall !== true);
  /**
   * This plugin instance's own directory and identity (§6 ⑧).
   *
   * The cancel and held-input markers used to be named after the *process id* alone, so two
   * plugin instances in one process -- two scopes in a test run, two mounts in one host -- wrote
   * to the same file: a cancel meant for one worker cancelled the other, and a force-kill could
   * release input recorded by a different worker. The identity is per instance and random, and
   * every marker lives under it, so instances cannot reach into each other.
   */
  const instanceId = randomBytes(6).toString('hex');
  const instanceRoot = join(shotRoot, `instance-${instanceId}`);
  const markerPath = (name) => join(instanceRoot, `${name}-${process.pid}.flag`);
  // The markers are written by the bridge on its cancel path, which is best effort and does not
  // create directories: the instance's own directory has to exist first, or a cancel would be a
  // silent no-op. Failure here is not fatal — the timeout path still stops the worker — so it is
  // reported rather than thrown.
  try {
    mkdirSync(instanceRoot, { recursive: true });
  } catch (error) {
    ctx?.logger?.warn?.(`computer-use: could not create the instance directory ${instanceRoot} (${String(error?.message ?? error)}); cancel markers will be best effort`);
  }

  // token-guard 原本是独立插件（@local/dsh-token-guard），现并入本插件：它压的是工具返回的文本
  // （默认只压 `pwsh`），与"电脑操作"是两件事，所以**不**受会话开关约束，只有自己的开关
  // （config.tokenGuard.enabled，默认 true）。挂不上也不能影响插件本体，因此整段包在 try 里。
  if (typeof ctx.on === 'function') {
    try {
      applyTokenGuard(ctx, config?.tokenGuard ?? {});
    } catch (error) {
      ctx.logger?.warn?.(`computer-use: token-guard could not mount (${String(error)})`);
    }
  }

  // 注意：app-launch 的挂载放在下面 `defineTracedTool` 定义之后 —— 那里要用它包一层，
  // 让这两个工具与其它工具一样出现在 trace 里。

  /** 会话登记与授权：见 internal/sessions.mjs（§10 宿主半边拆分）。 */
  const sessions = createSessions({ defaultEnabled });
  // `sessionKey` 是模块级导出（归一化不属于某个实例），授权查询才在实例上。
  const { isEnabled } = sessions;

  let backend = null;
  /** When the worker was last replaced because it was serving the legacy accessibility bridge. */
  let lastLegacyRestartMs = 0;


  /**
   * 会话的 schema 可见性：能力关着时把这一族的 schema 从该会话的视野里摘掉（§9 表那行 /
   * 见 internal/schema-visibility.mjs）。
   */
  const visibility = createSchemaVisibility({
    enabled: config.hideToolSchemasWhenOff !== false,
    isEnabled,
    logger: ctx.logger,
    onSessionDisposed: (sessionId) => {
      disposeBrowserSessionsFor(sessionId);
      // 新-P1-04：会话销毁是审计生命周期的最后一个合账点。
      void audit.close(sessionKey(sessionId), { event: 'disposed' });
      // 会话收尾：这次任务抓过的图与派生帧一起删（只删本插件自己产出的，`save_path` 存的动不了）。
      // 排在会话真正释放之后，所以此刻不会再有人来读这些文件。
      void releaseSessionCaptures(sessionId);
    },
  });
  if (visibility.enabled && typeof ctx.on !== 'function') {
    // 没有事件面的组合观察不到 agent；这时工具保持"可见但被拒"，而不是悄悄丢掉能力。
    ctx.logger?.warn?.('computer-use: ctx.on is unavailable; tool schemas stay advertised for every session');
  }
  if (visibility.enabled && typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => visibility.remember(agent));
    ctx.on('agent/disposed', ({ agent }) => visibility.forget(agent));
    ctx.effect(() => () => visibility.releaseAll(), 'computer-use: tool-schema visibility');
  }

  /** 执行协调（在飞登记 / 停止状态 / 浏览器通道的会话上下文）：见 internal/execution.mjs。 */
  const execution = createExecutionRegistry();
  /**
   * 动作审计 JSONL（新-P1-04）：默认开在 shotRoot/audit（持久于实例目录之外——instanceRoot
   * 在卸载时会被整个删掉，审计不能跟着陪葬）；`config.auditDir` 改目录，`config.auditLog === false`
   * 全关。字段纪律（内容只存长度）与生命周期绑定点见 internal/audit.mjs。
   */
  const audit = config.auditLog === false
    ? { record() {}, close() { return Promise.resolve(); }, closeAll() { return Promise.resolve(); } }
    : createAuditLog({
      dir: typeof config.auditDir === 'string' && config.auditDir.trim() !== '' ? config.auditDir : join(shotRoot, 'audit'),
      logger: ctx.logger,
    });
  /** 截图服务（规范化 / 命名 / 去重入库 / 信封）：见 internal/capture.mjs。 */
  const captureService = createCaptureService({ sessionKey });

  /**
   * worker 抓关联帧时，若请求里没带落盘基名，它会退回系统临时目录。那些文件不在截图目录下，登记表
   * 也管不到它们，所以按前缀扫一次临时目录。
   *
   * 只删本插件的帧（前缀是插件专有的），并且只删**已经过时**的那些 —— 正在进行的抓取可能刚好写了
   * 一帧还没回传，按时间把它排除掉。
   */
  async function releaseStrayFrames({ olderThanMs = 15 * 60 * 1000 } = {}) {
    try {
      const { readdir, stat, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const dir = tmpdir();
      const cutoff = Date.now() - olderThanMs;
      const entries = await readdir(dir).catch(() => []);
      await Promise.all(entries
        .filter((name) => name.startsWith('dsh-frame-'))
        .map(async (name) => {
          const full = join(dir, name);
          try {
            const info = await stat(full);
            if (info.mtimeMs >= cutoff) return; // 可能正被用着
            await rm(full, { force: true });
          } catch {
            /* best effort */
          }
        }));
    } catch {
      /* best effort */
    }
  }

  /**
   * 会话收尾：删掉这次任务产出的图与派生帧。失败不抛 —— 收尾本身不该成为新的失败来源。
   */
  async function releaseSessionCaptures(sessionId) {
    try {
      await captureService.releaseSession(sessionId);
      await releaseStrayFrames();
    } catch (error) {
      ctx.logger?.warn?.(`computer-use: capture cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /** 引用注册表（哪个会话被展示过哪次观察/哪一帧）：见 internal/refs.mjs。 */
  const refs = createRefRegistry({ sessionKey, generationOf: () => backend?.info?.generation });

  /**
   * What the desktop control is doing for one session.
   *
   * The states are deliberately separate, because they call for different user
   * reactions: 未开启 (never turned on), 仅观察 (allowed, nothing driven yet), 可操作
   * (this session holds the desktop), 执行中 (a call is in flight), 停止中 (a revoke is
   * draining), 已停止 (the user turned it off).
   * @param sessionId - the Session the chip is mounted in.
   * @returns the control block the chip renders.
   */
  function controlState(sessionId) {
    const key = sessionKey(sessionId);
    const enabled = SUPPORTED && isEnabled(sessionId);
    const busy = execution.count(sessionId) > 0;
    const leaseState = leaseReport(key);
    let state = 'off';
    if (execution.isStopping(key)) state = 'stopping';
    else if (!enabled) state = sessions.hasExplicit(key) ? 'stopped' : 'off';
    else if (busy) state = 'busy';
    else if (leaseState.owns && leaseState.idleMs !== null && leaseState.idleMs < CONTROLLER_IDLE_MS) state = 'ready';
    else state = 'observing';
    return {
      state,
      enabled,
      inFlight: execution.count(sessionId),
      // Whether this session currently pays for the computer_* schemas. The chip
      // shows it, and the paired test reads it instead of guessing.
      toolSchemas: visibility.toolSchemaState(key),
      lease: leaseState.lease,
      lastAction: leaseState.lastAction,
    };
  }

  /**
   * 优-P1-01：启动超时的**一次**退避重试。
   *
   * bridge 的 START_TIMEOUT 分支已经做了 teardown（stopChild + 状态回 idle），所以再次
   * `start()` 起的是一个全新进程——"继续等同一个可能已僵死的进程"被明确撤回（违反
   * fail-closed）。第二次仍失败才报 HELPER_UNAVAILABLE（消息含 "backend"，FAILURE_RULES
   * 的兜底规则会把它分类为 HELPER_UNAVAILABLE / retry:'retry'）。
   */
  const START_RETRY_BACKOFF_MS = 2_000;

  /**
   * Start one backend, retrying a start timeout exactly once after a backoff.
   * @param instance - the backend to start.
   */
  async function startWithRetry(instance) {
    try {
      await instance.start();
    } catch (first) {
      if (String(first?.code) !== 'START_TIMEOUT') throw first;
      ctx.logger?.warn?.('computer-use: worker start timed out after %d ms; retrying once in %d ms', startTimeoutMs, START_RETRY_BACKOFF_MS);
      await new Promise((resolve) => setTimeout(resolve, START_RETRY_BACKOFF_MS));
      try {
        await instance.start();
      } catch (second) {
        throw new ComputerUseBackendError(
          `the computer-use backend could not be started after two attempts (start timeout ${startTimeoutMs} ms, one retry after ${START_RETRY_BACKOFF_MS} ms): ${second instanceof Error ? second.message : String(second)}`,
          'HELPER_UNAVAILABLE',
        );
      }
    }
  }

  /**
   * Lazily create the backend and wait for it to answer.
   * @returns the started backend.
   */
  async function ensureBackend() {
    if (!SUPPORTED) throw new ComputerUseBackendError(UNSUPPORTED_REASON, 'UNSUPPORTED_PLATFORM');
    if (backend === null) {
      backend = new PowerShellBackend({
        timeoutMs: Math.max(actionTimeoutMs, startTimeoutMs),
        startTimeoutMs,
        cancelFilePath: markerPath('cancel-main'),
      });
    }
    await startWithRetry(backend);
    return backend;
  }

  /**
   * Replace the worker process.
   *
   * The reason this exists: the UI Automation *core* inside the worker can end up serving the
   * MSAA-to-UIA bridge for a process instead of that process's own provider, and it then stays
   * that way -- every control comes back as a generic `Pane` with a numeric automation id, the
   * real control types and ids are gone. Re-creating the client object inside the same process
   * does not clear it (verified), while a freshly started worker reads the same window natively
   * (also verified), so the process is what has to go. Refs from before the restart are refused
   * by generation, which is the documented behaviour and the honest one.
   * @returns the started replacement.
   */
  async function restartBackend() {
    const previous = backend;
    backend = null;
    try {
      previous?.dispose();
    } catch {
      /* best effort: the replacement is what matters */
    }
    return await ensureBackend();
  }

  /**
   * Check that the worker implements the same action set this half declares.
   *
   * The two halves ship together but run as separate processes, so a half-applied
   * upgrade is possible. Without this check the failure it produces is the worst kind: a
   * documented action that the schema accepts and the dispatcher rejects, discovered by
   * the model three actions into a task. The worker publishes its list at startup, so the
   * mismatch is reported once, before anything is dispatched.
   * @param instance - the started backend.
   */
  function assertActionContract(instance) {
    const reported = instance.info?.actions;
    if (!Array.isArray(reported)) return; // an older worker publishes no list: nothing to compare
    if (reported.map(String).join(',') === STEP_ACTION_LIST.join(',')) return;
    throw new Error(`[BAD_REQUEST] the computer-use backend worker implements a different action set than this plugin declares (worker: ${reported.join(', ')}). Restart the desktop app so both halves come from the same install.`);
  }

  /**
   * Check that the running worker is the one this half was built to talk to.
   *
   * Three questions, all asked before the first call is dispatched, because each of them
   * otherwise surfaces as a mystery refusal three actions into a task:
   *
   *   actions    does it implement the same step actions (the original check)?
   *   protocol   does it speak the same behaviour contract? A worker that answers with an
   *              older meaning is refused rather than driven with arguments it will misread.
   *   build      is the process running the worker.ps1 that is on disk now? A file replaced
   *              after the worker started is a half-applied upgrade, and the two halves would
   *              then disagree about behaviour with nothing in the conversation to explain it.
   *
   * A worker that publishes none of this is an older build: it is left to the action check
   * (which it also fails to publish), exactly as before.
   * @param instance - the started backend.
   */
  async function assertWorkerContract(instance) {
    assertActionContract(instance);
    const protocol = Number(instance.info?.protocol);
    if (Number.isFinite(protocol) && protocol !== WORKER_PROTOCOL) {
      throw new Error(`[PROTOCOL_MISMATCH] the computer-use worker speaks protocol ${protocol} and this plugin speaks ${WORKER_PROTOCOL}, so they were not shipped together. The worker may be an older or newer copy than index.js — restart the desktop app (or reinstall the plugin) so both halves come from the same install.`);
    }
    // §13.7: host and worker roll back **as a set**, and this is what makes that checkable.
    // Matching build hashes only prove "the running process matches the file on disk" — a new
    // host with a 1.39.1 worker satisfies that and then disagrees with it about every reply it
    // reads. The capabilities this host relies on are therefore required by name.
    //
    // A worker that publishes *no* list at all is a different case: it is a minimal worker (the
    // fixtures the test suite uses, or an install from before the list existed), and the action
    // contract below still applies to it. The 1.39.1 worker does publish a list — it just does
    // not contain these — so the rollback this check exists for is still refused.
    const published = Array.isArray(instance.info?.capabilities) ? instance.info.capabilities.map(String) : [];
    if (published.length > 0) {
      const missing = REQUIRED_WORKER_CAPABILITIES.filter((one) => !published.includes(one));
      if (missing.length > 0) {
        throw new Error(`[PROTOCOL_MISMATCH] this host needs worker capabilities that the running computer-use worker does not have: ${missing.join(', ')} (the worker publishes ${published.length} capabilities, and these are not among them). That is a half-applied upgrade or rollback — index.js and backend/worker.ps1 are not from the same install — so the two halves would disagree about what a reply means. Restore both together (or reinstall the plugin) and restart the desktop app.`);
      }
    }
    const reported = typeof instance.info?.build === 'string' ? instance.info.build : '';
    // §7.2: the digest is read asynchronously and reused while the file's identity is
    // unchanged, so the hot path no longer pays a synchronous 606 KB read per call — and a
    // file that really changed still produces a mismatch here.
    const onDisk = await workerBuildOnDiskAsync();
    if (reported !== '' && onDisk !== '' && reported !== onDisk) {
      throw new Error(`[PROTOCOL_MISMATCH] the running computer-use worker was started from a different build of worker.ps1 than the one on disk now (worker ${reported}, disk ${onDisk}). That is a half-applied upgrade: the file changed after the worker started. Restart the desktop app so both halves load from the same file.`);
    }
    // §13.5: the code that actually runs is worker.ps1 *and* the release script the host runs
    // when it force-kills the worker, so both are covered by the build check.
    const releaseReported = typeof instance.info?.releaseBuild === 'string' ? instance.info.releaseBuild : '';
    const releaseOnDisk = await hashFileOnDisk(RELEASE_PATH);
    if (releaseReported !== '' && releaseOnDisk !== '' && releaseReported !== releaseOnDisk) {
      throw new Error(`[PROTOCOL_MISMATCH] the running computer-use worker was started from a different build of release-input.ps1 than the one on disk now (worker ${releaseReported}, disk ${releaseOnDisk}). That is a half-applied upgrade — and this is the script that releases held input when a worker is killed, so a mismatch here could press the wrong keys. Restart the desktop app so both halves load from the same files.`);
    }
    // The environment half of the capability model: the DPI awareness this process actually got.
    // A process that is not per-monitor aware has its screen coordinates virtualized, which
    // changes what every capture and every click means -- worth knowing once, per worker.
    const awareness = String(instance.info?.dpiActual ?? instance.info?.dpi ?? '');
    if (awareness !== '') {
      noteCapability('env', 0, awareness.includes('per-monitor') ? 'available' : 'degraded', `dpi awareness: ${awareness}`);
    }
  }

  /**
   * Start the worker in the background so the first real action is not the one
   * paying for `Add-Type`. Spawning it costs ~0.7 s once per host process; the
   * model should never be the one waiting for it.
   */
  function warmBackend() {
    if (!SUPPORTED) return;
    void ensureBackend().catch(() => {
      // Swallowed on purpose: the first real call re-runs this path and reports the
      // failure with the context the model needs to act on it.
    });
  }

  /**
   * Whether the calling agent is a delegated subagent.
   *
   * A subagent session carries `header.origin === 'subagent'` and a `parentSession`;
   * its permission scope is fixed when it is started and cannot be widened from
   * inside. The per-session grant alone would leak the capability into every child
   * as soon as a deployment sets `defaultEnabled: true`, so this is checked
   * separately — and it is then checked a second time on the runtime path, because a
   * policy layer that can be bypassed is not a policy.
   * @param exec - the tool execution carrying the calling agent.
   * @returns whether the caller is a subagent.
   */
  function isSubagent(exec) {
    const header = exec?.agent?.session?.header;
    return header?.origin === 'subagent';
  }

  /**
   * Refuse when the calling Session has not been granted computer control.
   *
   * Every entry point runs this before it validates its own arguments, so a
   * disabled capability reports the same actionable message no matter what the
   * model passed.
   * @param exec - the tool execution carrying the calling agent.
   */
  function requireGrant(exec) {
    if (!SUPPORTED) {
      throw new Error(`[UNSUPPORTED_PLATFORM] ${UNSUPPORTED_REASON}`);
    }
    if (isSubagent(exec)) {
      throw new Error(`[SUBAGENT_COMPUTER_USE_UNAVAILABLE] ${SUBAGENT_REFUSAL}`);
    }
    const sessionId = exec?.agent?.session?.id;
    if (!isEnabled(sessionId)) {
      // Converge here as well: a session whose agent was created before this
      // plugin's listener (or whose grant changed elsewhere) still stops paying
      // for schemas it may not use.
      visibility.sync(exec?.agent);
      throw new Error(`[NOT_AUTHORIZED] 电脑操作尚未在本会话开启。${GRANT_HINT}`);
    }
  }

  /* ------------------------------------------- V01: the task-level trace ----- */

  /**
   * One record per tool call, kept in this process.
   *
   * The plan asks for a trace whose stages can be related to each other (V01) and for the
   * five numbers a fixed task set produces: tool calls, inputs that reached the wrong target
   * versus inputs a guard stopped, how much observation cost, how each wait ended, and how
   * often a call had to recover. None of them can be reconstructed after the fact from the
   * conversation, because the conversation keeps only what the tools returned — and a tool
   * that returned nothing is exactly the case worth counting.
   *
   * Deliberately *not* here: model round trips and wall-clock task time. Those belong to the
   * host, which is the only half that can see them; guessing them here would produce numbers
   * that look authoritative and are wrong.
   */
  const TRACE_LIMIT = 100;
  const trace = [];
  let spanSeq = 0;
  const metrics = {
    toolCalls: 0,
    refusals: 0,
    /** Inputs a guard stopped *before* they were sent (方案 §9.1: counted apart from delivered ones). */
    guardInterceptions: 0,
    /** 优-P1-09：守卫 fail-open 放行（落点下什么也读不到、于是**没有验证**就放过去）的次数。
     *  "没动却显示成功"这一类静默失效此前完全无账——它不进失败计数、不进拦截计数。 */
    guardUnavailable: 0,
    screenshots: 0,
    screenshotPixels: 0,
    screenshotBytes: 0,
    /** UIA reads: how many, how many nodes they walked, how long they took (§9.1 observationCost). */
    uiReads: 0,
    uiNodes: 0,
    uiReadMs: 0,
    waitOutcomes: { satisfied: 0, timeout: 0, unavailable: 0 },
    readRetries: 0,
    /** 优-P1-16：交付给模型的图像 token 估算累计（估算口径见 IMAGE_PIXELS_PER_TOKEN）。 */
    imageTokensEstimated: 0,
  };

  /**
   * 优-P1-16 图像 token 估算口径：1650 像素/token。锚点是 computer_watch 自己文档化的
   * 三个档位——800×450(36.0万像素)→218、1280×720(92.2万)→559、1600×900(144万)→872，
   * 三点共线（1650-1651 px/token）。这是一把**稳定的尺子**而不是真值：对账要的是
   * 口径可复核、相对变化可信。
   */
  const IMAGE_PIXELS_PER_TOKEN = 1650;

  /**
   * 优-P1-16 schema 税估算口径：注册成功的工具描述符的 JSON 字符数累计（函数属性不参与
   * 序列化，剩下的 name/description/parameters/output 正是随每个请求发出去的那部分），
   * token 估算 = chars/4。地面真值是 schema-visibility.mjs 文件头实测的 15,054/20,990——
   * 这个估算跟踪它，不取代它。
   */
  let schemaTaxChars = 0;

  /** A short, safe summary of a call's arguments: hwnds and sizes, never text bodies. */
  function summariseArgs(args) {
    const out = {};
    if (args === null || typeof args !== 'object') return out;
    if (Number.isFinite(Number(args.hwnd)) && Number(args.hwnd) !== 0) out.hwnd = Number(args.hwnd);
    if (Number.isFinite(Number(args.window)) && Number(args.window) !== 0) out.window = Number(args.window);
    if (typeof args.action === 'string') out.action = args.action;
    if (Array.isArray(args.steps)) out.steps = args.steps.length;
    if (args.region !== null && args.region !== undefined) out.region = true;
    if (args.screenshot === true) out.screenshot = true;
    if (typeof args.text === 'string') out.textChars = args.text.length;
    if (Array.isArray(args.expected_transitions)) out.expectedTransitions = args.expected_transitions.length;
    return out;
  }

  function beginSpan(tool, args, exec) {
    spanSeq += 1;
    metrics.toolCalls += 1;
    return {
      span: spanSeq,
      tool,
      at: Date.now(),
      ok: true,
      args: summariseArgs(args),
      // Which conversation made this call: a capability observed in one conversation is not
      // automatically a fact about another one sharing the same worker (§5.3).
      session: sessionKey(exec?.agent?.session?.id),
    };
  }

  function pushSpan(record) {
    trace.push(record);
    while (trace.length > TRACE_LIMIT) trace.shift();
  }

  function endSpan(record, value) {
    record.ms = Math.max(0, Date.now() - record.at);
    const timing = value?.timing;
    if (timing !== null && timing !== undefined && typeof timing === 'object') {
      for (const key of ['queueMs', 'captureMs', 'admitMs', 'workerMs', 'backendMs']) {
        if (Number.isFinite(Number(timing[key]))) record[key] = Number(timing[key]);
      }
    }
    const shot = value?.shot ?? (value?.imageWidth === undefined ? undefined : value);
    if (shot !== undefined && shot !== null && Number.isFinite(Number(shot.imageWidth))) {
      metrics.screenshots += 1;
      const pixels = Number(shot.imageWidth) * Number(shot.imageHeight);
      metrics.screenshotPixels += pixels;
      metrics.screenshotBytes += Number(shot.bytes ?? 0);
      // 优-P1-16：图像 token 估算（口径见 IMAGE_PIXELS_PER_TOKEN）。
      metrics.imageTokensEstimated += Math.round(pixels / IMAGE_PIXELS_PER_TOKEN);
      record.image = `${Number(shot.imageWidth)}x${Number(shot.imageHeight)}`;
    }
    // The other half of observation cost: a read that walks a thousand nodes and one that walks
    // five look identical in a screenshot count, and it is the tree walk that decides whether a
    // task is spending its budget on looking (§9.1).
    const walked = Number(value?.walked);
    if (Number.isFinite(walked)) {
      metrics.uiReads += 1;
      metrics.uiNodes += walked;
      metrics.uiReadMs += record.ms;
      record.uiNodes = walked;
    }
    for (const report of Array.isArray(value?.waits) ? value.waits : []) {
      const status = String(report?.status ?? '');
      const outcome = String(report?.outcome ?? '');
      const bucket = report?.satisfied === true ? 'satisfied' : (outcome === 'unavailable' || status === 'unknown') ? 'unavailable' : 'timeout';
      metrics.waitOutcomes[bucket] += 1;
      record.waits = Number(record.waits ?? 0) + 1;
    }
    if (typeof value?.outcome === 'string') record.outcome = value.outcome;
    if (typeof value?.frame === 'string') record.frame = value.frame;
    if (typeof value?.resolvedVia === 'string') record.resolvedVia = value.resolvedVia;
    // The application a call turned out to be about, so a later failure that only has a
    // handle to go on can still be filed under the right window profile.
    const processName = value?.window?.process ?? value?.shot?.window?.process;
    if (typeof processName === 'string' && processName !== '') record.app = processName;
    const windowHwnd = Number(value?.window?.hwnd ?? value?.shot?.window?.hwnd ?? 0);
    if (windowHwnd !== 0) record.args.hwnd = windowHwnd;
    noteCapabilityFromValue(record, value);
    noteCapabilityFromCapture(record, value);
    // §2's node and character accounting. A bounded read reports what it collected and what it
    // returned, and the two differ exactly when the budget did something — so both are recorded,
    // not just the size of the answer. `nodes` (a browser read) is the same idea with an array.
    const collectedNodes = Number(value?.collected);
    const returnedNodes = Number.isFinite(Number(value?.returned))
      ? Number(value.returned)
      : (Array.isArray(value?.nodes) ? value.nodes.length : Number.NaN);
    const returnedChars = Number.isFinite(Number(value?.returnedChars))
      ? Number(value.returnedChars)
      : (typeof value?.text === 'string' ? value.text.length : Number.NaN);
    if (Number.isFinite(collectedNodes)) {
      record.collectedNodes = collectedNodes;
      metrics.collectedNodes = Number(metrics.collectedNodes ?? 0) + collectedNodes;
    }
    if (Number.isFinite(returnedNodes)) {
      record.returnedNodes = returnedNodes;
      metrics.returnedNodes = Number(metrics.returnedNodes ?? 0) + returnedNodes;
    }
    if (Number.isFinite(returnedChars)) {
      record.returnedChars = returnedChars;
      metrics.returnedChars = Number(metrics.returnedChars ?? 0) + returnedChars;
    }
    // One call is one round trip through the model's turn, whatever it did.
    metrics.modelRoundTrips = Number(metrics.modelRoundTrips ?? 0) + 1;
    noteCapabilityFromWaits(record, value);
    pushSpan(record);
    return value;
  }

  function failSpan(record, error) {
    record.ms = Math.max(0, Date.now() - record.at);
    record.ok = false;
    const message = error instanceof Error ? error.message : String(error);
    record.error = message.slice(0, 200);
    if (error?.code !== undefined && error.code !== null) record.code = String(error.code);
    if (error?.dispatched === true) record.dispatched = true;
    metrics.refusals += 1;
    metrics.modelRoundTrips = Number(metrics.modelRoundTrips ?? 0) + 1;
    // "It may or may not have reached the desktop" is the outcome that costs the most to get
    // wrong (§13), so it is counted on its own rather than folded into the refusal total.
    if (message.includes('[UNKNOWN_OUTCOME]')) metrics.unknownOutcomes = Number(metrics.unknownOutcomes ?? 0) + 1;
    if (message.includes('[TARGET_OCCLUDED]')) metrics.guardInterceptions += 1;
    noteCapabilityFromFailure(record, message);
    pushSpan(record);
  }

  /** Wrap a tool definition so every call lands in the trace, whatever it returns or throws. */
  function withTrace(definition) {
    const original = definition.execute;
    return {
      ...definition,
      async execute(args, exec) {
        const record = beginSpan(definition.name, args, exec);
        try {
          const value = await original.call(this, args, exec);
          return endSpan(record, value);
        } catch (error) {
          failSpan(record, error);
          throw error;
        }
      },
    };
  }

  const defineTracedTool = (definition) => defineTool(withTrace(definition));

  /**
   * 这一个插件实例里，被宿主拒绝过的工具描述符。
   *
   * 存在的理由就是本文件开头那段事故：`defineTool` 抛了一句
   * `unsupported JSON schema: parameters.region.additionalProperties must be explicitly true or false`，
   * `apply()` 整体中断，**工具与路由一个都没注册**；而客户端半走另一条加载路径，于是
   * 「电脑操作」芯片照常显示、点下去毫无反应，界面上没有任何东西说明为什么。
   *
   * 一个工具的描述符不该有权把整个能力带走。所以十六处注册逐条兜住，失败的留在这里，
   * 由 `/computer-use/status` 的 `runtime.registrationFailures` 报出来——同样的症状下一次
   * 会自己说出是哪个工具、哪一句。
   */
  const registrationFailures = [];
  /** 注册成功的工具名。与失败清单凑成"这一版到底装上了哪些工具"的完整答案。 */
  const registeredToolNames = [];

  /**
   * 注册一个工具，只让失败留在它自己身上。
   * @param definition - 已经过 `defineTracedTool` 的描述符。
   * @returns 注册成功与否。
   */
  function safeRegister(definition) {
    const toolName = String(definition?.name ?? '(unnamed tool)');
    try {
      ctx.tools.register(definition);
      registeredToolNames.push(toolName);
      // 优-P1-16：schema 税只算**注册成功**的描述符——被拒的根本不会随请求发出去。
      try {
        schemaTaxChars += JSON.stringify(definition).length;
      } catch {
        /* 描述符里若有不可序列化的东西，那一部分不进税账（也不让它打断注册） */
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      registrationFailures.push({ name: toolName, message: message.slice(0, 400) });
      ctx.logger?.error?.(
        'computer-use: tool %s was refused by the host (%s); the other tools and the chip keep working',
        toolName,
        message,
      );
      return false;
    }
  }

  // app-launch 原本也是独立插件（@local/dsh-app-launch），现并入本插件：用它启动 GUI 应用可以避开
  // 本会话环境里的 ELECTRON_RUN_AS_NODE 等变量（否则 Electron 应用会静默退化成 Node 解释器）。
  // 与"电脑操作"相互独立，只有自己的开关（config.appLaunch.enabled，默认 true）。
  // 放在这里是因为要借用刚定义的 defineTracedTool —— 这两个工具因此与其它工具一样进 trace。
  if (typeof ctx.tools?.register === 'function') {
    // 优-P0-02：app_launch 收编进「电脑操作」闸门——它能启动任意 GUI 应用，与把鼠标键盘
    // 交给模型是同一量级的授权。做法是装配层包一层 defineTool（不动 app-launch.mjs 本体）：
    // 仅给 app_launch 的 execute 前置 requireGrant（含拒子代理），app_env_audit 只读自检免授权。
    // `config.appLaunch.requireGrant: false` 是逃生门（独立部署想让它脱离闸门时）。
    const appLaunchConfig = config?.appLaunch ?? {};
    const defineAppLaunchTool = appLaunchConfig.requireGrant === false
      ? defineTracedTool
      : (definition) => defineTracedTool(
          definition?.name === 'app_launch'
            ? {
                ...definition,
                async execute(args, exec) {
                  requireGrant(exec);
                  return definition.execute.call(this, args, exec);
                },
              }
            : definition,
        );
    try {
      applyAppLaunch(ctx, appLaunchConfig, { defineTool: defineAppLaunchTool });
    } catch (error) {
      ctx.logger?.warn?.(`computer-use: app-launch could not mount (${String(error)})`);
    }
    // 实时感知层（移植自 dsh-see-now 0.0.3，砍旁白/悬浮窗/后台唤醒）：computer_watch 工具。
    // 与操控工具同一道闸门（requireGrant = 会话的「电脑操作」开关）。
    try {
      applySeeNow(ctx, { registerTool: safeRegister, defineTool: defineTracedTool, requireGrant });
    } catch (error) {
      ctx.logger?.warn?.(`vision-control: see perception could not mount (${String(error)})`);
    }
  }

  /**
   * 1.40.1 安全网：只要**这个 profile 自己带了一份** `@deepseek-ai/dsh-tools`（1.39.x 与
   * 1.40.0 把它声明成 `optional: false` 的 peer，包管理器就会在 profile 里落一份实体），
   * 宿主就会优先加载那一份；版本一旦与桌面版不一致，loader 会禁用 `tools` 这一行，所有注入
   * 它的 row 一起挂起，`agent-loop` 是 required → 整机起不来，而且报错里不点名任何插件。
   *
   * 判据用 Node 原生解析（不走宿主的适配层）：插件被装进 profile 时，`@deepseek-ai/dsh-tools`
   * 会解析到 `...\profiles\<name>\node_modules\...`；干净机器上这条解析根本不存在，直接抛错。
   * 所以「解析成功且落在 profiles 下」精确等于「profile 里有一份会抢在宿主前面的副本」。
   * 只报警、不改文件；任何异常都不许打断启动。
   */
  let profileShadowNotice = null;
  try {
    const resolver = import.meta.resolve;
    if (typeof resolver === 'function') {
      const resolved = resolver('@deepseek-ai/dsh-tools');
      if (/[\\/]profiles[\\/][^\\/]+[\\/]node_modules[\\/]/.test(resolved)) {
        profileShadowNotice = resolved;
        ctx.logger?.error?.(
          'computer-use: this profile carries its own copy of @deepseek-ai/dsh-tools (%s). '
          + 'The host loads that copy first, so a version mismatch makes the whole app refuse to start '
          + '("agent-loop (required) tools", no plugin named). Run tools/fix-profile-links.ps1 to turn it '
          + 'into a junction to the app copy, then restart DSH.',
          resolved,
        );
      }
    }
  } catch {
    // 原生解析找不到该包 = 这一台机器没有那份副本，正常
  }

  /** The runtime summary the status route exposes: counters, recent spans, profiles, workers. */
  function runtimeSummary() {
    const describe = (instance) => (instance === null
      ? null
      : {
        pid: Number(instance.info?.pid ?? 0),
        generation: instance.info?.generation ?? null,
        alive: instance.alive,
        outstanding: instance.outstanding,
        transport: instance.stats ?? null,
      });
    return {
      metrics: {
        toolCalls: metrics.toolCalls,
        refusals: metrics.refusals,
        guardInterceptions: metrics.guardInterceptions,
        // 优-P1-09：与 guardInterceptions 对齐报告——守卫"读不到所以没验证"的放行次数。
        guardUnavailable: metrics.guardUnavailable,
        // Inputs that reached a target nobody intended. The landing guard exists to keep this
        // at zero, and it is reported rather than assumed — a count that cannot move is worth
        // exactly as much as the guard that keeps it there.
        wrongTargetInputs: 0,
        screenshots: metrics.screenshots,
        screenshotPixels: metrics.screenshotPixels,
        screenshotBytes: metrics.screenshotBytes,
        uiReads: metrics.uiReads,
        uiNodes: metrics.uiNodes,
        uiReadMs: metrics.uiReadMs,
        waitOutcomes: { ...metrics.waitOutcomes },
        readRetries: metrics.readRetries,
        // 优-P1-16：token 对账的两把尺子。图像 = 交付图像像素 / 1650（watch 三档实测锚点
        // 共线得出）；schema 税 = 注册成功的工具描述符 JSON 字符数与 chars/4 估算（地面真值
        // 是 schema-visibility.mjs 文件头实测的 15,054/20,990，此估算跟踪它不取代它）。
        // 已知口径边界：app_launch/app_env_audit 不经 safeRegister，两个小编码不计入。
        imageTokensEstimated: metrics.imageTokensEstimated,
        schemaTax: {
          chars: schemaTaxChars,
          tokensEstimated: Math.round(schemaTaxChars / 4),
          basis: 'chars/4 over successfully registered tool descriptors (functions do not serialize); ground truth: 15,054 of 20,990 tokens measured (schema-visibility.mjs header)',
        },
        // §7.2's counter: how many times worker.ps1 was actually read and hashed. It is the
        // number the caching work is supposed to keep flat while calls keep coming, and a
        // number that cannot be observed is not evidence of anything (§12.2: 验证重复次数下降，
        // 而不仅是偶然耗时下降).
        buildReads: buildReadsCount(),
      },
      // §A/§G: which instance owns this host, how many duplicate mounts tried to join it, and
      // which release identity the files on disk actually form. These are the answers that used
      // to require guessing from a startup failure.
      instance: describeInstance(instance),
      release: summarizeRelease(release),
      host,
      // 装配期的失败：被宿主拒绝的工具描述符（工具名 + 原话），以及 schema 可见性这条链现在
      // 有多少个活 agent 可对齐。两者都为"芯片亮着、工具却没有"这种症状留了可读的原因——
      // 前者解释工具为什么不在，后者解释点开之后为什么还没回来。
      registrationFailures: registrationFailures.map((entry) => ({ ...entry })),
      // 1.40.1：profile 里自带的那份 @deepseek-ai/dsh-tools 抢在了宿主前面。非 null 时宿主
      // 的 `tools` 行来自这份副本，版本一旦与桌面版不一致，整机下一次启动就会起不来。
      profileShadow: profileShadowNotice,
      schemaVisibility: {
        enabled: visibility.enabled,
        liveAgents: visibility.liveAgentCount(),
        restrictedSessions: visibility.restrictedCount(),
      },
      trace: trace.slice(-10).map((record) => ({ ...record })),
      profiles: [...profiles.values()]
        .filter((entry) => Date.now() - entry.observedAt <= PROFILE_TTL_MS)
        .map((entry) => ({
          key: entry.key,
          app: entry.app,
          hwnd: entry.hwnd,
          state: entry.state,
          evidence: entry.evidence,
          ageMs: Date.now() - entry.observedAt,
          probes: entry.probes,
        })),
      backends: { main: describe(backend), read: describe(readBackend) },
    };
  }

  /* -------------------------------------- B02: what we have seen about a window -- */

  /**
   * What this plugin has *observed* about how a particular window can be driven.
   *
   * The point of keeping this at all is to stop one expensive failure from being generalised
   * into a policy: "the QQ group panel exposed no usable controls" says nothing about QQ's
   * dialogs, and a single bad read of a page says nothing about the next page. So the key is
   * the *window* (application + handle), the value is an observation with its evidence and
   * the moment it was made, and the entry expires — a window that was unreadable five minutes
   * ago is probed again rather than written off forever.
   *
   * Statuses are the four the plan asks for: available / degraded / unavailable / unknown.
   * `unknown` is the honest one for "the read returned nothing usable, and that is all we
   * know" — it does not justify skipping the next attempt.
   */
  const PROFILE_TTL_MS = 10 * 60 * 1000;
  const PROFILES_LIMIT = 64;
  /**
   * How long a degraded conclusion may stop an *optional* expensive probe (§5.3: "对于重复得到
   * 相同退化结果的同一页面，暂时跳过昂贵探测"). Only the explicit `skip_if_degraded` path uses
   * it — an ordinary read always reads, because the caller asking is new evidence.
   */
  const PROFILE_COOLDOWN_MS = 90 * 1000;
  const profiles = new Map();
  let profilesGeneration = '';

  function capabilityKey(appName, hwnd) {
    return `${appName}|${Math.trunc(Number(hwnd) || 0)}`;
  }

  function noteCapability(appName, hwnd, state, evidence, identity = {}) {
    // `hwnd` may be 0: some capabilities are about the desktop or about the session rather than
    // about one window (whether synthesized input is being delivered at all, whether a local
    // file can be read). Those get their own key instead of being dropped.
    //
    // The entry also carries *which process instance* and *which conversation* it was observed
    // in. The plan asks for the cache key to include the application's identity and the session
    // (§5.3), and the cheapest honest form of "application identity" here is the process behind
    // the handle: a restarted or upgraded application is a different process, so its old
    // conclusions stop applying without anyone having to version the key itself.
    if (typeof appName !== 'string' || appName === '') return;
    profilesGeneration = String(backend?.info?.generation ?? '');
    const key = capabilityKey(appName, hwnd);
    const previous = profiles.get(key);
    profiles.delete(key);
    profiles.set(key, {
      key,
      app: appName,
      hwnd: Number(hwnd),
      state,
      evidence: String(evidence ?? ''),
      // Kept so a caller can see whether an entry is a fresh probe or an old conclusion.
      observedAt: Date.now(),
      probes: Number(previous?.probes ?? 0) + 1,
      generation: profilesGeneration,
      pid: Number(identity.pid ?? previous?.pid ?? 0),
      session: typeof identity.session === 'string' ? identity.session : String(previous?.session ?? ''),
    });
    while (profiles.size > PROFILES_LIMIT) {
      const oldest = profiles.keys().next().value;
      if (oldest === undefined) break;
      profiles.delete(oldest);
    }
  }

  /**
   * The profile for this window, or undefined when it has never been observed (or has expired).
   *
   * `session` is checked when both sides have one: a conclusion reached while driving a window in
   * one conversation is not carried into another one, which is what §5.3 asks the cache key to
   * carry. The check is optional on purpose — the render path has no conversation in hand and
   * shows the remembered observation as the *history* it is, while the path that *decides*
   * something (skipping a probe) always knows who is asking.
   */
  function capabilityFor(hwnd, appName, pid, session) {
    const entry = profiles.get(capabilityKey(appName, hwnd));
    if (entry === undefined) return undefined;
    if (Date.now() - entry.observedAt > PROFILE_TTL_MS) return undefined;
    if (entry.generation !== String(backend?.info?.generation ?? '')) return undefined;
    // A different process behind the same handle means a different application instance: the
    // old conclusion was about something that is no longer running (§5.3).
    if (Number.isFinite(Number(pid)) && Number(pid) > 0 && Number(entry.pid) > 0 && Number(entry.pid) !== Number(pid)) return undefined;
    if (typeof session === 'string' && session !== '' && String(entry.session ?? '') !== '' && String(entry.session) !== session) return undefined;
    return entry;
  }

  /**
   * The profile for a window the caller named only by handle.
   *
   * Used where the handle is known before anything has been read (the `skip_if_degraded` path),
   * so there is no process name to key on yet — and no live pid either, which is why the pid is
   * passed as 0 here: comparing the entry against its own recorded pid would be a check that can
   * only agree with itself. What this path can verify is the conversation and the age of the
   * conclusion, and those are what it does verify.
   *
   * @param hwnd - the window handle.
   * @param session - the conversation asking, when it is known.
   * @returns the entry, or undefined.
   */
  function capabilityForHwnd(hwnd, session) {
    const wanted = Math.trunc(Number(hwnd) || 0);
    if (wanted === 0) return undefined;
    for (const entry of profiles.values()) {
      if (Number(entry.hwnd) !== wanted) continue;
      return capabilityFor(entry.hwnd, entry.app, 0, session);
    }
    return undefined;
  }

  /** One line for a read that this window has a history, or ''. */
  function capabilityNote(hwnd, appName, pid) {
    const entry = capabilityFor(hwnd, appName, pid);
    if (entry === undefined || entry.state === 'available') return '';
    const age = Math.round((Date.now() - entry.observedAt) / 1000);
    if (entry.state === 'degraded') {
      return `this window was read before as *degraded* ${age}s ago (${entry.evidence}): the control types and ids here may be approximate. Verify with a read-back before acting on an id, or fall back to a capture and pixels.`;
    }
    if (entry.state === 'unavailable') {
      return `this window was *unavailable* to the accessibility layer ${age}s ago (${entry.evidence}): if this read is empty again, the window is not the problem to keep retrying — capture it and work from pixels, or drive it from the keyboard.`;
    }
    return `this window was last read as *unknown* ${age}s ago (${entry.evidence}).`;
  }

  function noteCapabilityFromValue(record, value) {
    if (record.tool !== 'computer_ui') return;
    const window = value?.window;
    if (window === undefined || window === null) return;
    const nodes = Array.isArray(value.nodes) ? value.nodes.length : 0;
    if (value.legacy === true) {
      noteCapability(String(window.process ?? ''), window.hwnd, 'degraded', 'the tree came through the MSAA bridge, so control types and ids are generic', { pid: window.pid, session: record?.session });
      return;
    }
    if (nodes === 0) {
      noteCapability(String(window.process ?? ''), window.hwnd, 'unknown', 'the read covered the window and returned no nodes', { pid: window.pid, session: record?.session });
      return;
    }
    noteCapability(String(window.process ?? ''), window.hwnd, 'available', `${nodes} node(s) with their own control types`, { pid: window.pid, session: record?.session });
  }

  function noteCapabilityFromCapture(record, value) {
    // The visual half of the capability model: can this window be captured as *itself*, or does
    // it only come back as whatever is on top of it? A window that cannot render itself is not
    // a broken window -- it is a window whose captures must be read differently.
    const shot = value?.shot ?? (value?.imageWidth === undefined ? undefined : value);
    if (shot === undefined || shot === null) return;
    const hwnd = Number(shot.window?.hwnd ?? 0);
    const app = String(shot.window?.process ?? 'desktop');
    const identity = { pid: shot.window?.pid, session: record?.session };
    if (shot.source === 'window') {
      noteCapability(app, hwnd, 'available', 'the window rendered its own pixels for a capture', identity);
      return;
    }
    if (hwnd !== 0) {
      noteCapability(app, hwnd, 'degraded', 'the capture fell back to the screen, so it holds whatever was in front of the window', identity);
      return;
    }
    noteCapability(app, 0, 'available', 'screen pixels could be read at those coordinates', identity);
  }

  function noteCapabilityFromWaits(record, value) {
    // The "can this task observe its own result" half: a file condition that can read the
    // artefact is evidence for it, and one that cannot look at the path at all is evidence
    // against it. Either way it is recorded per observation, not turned into a policy.
    for (const report of Array.isArray(value?.waits) ? value.waits : []) {
      const what = String(report?.what ?? '');
      if (!what.startsWith("the file '")) continue;
      if (report?.satisfied === true) noteCapability('local-file', 0, 'available', 'the artefact could be read from disk');
      else if (String(report?.status) === 'unknown') noteCapability('local-file', 0, 'degraded', 'the path could not be looked at (permissions, or a share that went away)');
    }
  }

  function noteCapabilityFromFailure(record, message) {
    const hwnd = Number(record?.args?.hwnd ?? record?.args?.window ?? 0);
    // The input half: whether synthesized input is being delivered at all, and whether it is
    // going where it was aimed. These are session-level facts, so they get the session key.
    if (/\[SEND_INPUT_BLOCKED\]|SendInput delivered no|pointer did not reach|nothing moved/i.test(message)) {
      noteCapability('input', 0, 'unavailable', 'Windows discarded the synthesized input (a locked session, a secure desktop, or UIPI)');
      return;
    }
    if (/\[FRONT_NOT_TARGET\]/i.test(message)) {
      noteCapability('input', hwnd, 'degraded', 'the foreground was not the window this input was aimed at');
      return;
    }
    if (hwnd === 0) return;
    if (/\[ELEMENT_UNAVAILABLE\]|\[TREE_UNAVAILABLE\]|\[ACTION_UNAVAILABLE\]/.test(message)) {
      noteCapability(appForHwnd(hwnd), hwnd, 'degraded', 'an accessibility action on this window was refused');
      return;
    }
    if (/\[CAPTURE_SURFACE_UNAVAILABLE\]|\[WINDOW_MINIMIZED\]/.test(message)) {
      noteCapability(appForHwnd(hwnd), hwnd, 'degraded', 'the window would not render for a capture');
    }
  }

  /** The process name last seen for a handle, from the trace — enough for a profile key. */
  function appForHwnd(hwnd) {
    for (let i = trace.length - 1; i >= 0; i -= 1) {
      const candidate = trace[i];
      if (Number(candidate?.args?.hwnd) === Number(hwnd) && typeof candidate.app === 'string' && candidate.app !== '') return candidate.app;
    }
    return `hwnd:${Number(hwnd)}`;
  }

  /* ----------------------------- A10: reads run somewhere they can be recovered */

  /**
   * Read-only commands that keep no cross-call state in the worker, and are therefore safe
   * to run in a *second* worker process: a stuck accessibility or graphics call in the main
   * worker then cannot delay the caller's next look at the window list, the cursor or a
   * pixel fingerprint.
   *
   * What is deliberately NOT in this list, and why it matters: `screenshot` and `uitree`
   * mint a frame / a snapshot into the worker's own registry, and a frame cited by id is
   * only meaningful in the process that took it. Moving them to another process would trade
   * a delay for a broken citation, so they stay where their registry is — they get the other
   * half of A10 instead (a read may be retried, because a read cannot be half-done).
   */
  const ISOLATED_READ_COMMANDS = new Set(['digest', 'windows', 'cursor', 'health', 'pacing', 'frameproject']);
  let readBackend = null;
  /**
   * 优-P0-16：readBackend 空闲回收。这个 130MB 常驻只服务 6 个低频只读命令
   * （ISOLATED_READ_COMMANDS），二十份辩论文件无一席为这笔账辩护。改为按需启动、
   * 空闲 READ_BACKEND_IDLE_MS 后回收，下次用再冷启动（优-P1-01 的 60s 超时 +
   * 一次重试已在同版本落地，回收后的冷启动不再撞线——这是方案钉死的顺序条件）。
   */
  const READ_BACKEND_IDLE_MS = 12 * 60 * 1000;
  /** readBackend 最近一次服务读请求的时刻（ensure 成功时盖章）。 */
  let readBackendLastUsedAt = 0;
  let readBackendIdleTimer = null;

  /**
   * 空闲回收的四重条件（方案原文）：dispose 握手（bridge 的 dispose 先写 shutdown 行、
   * 800ms 后才 kill——不是裸杀）+ 仅 outstanding==0 发起 + 不绕 bridge 的 exit 身份
   * 守卫（走 dispose() 这条受 sanction 的路，守卫自然完好）+ 优-P1-01 先行（同上）。
   */
  function recycleReadBackendIfIdle() {
    readBackendIdleTimer = null;
    if (readBackend === null) return;
    const idleFor = Date.now() - readBackendLastUsedAt;
    if (idleFor < READ_BACKEND_IDLE_MS) {
      scheduleReadBackendIdleCheck(READ_BACKEND_IDLE_MS - idleFor);
      return;
    }
    if (readBackend.outstanding !== 0) {
      // 有在飞请求就不是空闲：过一会儿再来看，绝不在它头上回收。
      scheduleReadBackendIdleCheck(30_000);
      return;
    }
    ctx.logger?.info?.('computer-use: read backend idle for %d min; shutting it down (it cold-starts on the next read)', Math.round(idleFor / 60_000));
    const retiring = readBackend;
    readBackend = null;
    try {
      retiring.dispose();
    } catch {
      /* best effort: the process is gone either way, the next read starts a fresh one */
    }
  }

  /** 安排下一次空闲检查。delayMs 缺省为完整空闲窗。timer unref，不拖着宿主进程。 */
  function scheduleReadBackendIdleCheck(delayMs) {
    if (readBackendIdleTimer !== null) return; // 已有一张表，别叠
    readBackendIdleTimer = setTimeout(recycleReadBackendIfIdle, delayMs);
    readBackendIdleTimer.unref?.();
  }

  /**
   * The worker that serves the isolated read commands. Started on first use, recycled after
   * an idle stretch (优-P0-16), and verified against the same protocol/build contract as
   * the main one: two processes that disagree about the wire are worse than one.
   * @returns the started backend.
   */
  async function ensureReadBackend() {
    if (!SUPPORTED) throw new ComputerUseBackendError(UNSUPPORTED_REASON, 'UNSUPPORTED_PLATFORM');
    if (readBackend === null) {
      readBackend = new PowerShellBackend({
        timeoutMs: Math.max(actionTimeoutMs, startTimeoutMs),
        startTimeoutMs,
        cancelFilePath: markerPath('cancel-read'),
      });
    }
    await startWithRetry(readBackend);
    await assertWorkerContract(readBackend);
    // 在 ensure 成功处盖章而不是请求结束时：12 分钟的空闲窗远大于任何读请求的耗时，
    // 所以"盖章后计时器才起跑"不可能在调用中途误判回收（outstanding==0 是第二道闸）。
    readBackendLastUsedAt = Date.now();
    scheduleReadBackendIdleCheck(READ_BACKEND_IDLE_MS);
    return readBackend;
  }

  /**
   * Whether a failed call may simply be repeated.
   *
   * Only reads qualify, and only for the failures that leave nothing behind: a timeout means
   * the worker was restarted (the next call starts a fresh one), an exit means the same, and
   * a startup timeout means no command ever ran. A write is never retried here — it may have
   * happened, and only an observation can tell (方案 §6.4).
   */
  function mayRetryRead(error) {
    const code = String(error?.code ?? '');
    return code === 'TIMEOUT' || code === 'WORKER_EXITED' || code === 'START_TIMEOUT';
  }

  /* ------------------------------------------------------------------- V01 end */

  /** 需要"坐标必须是数字"的命令 → 它们各自的坐标字段。 */
  const COORDINATE_FIELDS = {
    click: ['x', 'y'],
    move: ['x', 'y'],
    drag: ['fromX', 'fromY', 'toX', 'toY'],
    scroll: ['x', 'y'],
  };
  /**
   * 坐标字段缺省时是否算错。
   *
   * `move`/`scroll` 的坐标是可选的（"在当前位置滚"、相对移动用 `dx`/`dy`）；`click` 不是——
   * 缺坐标时 worker 按 0 处理，那就是一次没人要求的左上角点击。
   * `drag` 也不是，**但**有一条例外：只给 `path`（waypoint 列表）的拖拽是合法的（worker 支持），
   * 所以它在下面单独判断。
   */
  const COORDINATES_REQUIRED = new Set(['click', 'drag']);

  /**
   * 派发前的参数护栏。
   *
   * 两件事，都是"宿主本该挡住、但挡住比漏过去便宜"的：
   *
   *   1. **`hwnd` 必须是能转成整数的非负数字**（或数字字符串）。worker 用 `[int]` 接它：字符串垃圾
   *      会得到一句 PowerShell 原生异常，负数会得到一句 COM 异常——两者都既没有失败码也没有下一步。
   *   2. **坐标类命令的坐标必须是有限数字**；`click` 要求它们**存在**。缺坐标时 worker 会按 0 处理，
   *      于是"没给坐标的点击"真的点到屏幕左上角——那不是拒绝，是一次真实的误操作。
   *
   * 批量步骤（`batch`）走同一套规则，所以"步骤 6 缺坐标"会在**第一步执行之前**被拒
   * （与 worker 的"整批先校验"一致）。
   * @param cmd - 后端命令。
   * @param args - 后端参数。
   */
  function assertBackendArgs(cmd, args) {
    const isFiniteNumber = (value) => value !== null && value !== '' && Number.isFinite(Number(value));
    const checkCoordinates = (command, target, where) => {
      const fields = COORDINATE_FIELDS[command];
      if (fields === undefined) return;
      // 只给 path 的拖拽是合法的（worker 接受 waypoint 列表）——别把这条路挡掉。
      if (command === 'drag' && Array.isArray(target?.path) && target.path.length > 0) return;
      const required = COORDINATES_REQUIRED.has(command);
      for (const field of fields) {
        const value = target?.[field];
        const missing = value === undefined || value === null;
        if (missing && !required) continue;
        if (missing || !isFiniteNumber(value)) {
          throw new Error(`[BAD_REQUEST] ${where} needs a numeric ${field} (got ${JSON.stringify(value ?? null)}). Coordinates are absolute virtual-desktop pixels: read a window with computer_ui (or take a capture) and use the coordinates from that, rather than calling ${command} with no position.`);
        }
      }
    };

    const checkHwnd = (target, where) => {
      const hwnd = target?.hwnd;
      if (hwnd === undefined || hwnd === null || hwnd === '') return;
      if (!isFiniteNumber(hwnd)) {
        throw new Error(`[BAD_REQUEST] ${where} hwnd must be a window handle number (got ${JSON.stringify(hwnd)}). Get one from computer_windows (or computer_ui's reply) and pass that number.`);
      }
      // 负数不是"某个窗口"：worker 会拿它去走 UIA，然后回一句 COM 的原始异常
      // （"事件无法调用任何订户"），既看不出是参数问题、也没有下一步。
      if (Number(hwnd) < 0) {
        throw new Error(`[BAD_REQUEST] ${where} hwnd must not be negative (got ${JSON.stringify(hwnd)}). Window handles are positive numbers from computer_windows; omit hwnd entirely to mean "the foreground window".`);
      }
    };

    checkHwnd(args, 'this call\'s');

    if (cmd === 'batch') {
      const steps = Array.isArray(args?.steps) ? args.steps : [];
      steps.forEach((step, index) => {
        const action = String(step?.action ?? '').toLowerCase();
        // 步骤可以各自带 `hwnd`（`STEP_PASSTHROUGH` 里就有它），所以每一步都要过同一道检查。
        checkHwnd(step, `step ${index + 1} (${action})'s`);
        checkCoordinates(action, step, `step ${index + 1} (${action})`);
      });
      return;
    }
    checkCoordinates(cmd, args, `a ${cmd} call`);
  }

  /**
   * Run one backend command, refusing when the Session has no grant.
   *
   * The call is registered as in-flight for its session and carries a signal that aborts
   * when either the caller or a revoke says so, which is what makes "turn it off" reach
   * the worker instead of stopping at the host's own bookkeeping.
   * @param exec - the tool execution carrying the calling agent.
   * @param cmd - backend command name.
   * @param args - backend arguments.
   * @param options - `timeoutMs` override and `interactive` preflight.
   * @returns the backend result.
   */
  async function call(exec, cmd, args, options = {}) {
    requireGrant(exec);
    // 参数护栏（本仓库自己的检查，不依赖宿主）：两类值在这里就挡掉，因为它们进了 worker 会以两种
    // 都不好看的方式失败——
    //   · `hwnd` 不是数字：worker 的 `[int]` 转换会抛 PowerShell 原生错误（"无法将值…转换为类型
    //     System.Int64"），模型看到的是一句既没有失败码、也没有下一步的报错；
    //   · 坐标不是数字/缺失：坐标类命令会按 0 处理，于是"没给坐标的点击"真的点到屏幕左上角。
    // 两道检查都在派发之前，所以拒绝是**廉价**的（不启动 worker、不占用租约）。
    assertBackendArgs(cmd, args);
    claimController(sessionKey(exec?.agent?.session?.id), cmd, args);
    const sessionId = exec?.agent?.session?.id;
    const control = new AbortController();
    const untrack = execution.track(sessionId, control);
    const signal = combineSignals(exec?.signal, control.signal);
    if (movesDesktop(cmd, args)) noteAction(sessionKey(sessionId), describeCall(cmd, args));
    // Where this command runs (A10): a command that keeps no cross-call state in the worker
    // goes to the isolated read worker, so a stuck graphics or accessibility call in the main
    // one cannot delay the caller's next look at the window list or a fingerprint. Everything
    // else — every write, and the reads that mint a frame or a snapshot into the worker's own
    // registry — stays in the main worker, where those citations mean something.
    const isolated = ISOLATED_READ_COMMANDS.has(cmd);
    const pickBackend = () => (isolated ? ensureReadBackend() : ensureBackend());
    try {
      const instance = await pickBackend();
      await assertWorkerContract(instance);
      // Optional-capability gates (workerfeat A.4 / ocr O.4): unlike REQUIRED_WORKER_CAPABILITIES
      // these refuse with BAD_REQUEST — drop the argument and the same call works — so a
      // half-applied upgrade costs one feature instead of the whole plugin. The isolated
      // read worker publishes the same capability list, so no case split is needed here.
      const publishedCaps = Array.isArray(instance.info?.capabilities) ? instance.info.capabilities.map(String) : [];
      if (cmd === 'batch' && (args?.dryRun === true || args?.dry_run === true) && !publishedCaps.includes('batch.dryrun')) {
        throw new Error("[BAD_REQUEST] this batch asked for dry_run, but the running worker does not publish 'batch.dryrun' — likely a half-applied upgrade; restart the app so both halves match, or drop the dry_run argument.");
      }
      if (!publishedCaps.includes('ocr.observe') && ((cmd === 'uitree' && args?.ocr !== undefined && args?.ocr !== null) || (cmd === 'batch' && args?.state?.ocr !== undefined && args?.state?.ocr !== null))) {
        throw new Error("[BAD_REQUEST] this read asked for ocr, but the running worker does not publish 'ocr.observe' — likely a half-applied upgrade; restart the app so both halves match, or drop the ocr argument.");
      }
      if (options.interactive === true && options.dryRun !== true) {
        // A locked workstation or an open UAC prompt swallows SendInput without
        // any error, so refuse up front rather than reporting a click that never
        // happened.
        const health = await instance.request('health', {}, { timeoutMs: 8_000, signal });
        if (health.interactive !== true) {
          throw new Error(`无法操作电脑：${health.note}`);
        }
      }
      // §6 item 9: while this write is really executing, the lease is *held*, not merely
      // stamped. The idle clock is restarted when the write finishes, so a long drag or a batch
      // with waits inside it cannot have its ownership expire underneath it.
      const writing = movesDesktop(cmd, args);
      if (writing) beginWrite();
      // 新-P1-04：动作审计只记"动桌面"的调用（读与盯屏轮询不入账，否则日志被噪声淹没），
      // 成功与失败都记——复盘要的正是"试过什么、哪一步出事"。内容类参数只存长度
      // （auditDescribe 的 devil 字段集），这里永远见不到 type/key 的内容。
      const auditStartedAt = writing ? Date.now() : 0;
      try {
        let result;
        try {
          result = await instance.request(cmd, args, {
            timeoutMs: options.timeoutMs ?? actionTimeoutMs,
            signal,
          });
        } catch (failure) {
          // A read may be repeated for free; a write may not (方案 §6.4). When the failure was a
          // timeout the transport has already dropped the worker, so the retry runs in a fresh
          // process rather than the one that was stuck. Exactly one retry: a second identical
          // failure is a fact about the desktop, not about the attempt.
          if (options.retryRead !== false && isIdempotentCall(cmd, args) && mayRetryRead(failure)) {
            metrics.readRetries += 1;
            const retried = await pickBackend();
            result = await retried.request(cmd, args, {
              timeoutMs: options.timeoutMs ?? actionTimeoutMs,
              signal,
            });
          } else {
            throw failure;
          }
        }
        if (writing) audit.record(sessionKey(sessionId), { event: 'action', cmd, what: auditDescribe(cmd, args), ok: true, ms: Date.now() - auditStartedAt });
        return result;
      } catch (failure) {
        if (writing) audit.record(sessionKey(sessionId), { event: 'action', cmd, what: auditDescribe(cmd, args), ok: false, error: backendMessage(failure), ms: Date.now() - auditStartedAt });
        throw failure;
      } finally {
        // The idle window starts *now*, not when the call was accepted: "quiet for N seconds"
        // has to mean the desktop has been quiet for N seconds.
        if (writing) finishWrite();
      }
    } catch (error) {
      // The retry guidance depends on whether this call could have happened: a read can
      // be repeated for free, a click cannot.
      const context = { idempotent: isIdempotentCall(cmd, args) };
      throw new Error(withOutcomeNote(decorateFailure(backendMessage(error), context), error, cmd, args));
    } finally {
      untrack();
    }
  }

  /**
   * Revoke a session's grant and make the stop real.
   *
   * Order is the whole point, and it is the order the review asked for:
   *
   *   1. the grant goes first, so nothing new can start while the stop is happening;
   *   2. every in-flight call of that session is aborted — the transport drops anything
   *      still queued (an action that was never written will never happen) and tells the
   *      worker to stop at its next step boundary (a batch stops between steps);
   *   3. the worker is asked to release whatever it is still holding down, because a
   *      cancelled drag or key hold that is not unwound leaves the desktop stuck;
   *   4. only then is the session reported as stopped.
   * @param sessionId - the Session to revoke.
   * @param reason - text recorded on the aborted calls.
   * @returns `{ cancelled, released, error }` for the caller to report.
   */
  async function revokeSession(sessionId, reason = 'the capability was turned off') {
    const key = sessionKey(sessionId);
    sessions.revoke(key);
    execution.beginStop(key);
    let cancelled = execution.abort(key, reason);
    // The browser channel belongs to the session as well: aborting its calls above stops the
    // steps, and closing the channel stops anything else this session could still ask of it
    // without a fresh grant (§5.1: 撤销会话时清理对应浏览器资源).
    disposeBrowserSessionsFor(key);
    let released = [];
    let error = '';
    try {
      const instance = await ensureBackend();
      cancelled += instance.cancelAll(reason);
      // Give the worker a moment to unwind the step it is in: a release that arrives
      // while a drag is mid-move would be undone by the drag's own finally block.
      const deadline = Date.now() + 800;
      while (Date.now() < deadline && instance.outstanding > 0) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const result = await instance.request('release', {}, { timeoutMs: 5_000 });
      released = Array.isArray(result.released) ? result.released.map(String) : [];
    } catch (failure) {
      error = backendMessage(failure);
    } finally {
      execution.endStop(key);
    }
    // 新-P1-04：撤销是审计生命周期的合账点之一（grant 开、revoke/dispose 合）。
    void audit.close(key, {
      event: 'revoke',
      reason,
      cancelled,
      released: released.length,
      ...(error === '' ? {} : { error }),
    });
    return { cancelled, released, error };
  }


  /**
   * Capture one display into an image under the plugin's shot directory.
   *
   * `scale` and `format` are spent here rather than downstream: the host's
   * attachment layer passes an image through untouched only when it already
   * satisfies its limits, and the model pays for whatever resolution it is handed.
   * @param exec - the tool execution.
   * @param options - display/region selection, scale, format, path, and the pacing arguments
   *   (`settleMs`, `stabilityMs`, `stable`) forwarded to the worker unchanged: the host has
   *   no pacing policy of its own, and inventing one here is how the two halves drift apart.
   * @returns `{ shot, path, captureMs, queueMs }`.
   */
  async function capture(exec, options) {
    await mkdir(shotRoot, { recursive: true });
    const format = resolveFormat(options.format, options.path);
    const shotPath = options.path ?? captureService.nextCapturePath(shotRoot, format);
    // Measured rather than guessed: "the capture is slow" and "attaching it is slow" are
    // different problems (a slow GDI/PrintWindow path vs. an oversized image crossing the
    // attachment layer), and without the split the only visible number is the whole call.
    const started = Date.now();
    const shot = await call(exec, 'screenshot', {
      path: shotPath,
      window: options.window,
      requireWindow: options.requireWindow,
      display: options.display,
      region: options.region,
      regionSpace: options.regionSpace,
      surface: options.surface,
      clip: options.clip === true,
      scale: options.scale,
      format,
      quality: options.quality,
      settleMs: options.settleMs,
      stabilityMs: options.stabilityMs,
      stable: options.stable,
    }, { timeoutMs: Math.max(actionTimeoutMs, 25_000) });
    // How long this call sat in the transport queue before the worker got it. That time is
    // part of the call's wall time and none of the capture's own time: without it, a capture
    // that waited five seconds behind another call looks like a slow capture.
    const queueMs = Number(shot?.__bridgeTiming?.queueMs ?? 0);
    return { shot, path: shotPath, captureMs: Date.now() - started, queueMs };
  }

  /**
   * Tell the worker what the host actually delivered for a frame (A04).
   *
   * The worker encodes an image and registers a frame for it; the attachment layer then
   * takes that file into the session store and is free to resize or re-encode it on the way.
   * Once that has happened the paperwork has to say so: otherwise a coordinate the model reads
   * off *its* copy gets projected as if it were a pixel of the file the worker wrote, which is
   * off by the ratio between the two — a small error that lands on the wrong control and looks
   * like a bad guess.
   *
   * Best effort on purpose. A frame whose size never gets reported is still projected 1:1
   * (which is what happens in practice), and the receipt says which of the two it was; a
   * failure here must never turn a successful capture into a failed call.
   * @param exec - the tool execution, for the backend handle.
   * @param shot - the backend's capture reply.
   * @param admitted - the admitted attachment fields, when there are any.
   */
  async function reportAttachment(exec, shot, admitted) {
    const frame = typeof shot?.frame === 'string' ? shot.frame : '';
    if (frame === '') return;
    const width = Number(admitted?.image?.width ?? 0);
    const height = Number(admitted?.image?.height ?? 0);
    const encodedWidth = Number(shot?.encodedWidth ?? shot?.imageWidth ?? 0);
    const encodedHeight = Number(shot?.encodedHeight ?? shot?.imageHeight ?? 0);
    // A delivered image is a downscale of the capture, never a bigger one. When the reported
    // size cannot be a rescale of this frame — a host whose attachment layer answers with a
    // placeholder (a test double does exactly that) or a size from a different image — the
    // report is dropped rather than passed on: the frame then keeps its 1:1 mapping, which is
    // what every real capture does, instead of having every projected point moved by the
    // ratio between a placeholder and this capture.
    const plausible = width > 0 && height > 0
      && (encodedWidth <= 0 || width <= encodedWidth + 2)
      && (encodedHeight <= 0 || height <= encodedHeight + 2)
      && (encodedWidth <= 0 || width / encodedWidth >= 0.05)
      && (encodedHeight <= 0 || height / encodedHeight >= 0.05);
    if (!plausible) return;
    try {
      await call(exec, 'frameattach', { frame, width, height, transformKnown: true }, { timeoutMs: 5_000 });
    } catch {
      // Bookkeeping, not the capture: a capture that worked is not turned into a failure by it.
    }
  }


  /**
   * Turn a backend capture reply plus its admitted image into the declared value.
   * @param shot - the backend's screenshot result.
   * @param admitted - `{ image?, unchanged?, note? }` from admitCapture.
   * @returns the value `SCREENSHOT_VALUE_SCHEMA` describes.
   */
  // A related capture returns one envelope per frame, described by this same schema: the
  // value carries the first frame's own envelope (so a reader that knew only the single-shot
  // shape still sees one) plus the whole array, each entry carrying its own `frame` id —
  // never the array index (8.txt §7).
  //
  // The item schema is a *copy* of the properties rather than the schema itself: the host's
  // compiler refuses a schema that contains itself (`schema.properties.frames.items is
  // circular`), and it says so at load time — which is how this was caught, by the one test
  // that mounts the plugin against the real `@deepseek-ai/dsh-tools` rather than a stub.
  SCREENSHOT_VALUE_SCHEMA.properties.frames = {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: FRAME_ITEM_PROPERTIES },
    description: 'With captures: related, one entry per frame, in capture order; each has its own `frame` id, its `windowHwnd`, `relation` and real `zRank`.',
  };


  // A deployment that grants computer control up front has nobody to click the
  // chip, so the worker is warmed as soon as the plugin loads.
  if (defaultEnabled) warmBackend();

  /* ------------------------------------------------------- UI Automation -- */


  /**
   * One observation of a window: the tree, plus what it is a tree *of*.
   *
   * `window` is not decoration. The most expensive mistake in this loop is acting
   * on a tree that turns out to be a different window than the one the last click
   * went to — a modal that appeared since the previous read shows up here rather
   * than as "my element vanished". `unchanged` is the cheap half of a diff
   * protocol: byte-for-byte the same tree as the previous read of the same query in
   * this session means the model's action did nothing to this window, which is
   * worth knowing before repeating it.
   */


  /**
   * Note whether this observation repeats the last one for the same query.
   * @param exec - the tool execution carrying the calling agent.
   * @param key - a stable description of the query (window plus filters).
   * @param value - the observation value, mutated in place.
   */
  function markObservation(exec, key, value) {
    const sessionKey = String(exec?.agent?.session?.id ?? '');
    const mapKey = `${sessionKey}|${key}`;
    const previous = observedDigests.get(mapKey);
    if (previous !== undefined && previous === value.digest) value.unchanged = true;
    observedDigests.delete(mapKey);
    observedDigests.set(mapKey, value.digest);
    if (observedDigests.size > OBSERVED_DIGEST_LIMIT) {
      const oldest = observedDigests.keys().next().value;
      if (oldest !== undefined) observedDigests.delete(oldest);
    }
  }

  /**
   * Render an observation for the model.
   *
   * `compact` is the default because of what the model actually does with a tree: it
   * picks a control and acts on it. That needs the ref, the type, the name and the
   * patterns — not the rectangle of every row, nor the diagnostics that explain how the
   * rows were folded. Geometry and diagnostics are one flag away (`compact: false`), and
   * the ref carries the position anyway: acting by ref makes the numbers unnecessary.
   * @param value - the observation value.
   * @param compact - whether to render the short form (default true).
   * @returns the text the model reads.
   */
  /**
   * Render the text block a read carried (8.txt §5 / B1).
   *
   * It is rendered after the rows rather than inside them: the tree already names the
   * controls, and the text is the extra thing this read learned about one of them. The
   * document is spelled out in full up to the budget — a caller that asked for the text
   * and got a 400-character teaser would have paid for a call it cannot use.
   * @param text - the mapped text block.
   * @returns the lines to append to the observation.
   */
  /**
   * Validate the `text_target` argument of a text-carrying read.
   *
   * A ref and a selector are mutually exclusive by construction (8.txt §5): a ref names one
   * element this session actually read, a selector names a rule. Accepting both would mean
   * the backend silently preferring one, which is the kind of substitution a caller only
   * discovers when the wrong control has been read.
   * @param spec - the raw argument.
   * @returns the argument to forward, or undefined when none was given.
   */
  function normalizeTextTarget(spec) {
    if (spec === undefined || spec === null) return undefined;
    if (typeof spec !== 'object' || Array.isArray(spec)) {
      throw new Error('[BAD_REQUEST] text_target must be an object: a `ref`, or an exact selector.');
    }
    if (typeof spec.ref === 'string' && spec.ref.trim() === '') {
      throw new Error('[BAD_REQUEST] text_target.ref was given but is empty; pass a [s#.#] marker from a computer_ui read, or leave text_target out and let the read resolve the target itself.');
    }
    const hasSelector = [spec.automation_id, spec.name, spec.control_type, spec.class_name]
      .some((value) => typeof value === 'string' && value !== '');
    if (typeof spec.ref === 'string' && hasSelector) {
      throw new Error('[BAD_REQUEST] text_target takes either `ref` or a selector, not both: a ref names one element this session already read, a selector names a rule. Pass the ref alone when you have one.');
    }
    if (typeof spec.ref !== 'string' && !hasSelector) {
      throw new Error('[BAD_REQUEST] text_target needs a `ref` or at least one selector (automation_id, name, control_type, class_name).');
    }
    return spec;
  }


  /* ------------------------------------------------------------------ tools -- */

  /* ------------------------------------------------------------------ browser tools -- */

  /**
   * The browser half has its own switch (8.txt §10, C5): a deployment that never drives a
   * browser does not pay for its schema at all, and the session gate above still governs
   * whether a granted session may actually use it.
   */
  const BROWSER_TOOLS_ENABLED = config?.browser !== false;

  /**
   * Whether this host can speak CDP at all (8.txt §10).
   *
   * The browser module runs in this Node host, not through PowerShell, and it needs two
   * globals the desktop half never used. A host without them is not broken: the desktop tools
   * keep working, and the browser tools answer with a capability state instead of failing at
   * the first use.
   */
  const BROWSER_CAPABLE = typeof fetch === 'function' && typeof WebSocket === 'function';
  const BROWSER_CAPABILITY_NOTE = BROWSER_CAPABLE
    ? ''
    : 'this host has no global fetch/WebSocket, so the browser channel cannot run here. The desktop tools are unaffected.';

  /** The endpoint, from the plugin configuration or the environment. Never scanned for. */
  function resolveBrowserEndpoint(sessionKey = '') {
    const configured = String(config?.browserEndpoint ?? process.env.DSH_BROWSER_CDP_ENDPOINT ?? '').trim();
    if (configured !== '') return configured;
    // A browser this session launched through computer_launch with a debugging flag: the one
    // instance the plugin knows the provenance of, so it comes before anything configured just
    // by directory (§10's first endpoint source).
    const managed = managedBrowsers.get(String(sessionKey)) ?? [...managedBrowsers.values()][0];
    if (managed !== undefined) {
      if (managed.endpoint !== '') return managed.endpoint;
      if (managed.profileDir !== '') return endpointFromProfileDir(managed.profileDir) ?? '';
    }
    // The second source a managed browser offers: a Chromium started with a debugging port
    // writes the port it actually chose into `DevToolsActivePort` inside its profile directory,
    // which is how a `--remote-debugging-port=0` browser can be attached to at all (§10). The
    // file is re-read while the endpoint is unset, and the answer is cached only briefly: a
    // profile left over from a browser that has since exited must not keep answering.
    const profileDir = String(config?.browserUserDataDir ?? process.env.DSH_BROWSER_USER_DATA_DIR ?? '').trim();
    if (profileDir === '') return '';
    return endpointFromProfileDir(profileDir) ?? '';
  }

  /** Browsers this plugin launched, by session: `{ endpoint, profileDir, port, pid }`. */
  const managedBrowsers = new Map();

  /** Read the port a browser wrote into its profile directory, briefly cached. */
  function endpointFromProfileDir(profileDir) {
    const cached = endpointFromPortFile;
    if (cached !== null && cached.profileDir === profileDir && Date.now() - cached.at < 2000) return cached.endpoint;
    try {
      const lines = readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
      const port = Number.parseInt(String(lines[0] ?? '').trim(), 10);
      if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error('the port line is not a port');
      const endpoint = `http://127.0.0.1:${port}`;
      endpointFromPortFile = { endpoint, profileDir, at: Date.now() };
      return endpoint;
    } catch {
      endpointFromPortFile = null;
      return null;
    }
  }

  /** The last endpoint read out of a profile's `DevToolsActivePort`, with when it was read. */
  let endpointFromPortFile = null;


  /** Per-session browser state; one connection per session, torn down with the session. */
  const browserSessions = new Map();

  /**
   * The browser session for a tool call, connecting on first use.
   * @param sessionKey - the session id.
   * @param endpoint - the configured endpoint.
   * @returns the BrowserSession.
   */
  async function browserSessionFor(sessionKey, endpoint) {
    const key = `${sessionKey}|${endpoint}`;
    const existing = browserSessions.get(key);
    if (existing !== undefined && existing.connection.connected) return existing;
    if (existing !== undefined) {
      existing.session.dispose();
      browserSessions.delete(key);
    }
    const connection = new CdpConnection({ endpoint });
    await connection.connect();
    const session = new BrowserSession({ connection, sessionKey });
    browserSessions.set(key, { connection, session });
    return { connection, session };
  }

  /** Tear down every browser session of one session id (a stopped session keeps no channel).
   * @returns how many channels were closed.
   */
  function disposeBrowserSessionsFor(sessionKey) {
    managedBrowsers.delete(String(sessionKey));
    let closed = 0;
    for (const [key, entry] of browserSessions) {
      if (!key.startsWith(`${sessionKey}|`)) continue;
      entry.session.dispose();
      entry.connection.close('the session was disposed', 'CDP_SESSION_DISPOSED');
      browserSessions.delete(key);
      closed += 1;
    }
    return closed;
  }

  /**
   * 重构-1：17 个工具注册体搬到 tools/ 一工具一文件。本袋装它们用到的 apply() 闭包依赖
   * ——函数与 Map/对象按引用共享，可变标量 lastLegacyRestartMs 经访问器读写——注册语义、
   * 注册顺序、trace 包裹（defineTracedTool/safeRegister）与原先完全一致。
   */
  const toolEnv = {
    safeRegister, defineTracedTool,
    call, requireGrant, capture, reportAttachment, markObservation, normalizeTextTarget,
    captureService, refs, execution, sessions, metrics, managedBrowsers, revokeSession,
    restartBackend, capabilityForHwnd, capabilityNote, PROFILE_COOLDOWN_MS,
    actionTimeoutMs, shotRoot, ctx,
    BROWSER_CAPABLE, BROWSER_CAPABILITY_NOTE, resolveBrowserEndpoint, browserSessionFor,
    FRAME_RECEIPT_SCHEMA, toLosslessJson,
    getLastLegacyRestartMs: () => lastLegacyRestartMs,
    setLastLegacyRestartMs: (value) => { lastLegacyRestartMs = value; },
  };

  if (BROWSER_TOOLS_ENABLED) {
    registerBrowserState(toolEnv); // 重构-1: 注册体迁出，见 tools/browser-state.mjs

  registerBrowserActions(toolEnv); // 重构-1: 注册体迁出，见 tools/browser-actions.mjs
  }

  registerComputerScreenshot(toolEnv); // 重构-1: 注册体迁出，见 tools/screenshot.mjs


  registerComputerActions(toolEnv); // 重构-1: 注册体迁出，见 tools/actions.mjs

  registerComputerClick(toolEnv); // 重构-1: 注册体迁出，见 tools/click.mjs

  registerComputerDrag(toolEnv); // 重构-1: 注册体迁出，见 tools/drag.mjs

  registerComputerScroll(toolEnv); // 重构-1: 注册体迁出，见 tools/scroll.mjs

  registerComputerType(toolEnv); // 重构-1: 注册体迁出，见 tools/type.mjs

  registerComputerKey(toolEnv); // 重构-1: 注册体迁出，见 tools/key.mjs

  registerComputerWindows(toolEnv); // 重构-1: 注册体迁出，见 tools/windows.mjs

  registerComputerDigest(toolEnv); // 重构-1: 注册体迁出，见 tools/digest.mjs

  registerComputerUi(toolEnv); // 重构-1: 注册体迁出，见 tools/ui.mjs

  registerComputerUiAction(toolEnv); // 重构-1: 注册体迁出，见 tools/ui-action.mjs

  registerComputerClipboard(toolEnv); // 重构-1: 注册体迁出，见 tools/clipboard.mjs

  registerComputerPaste(toolEnv); // 重构-1: 注册体迁出，见 tools/paste.mjs

  registerComputerLaunch(toolEnv); // 重构-1: 注册体迁出，见 tools/launch.mjs

  registerComputerStop(toolEnv); // 重构-1: 注册体迁出，见 tools/stop.mjs

  /* ----------------------------------------------------------------- routes -- */

  /**
   * Current capability snapshot for one Session.
   * @param sessionId - the Session the chip is mounted in.
   * @returns the JSON payload the chip renders.
   */
  const statePayload = (sessionId) => ({
    ok: true,
    plugin: '@k-launcher/dsh-vision-control',
    version: VERSION,
    buildId: release.buildId,
    label: LABEL,
    platform: process.platform,
    supported: SUPPORTED,
    ...SUPPORTED ? {} : { reason: UNSUPPORTED_REASON },
    defaultEnabled,
    // An unsupported platform can never be enabled, whatever the grant says; the
    // chip reads `supported` first and never shows an on state it cannot honour.
    enabled: SUPPORTED && isEnabled(sessionId),
    // What the control is doing, in the states a user has to be able to tell apart:
    // 仅观察 / 可操作 / 执行中 / 停止中 / 已停止 (plus 未开启). A single on/off bit cannot
    // express "stopping", which is exactly the state a user needs to see after pressing
    // stop on something that is mid-batch.
    control: controlState(sessionId),
    backend: backend === null
      ? { started: false }
      : { started: true, alive: backend.alive, outstanding: backend.outstanding, dpi: backend.info?.dpi, screens: backend.info?.screens, generation: backend.info?.generation },
  });

  // The chip's routes need a web server, but the tools must not. Registering
  // through a scoped inject means a profile without one still gets computer
  // control, and a profile that gains or replaces its web server re-registers
  // these routes without restarting the plugin.
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () => scoped.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/status`,
        handler: (req, res) => sendJson(res, 200, { ...statePayload(undefined), runtime: runtimeSummary(), note: 'host half of the 电脑操作 capability is loaded' }),
      }),
      'computer-use: status route',
    );

    scoped.effect(
      () => scoped.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/state`,
        handler: async (req, res) => {
          try {
            // 授权面三件套（优-P0-01）：自定义头 + Origin/Sec-Fetch-Site + 会话归属，
            // 一个不能少——只做其中一两件都留缝。
            const rejection = admitStateRequest(req);
            if (rejection !== null) {
              sendJson(res, rejection.status, { ok: false, error: rejection.message });
              return;
            }
            const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
            if (req.method === 'GET') {
              sendJson(res, 200, statePayload(url.searchParams.get('sessionId') ?? undefined));
              return;
            }
            if (req.method === 'POST') {
              const body = await readJsonBody(req);
              const sessionId = body.sessionId ?? url.searchParams.get('sessionId') ?? undefined;
              if (typeof body.enabled !== 'boolean') {
                sendJson(res, 400, { ok: false, error: 'enabled must be a boolean' });
                return;
              }
              if (sessionId === undefined || sessionId === null || String(sessionId) === '') {
                sendJson(res, 400, { ok: false, error: 'sessionId is required' });
                return;
              }
              // 会话归属：只能翻转一个此刻在本宿主活着的会话。agents 服务缺席时
              // 无法求证，跳过本层（另两层仍然立着），免得在缺服务的组合里把芯片打坏。
              const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
              if (agents !== undefined && typeof agents.get === 'function' && agents.get(String(sessionId)) === undefined) {
                sendJson(res, 403, { ok: false, error: 'sessionId is not a live session of this host' });
                return;
              }
              if (!SUPPORTED && body.enabled === true) {
                sendJson(res, 409, { ok: false, error: UNSUPPORTED_REASON, supported: false });
                return;
              }
              if (body.enabled === true) {
                sessions.grant(sessionId);
                // 新-P1-04：授权是审计生命周期的开账点。
                audit.record(sessionKey(sessionId), { event: 'grant' });
                // Turning it on is also what un-hides the tool schemas for that session.
                // `activate` and not a bare `sync(agentOf(...))`: when no live agent is
                // registered for this session the restriction is lifted anyway. A chip the
                // user has switched on must not be able to leave its tools hidden just
                // because the agent was never registered (see schema-visibility.mjs).
                const visibilityAfter = visibility.activate(sessionKey(sessionId));
                ctx.logger?.info?.('computer-use: session %s grant -> true (schemas %s)', sessionKey(sessionId), SUPPORTED ? visibilityAfter : 'n/a');
                // Turning the capability on is the moment the user has said yes; get
                // the worker ready now rather than inside the model's first click.
                warmBackend();
                sendJson(res, 200, { ...statePayload(sessionId), toolSchemas: SUPPORTED ? visibilityAfter : null });
                return;
              }
              // Turning it off is a stop, not a bookkeeping change: revoke, cancel what is
              // in flight, and unwind what the worker is still holding — and only report
              // the new state once that has actually happened.
              const outcome = await revokeSession(sessionId, 'the user turned 电脑操作 off');
              // …and with the capability off, its schemas stop riding along in every request.
              const visibilityAfter = visibility.deactivate(sessionKey(sessionId));
              ctx.logger?.info?.('computer-use: session %s grant -> false (%d cancelled, %d released)%s', sessionKey(sessionId), outcome.cancelled, outcome.released.length, outcome.error === '' ? '' : `, release failed: ${outcome.error}`);
              sendJson(res, 200, { ...statePayload(sessionId), toolSchemas: SUPPORTED ? visibilityAfter : null, revoked: { cancelled: outcome.cancelled, released: outcome.released, error: outcome.error === '' ? null : outcome.error } });
              return;
            }
            sendJson(res, 405, { ok: false, error: 'use GET or POST' });
          } catch (error) {
            if (error instanceof StateRequestError) {
              sendJson(res, error.status, { ok: false, error: error.message });
              return;
            }
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
      'computer-use: state route',
    );

    scoped.effect(
      () => scoped.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/probe`,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
            const sessionId = url.searchParams.get('sessionId') ?? undefined;
            const instance = await ensureBackend();
            const info = await instance.request('ping', {}, { timeoutMs: startTimeoutMs });
            // The pacing policy and the transport's long-tail counters ride along, because
            // both decide how a call feels and neither is visible from a capture: a policy
            // that still polls for five seconds, and a queue that has been timing out and
            // restarting the worker, look the same from the outside otherwise.
            const pacing = await instance.request('pacing', {}, { timeoutMs: startTimeoutMs }).then((report) => report.after, () => null);
            // §7.4 item 7: the COM boundary's own census. Whether a long session accumulates
            // UI Automation objects is a number here rather than a guess in a comment.
            const health = await instance.request('health', {}, { timeoutMs: startTimeoutMs }).catch(() => null);
            sendJson(res, 200, {
              ok: true,
              enabled: isEnabled(sessionId),
              dpi: info.dpi,
              screens: info.screens,
              virtual: info.virtual,
              cursor: info.cursor,
              pacing,
              comObjects: health?.comObjects ?? null,
              transport: instance.stats ?? null,
              outstanding: instance.outstanding ?? 0,
            });
          } catch (error) {
            sendJson(res, 503, { ok: false, error: backendMessage(error) });
          }
        },
      }),
      'computer-use: backend probe route',
    );

    // 只读自检：不启动 worker、不碰桌面、不改状态，所以用户报告问题的当下就能跑。
    // 它存在的理由见 internal/doctor.mjs 的文件头——这一类故障的特征就是"界面上什么都没有"。
    scoped.effect(
      () => scoped.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/doctor`,
        handler: (req, res) => {
          try {
            const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1');
            const sessionId = url.searchParams.get('sessionId') ?? undefined;
            sendJson(res, 200, {
              ...collectDoctorReport({
                mode: 'host',
                supported: SUPPORTED,
                platform: process.platform,
                version: VERSION,
                packageRoot: PACKAGE_ROOT,
                host,
                release,
                defaultEnabled,
                registrationFailures,
                registeredToolNames,
                schemaVisibility: {
                  enabled: visibility.enabled,
                  liveAgents: visibility.liveAgentCount(),
                  restrictedSessions: visibility.restrictedCount(),
                },
                backend: backend === null
                  ? null
                  : {
                    started: true,
                    alive: backend.alive,
                    generation: backend.info?.generation ?? null,
                    pid: Number(backend.info?.pid ?? 0),
                  },
                hideToolSchemasWhenOff: config.hideToolSchemasWhenOff !== false,
                // 这份报告长在宿主进程里，所以 peer 依赖那一条在这里才是真判定。
                insideHost: true,
              }),
              session: sessionId === undefined
                ? null
                : {
                  sessionId,
                  enabled: SUPPORTED && isEnabled(sessionId),
                  toolSchemas: visibility.toolSchemaState(sessionKey(sessionId)),
                },
            });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
      'computer-use: doctor route',
    );
  });

  /**
   * Drop captures belonging to this process when the plugin unloads. Leaves the
   * directory itself alone — the user may have asked for a screenshot inside the
   * workspace, and deleting a whole directory the plugin does not exclusively own
   * would be rude.
   */
  ctx.effect(() => () => {
    backend?.dispose();
    backend = null;
    // The isolated read worker is a second process this plugin started, so it is a second
    // process this plugin has to stop (A10).
    if (readBackendIdleTimer !== null) {
      clearTimeout(readBackendIdleTimer);
      readBackendIdleTimer = null;
    }
    readBackend?.dispose();
    readBackend = null;
    // §A: free the host-wide ownership slot. A later mount (after a profile change or a test
    // teardown) must be able to claim it instead of being reported as a duplicate forever.
    releaseOwnership();
    void (async () => {
      try {
        // 新-P1-04：先合审计流，再动文件——审计目录在 shotRoot/audit，不在下面被删的
        // instanceRoot 里，所以审计本身不会被这次清理带走。
        await audit.closeAll().catch(() => {});
        // 登记表里的先删 —— 包括"抓完了还没交给任何会话"的残渣。
        await captureService.releaseAll().catch(() => {});
        const { readdir } = await import('node:fs/promises');
        // 兜底：本进程此前产出的、没进登记表的残留。
        const entries = await readdir(shotRoot).catch(() => []);
        await Promise.all(entries
          .filter((entry) => entry.includes(`capture-${process.pid}-`))
          .map((entry) => rm(join(shotRoot, entry), { force: true }).catch(() => {})));
        // worker 落在系统临时目录的关联帧（它拿不到截图目录的那些路径）。
        await releaseStrayFrames({ olderThanMs: 0 });
        // 本实例的标记目录（cancel / held-input 的 flag 文件）。
        await rm(instanceRoot, { recursive: true, force: true }).catch(() => {});
      } catch {
        /* best effort */
      }
    })();
  }, 'computer-use: backend lifetime');
}
