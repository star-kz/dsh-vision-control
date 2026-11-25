/**
 * Task 0B (test-only): focused compatibility tests for the realtime watch layer (see/apply.mjs)
 * and the from_frame ownership boundary it depends on (internal/refs.mjs).
 *
 * What is frozen here:
 *   - sheetRegionLines: the per-image safety text every region sheet carries (exact lines).
 *   - the computer_watch tool contract: name, parameter set, output schema (lossless text/image/meta),
 *     timeout, single-flight semantics, and that the session grant gate is the first thing execute asks.
 *   - status / stop / peek queue-empty: the read-only actions answer without touching the screen.
 *   - the from_frame prohibition, enforced where it actually bites: a frame id this conversation was
 *     never shown is refused by the host registry — watch sheets are never registered with noteFrame,
 *     so their ids can never satisfy computer_click's from_frame check.
 *
 * No real watch run is started here (that spawns an ffmpeg capture); the blocking action's
 * seconds clamp (min 2, max 860, default 300) is enforced inside that path and is frozen by
 * the parameter contract plus the MAX_BLOCK_SEC derivation, not by driving a capture.
 * applySeeNow does not pre-capture at registration; capture begins only after an authorized observation call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetRegionLines, applySeeNow, createWatchRuntimeFacade } from "../see/apply.mjs";
import { createRefRegistry } from "../internal/refs.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// ------------------------------------------------------------- sheetRegionLines

test("sheetRegionLines: no origin means no region lines; an origin means exactly the two safety lines", () => {
  assert.deepEqual(sheetRegionLines(undefined), []);
  assert.deepEqual(sheetRegionLines({}), []);
  assert.deepEqual(sheetRegionLines({ origin: null }), []);
  const lines = sheetRegionLines({ origin: { x: 100, y: 50, w: 640, h: 360 } });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "区域订阅：本图只覆盖屏幕矩形 原点=(100,50)、大小=640×360（屏幕绝对坐标系）——区域外发生什么本工具完全看不见。");
  assert.equal(lines[1], "区域坐标换算：逐格公式里的\"屏幕宽/高\"用区域宽 640、高 360 代入，算出的 (sx,sy) 再加 (100,50) 才是屏幕绝对坐标。");
});

test("watch facade isolates session data and only its owner can stop capture", () => {
  let running = true;
  let stops = 0;
  const runner = {
    status: () => ({ running, source: { kind: "screen" }, since: 12 }),
    stop: () => { stops += 1; running = false; return { stopped: true }; },
  };
  const facade = createWatchRuntimeFacade(runner);
  facade.subscribe("A");
  assert.throws(() => facade.subscribe("B"), /another session/);
  assert.equal(facade.status("A").running, true);
  assert.equal(facade.status("B").running, false);
  facade.stop("B");
  assert.equal(stops, 0, "B must not stop A's capture");
  assert.equal(facade.status("A").running, true);
  facade.stop("A");
  assert.equal(stops, 1, "owner stops the physical capture");
  running = true;
  facade.subscribe("C");
  assert.equal(facade.status("A").running, false, "stale A cannot inherit C's later capture");
  assert.equal(facade.status("C").running, true);
});

// ------------------------------------------------------ computer_watch contract

function mountWatch() {
  const disposals = [];
  const ctx = {
    on: (event, fn) => { if (event === "dispose") disposals.push(fn); },
    get: () => undefined,
    logger: { info() {} },
  };
  let captured = null;
  const grants = [];
  const registerTool = (def) => { captured = def; };
  const defineTool = (def) => def;
  const requireGrant = (exec) => { grants.push(exec); };
  applySeeNow(ctx, { registerTool, defineTool, requireGrant });
  return { captured, disposals, grants };
}

test("computer_watch: registration shape — name, parameters, output schema, timeout, single flight", () => {
  const { captured } = mountWatch();
  assert.ok(captured, "the tool is registered through registerTool(defineTool(...))");
  assert.equal(captured.name, "computer_watch");
  assert.deepEqual(
    Object.keys(captured.parameters).sort(),
    ["action", "minFrames", "pace", "path", "quality", "realtime", "region", "scene", "seconds", "source"],
  );
  assert.deepEqual(captured.output.schema, {
    type: "object",
    additionalProperties: false,
    properties: {
      text: { type: "string", required: true },
      image: { type: "json" },
      meta: { type: "json" },
    },
  });
  assert.equal(captured.timeoutMs, 900_000, "the tool outlives the longest legal watch block");
  assert.equal(captured.isConcurrencySafe(), false, "one capture process — never concurrent");
});

test("computer_watch: the render blocks are the image first, then the text", () => {
  const { captured } = mountWatch();
  const withImage = captured.output.render({}, { image: { attachmentId: "a" }, text: "hello" });
  assert.deepEqual(withImage, [
    { type: "image", attachment: { attachmentId: "a" } },
    { type: "text", text: "hello" },
  ]);
  const withoutImage = captured.output.render({}, { image: null, text: "hello" });
  assert.deepEqual(withoutImage, [{ type: "text", text: "hello" }]);
});

test("computer_watch: execute asks the session grant gate first, before anything else", async () => {
  const ctx = {
    on: () => {},
    get: () => undefined,
    logger: { info() {} },
  };
  let captured = null;
  applySeeNow(ctx, {
    registerTool: (def) => { captured = def; },
    defineTool: (def) => def,
    requireGrant: () => { throw new Error("the 电脑操作 chip is off for this session"); },
  });
  await assert.rejects(
    () => captured.execute({ action: "status" }, {}),
    /the 电脑操作 chip is off for this session/,
  );
});

test("computer_watch: status answers a lossless text/image=null/meta object without touching the screen", async () => {
  const { captured, grants } = mountWatch();
  const out = await captured.execute({ action: "status" }, { session: "probe" });
  assert.equal(out.image, null);
  assert.deepEqual(out.meta, { action: "status" });
  const status = JSON.parse(out.text);
  assert.equal(typeof status, "object");
  assert.equal(grants.length, 1, "the grant gate ran exactly once");
});

test("computer_watch: stop is idempotent-ish and reports the teardown result as text", async () => {
  const { captured } = mountWatch();
  const out = await captured.execute({ action: "stop" }, {});
  assert.equal(out.image, null);
  assert.deepEqual(out.meta, { action: "stop" });
  assert.ok(out.text.startsWith("采集已停止。"), out.text);
  assert.equal(typeof JSON.parse(out.text.slice("采集已停止。".length)), "object");
});

test("computer_watch: peek on an empty queue says so instead of blocking", async () => {
  const { captured } = mountWatch();
  const out = await captured.execute({ action: "peek" }, {});
  assert.equal(out.image, null);
  assert.deepEqual(out.meta, { action: "peek" });
  assert.equal(out.text, "队列里还没有图（采集可能刚开或屏幕一直静止）。用 watch 等一张。");
});

test("computer_watch: another session cannot peek the owner's frames and registration does not preheat", async () => {
  let captured;
  let finishWatch;
  let peekCalls = 0;
  let preheatCalls = 0;
  let running = false;
  const runner = {
    status: () => ({ running, source: { kind: "screen" }, since: 1 }),
    watch: () => { running = true; return new Promise((resolve) => { finishWatch = resolve; }); },
    peek: () => { peekCalls += 1; return { why: "secret" }; },
    stop: () => { running = false; finishWatch?.({ ok: false, reason: "cancelled", waited: 0 }); return { stopped: true }; },
    dropped: () => 0,
    preheat: () => { preheatCalls += 1; },
  };
  applySeeNow({ on: () => {}, get: () => undefined, logger: { info() {} } }, {
    registerTool: (def) => { captured = def; }, defineTool: (def) => def,
    requireObservation: () => {}, runnerFactory: () => runner,
  });
  assert.equal(preheatCalls, 0);
  const ownerWatch = captured.execute({ action: "watch", seconds: 2 }, { agent: { session: { id: "A" } } });
  await new Promise((resolve) => setImmediate(resolve));
  const other = await captured.execute({ action: "peek" }, { agent: { session: { id: "B" } } });
  assert.equal(other.image, null);
  assert.equal(peekCalls, 0, "B must not read A's screen or file frame");
  await assert.rejects(
    captured.execute({ action: "watch", seconds: 2 }, { agent: { session: { id: "B" } } }),
    /another session/,
  );
  await captured.execute({ action: "stop" }, { agent: { session: { id: "A" } } });
  await ownerWatch;
});

test("computer_watch: the dispose hook tears the runner down without throwing", () => {
  const { disposals } = mountWatch();
  assert.equal(disposals.length, 1);
  assert.doesNotThrow(() => disposals[0]());
});

test("see/apply.mjs source: every sheet text still carries the from_frame prohibition sentence", () => {
  // source-text freeze (the sentence lives in the private sheetText; its enforcement is the
  // refs registry tested below): watch images must be converted to absolute coordinates, not cited.
  const src = readFileSync(new URL("../see/apply.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("本工具的图不能用 computer_click 的 from_frame 引用——用换算后的绝对坐标。"));
});

// ------------------------------------------------- from_frame ownership boundary

test("frame ownership: a frame this conversation was shown passes; one it was not is refused", () => {
  const refs = createRefRegistry({ generationOf: () => "g1" });
  // watch never calls noteFrame — only computer_screenshot's captured frames get registered.
  // model the scenario: session A was shown a real capture frame...
  refs.noteFrame("A", "f12ab");
  assert.doesNotThrow(() => refs.assertFrameOwnership("A", "f12ab"));
  // ...and then tries to cite a watch sheet's cell as a frame.
  assert.throws(
    () => refs.assertFrameOwnership("A", "watch-sheet-cell-3"),
    (e) => e.message === "[EXPIRED_FRAME] frame 'watch-sheet-cell-3' was not shown to this conversation — it belongs to a capture another conversation took (the worker is shared, the pixels are not). Take a capture here and cite the frame it returns. (action_sent=false, recovery=computer_screenshot)",
  );
  // a session with no record at all passes through: the host cannot confirm, the worker will refuse
  assert.doesNotThrow(() => refs.assertFrameOwnership("B", "f12ab"), "the empty registry defers to the worker's own registry");
  // non-string / empty ids are simply not the registry's business
  assert.doesNotThrow(() => refs.assertFrameOwnership("A", ""));
  assert.doesNotThrow(() => refs.assertFrameOwnership("A", undefined));
});

test("frame ownership: eviction turns refusal into cannot-confirm instead of not-yours", () => {
  const refs = createRefRegistry({ generationOf: () => "g1" });
  for (let i = 0; i < 4097; i++) refs.noteFrame("long", "f" + i);
  assert.doesNotThrow(() => refs.assertFrameOwnership("long", "f4096"));
  assert.throws(
    () => refs.assertFrameOwnership("long", "f0"),
    (e) => e.message === "[EXPIRED_FRAME] frame 'f0' cannot be confirmed as one this conversation was shown: it has been shown more frames than the host keeps an ownership record for. Take a fresh capture here and cite the frame it returns. (action_sent=false, recovery=computer_screenshot)",
  );
});

test("ref ownership: only refs minted by the current worker are judged here; old ones defer to the worker", () => {
  const refs = createRefRegistry({ generationOf: () => "7" });
  // not minted by this worker → not the host's call
  assert.doesNotThrow(() => refs.assertRefOwnership("A", "s6.4"));
  // no worker generation → nothing to check
  const noWorker = createRefRegistry({ generationOf: () => "" });
  assert.doesNotThrow(() => noWorker.assertRefOwnership("A", "s7.4"));
  // this worker's ref, never shown to this session
  assert.throws(
    () => refs.assertRefOwnership("A", "s7.12"),
    (e) => e.message === "[STALE_REF] ref 's7.12' names the observation s7, which this conversation was never shown — it belongs to another session's read. Read the window again with computer_ui and use a ref from that read. (action_sent=false, element_lookup=not_found, recovery=computer_ui)",
  );
  refs.noteSnapshot("A", "s7");
  assert.doesNotThrow(() => refs.assertRefOwnership("A", "s7.12"));
});
