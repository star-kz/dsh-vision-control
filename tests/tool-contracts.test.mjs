/**
 * Task 0B (test-only): contract freezes for internal/tool-contracts.mjs.
 *
 * These tests pin the *public* schema/behavior surface: action lists (order is the
 * contract), value schemas with their required keys, the shot/state render helpers,
 * and the two duplicated toLosslessJson implementations (index.js + see/apply.mjs).
 *
 * The toLosslessJson copies are module-private, so they are extracted from the real
 * source text and evaluated as-is: if either file renames, moves or rewrites the
 * function, these tests fail loudly instead of silently testing a stale copy. That
 * is the point — the plan wants the dual contract frozen BEFORE any dedup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as TC from "../internal/tool-contracts.mjs";
import { STEP_ACTION_LIST, UIA_ACTION_LIST, IDEMPOTENT_COMMANDS, isIdempotentCall } from "../internal/failures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Properties whose schema entry carries required: true, in declaration order. */
function requiredProps(schema) {
  return Object.entries(schema.properties).filter(([, p]) => p && p.required === true).map(([k]) => k);
}

// ---------------------------------------------------------------- action lists

test("STEP_ACTION_LIST is the exact frozen list, order included", () => {
  assert.deepEqual(STEP_ACTION_LIST, [
    "click", "move", "drag", "scroll", "type", "key", "wait", "wait_for", "screenshot", "paste", "focus", "clipboard",
    "invoke", "set_value", "get_value", "get_text", "select_text", "scroll_into_view",
    "toggle", "select", "expand", "collapse",
    "close", "minimize", "maximize", "restore", "legacy_action",
    "click_text", "locate_text", "get_caret",
  ]);
});

test("UIA_ACTION_LIST is STEP_ACTION_LIST without the batch-only steps plus element focus", () => {
  assert.deepEqual(UIA_ACTION_LIST, [
    "invoke", "set_value", "get_value", "get_text", "select_text", "scroll_into_view", "focus",
    "toggle", "select", "expand", "collapse",
    "close", "minimize", "maximize", "restore", "legacy_action",
    "click_text", "locate_text", "get_caret",
  ]);
  const batchOnly = new Set(["click", "move", "drag", "scroll", "type", "key", "wait", "wait_for", "screenshot", "paste", "clipboard"]);
  for (const name of UIA_ACTION_LIST) assert.ok(STEP_ACTION_LIST.includes(name), name + " must exist in STEP_ACTION_LIST");
  for (const name of STEP_ACTION_LIST) {
    if (!batchOnly.has(name)) assert.ok(UIA_ACTION_LIST.includes(name), name + " missing from UIA_ACTION_LIST");
  }
});

test("IDEMPOTENT_COMMANDS keeps frameproject/frameattach and read-only commands; anything else is non-idempotent", () => {
  assert.equal(IDEMPOTENT_COMMANDS.has("frameproject"), true);
  assert.equal(IDEMPOTENT_COMMANDS.has("frameattach"), true);
  assert.equal(IDEMPOTENT_COMMANDS.has("ping"), true);
  assert.equal(isIdempotentCall("frameproject", {}), true);
  assert.equal(isIdempotentCall("screenshot", {}), true);
  assert.equal(isIdempotentCall("click", {}), false, "a click is never safe to replay blind");
  assert.equal(isIdempotentCall("type", { text: "x" }), false);
});

// ---------------------------------------------------------------- schema freezes

test("IMAGE_VALUE_SCHEMA: required keys (per-prop flags) and the mediaType enum", () => {
  assert.equal(TC.IMAGE_VALUE_SCHEMA.required, undefined, "image schema marks required per property, not top-level");
  assert.deepEqual(requiredProps(TC.IMAGE_VALUE_SCHEMA), ["attachmentId", "mediaType", "bytes", "width", "height"]);
  assert.deepEqual(TC.IMAGE_VALUE_SCHEMA.properties.mediaType.enum, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  assert.deepEqual(Object.keys(TC.IMAGE_VALUE_SCHEMA.properties).sort(), ["attachmentId", "bytes", "height", "mediaType", "name", "originalDimensions", "width"]);
  assert.deepEqual(Object.keys(TC.IMAGE_VALUE_SCHEMA.properties.originalDimensions.properties), ["width", "height"]);
});

test("SCREENSHOT_VALUE_SCHEMA: closed object, required keys frozen", () => {
  assert.equal(TC.SCREENSHOT_VALUE_SCHEMA.type, "object");
  assert.equal(TC.SCREENSHOT_VALUE_SCHEMA.additionalProperties, false);
  assert.deepEqual(requiredProps(TC.SCREENSHOT_VALUE_SCHEMA), [
    "path", "width", "height", "imageWidth", "imageHeight", "scale", "format", "bytes",
    "x", "y", "displays", "cursor", "activeWindow",
  ]);
  assert.deepEqual(requiredProps(TC.SCREENSHOT_VALUE_SCHEMA.properties.cursor), ["x", "y"]);
});

test("UIA_STATE_SCHEMA: required keys incl. window/nodes/skipped; frames rows carry projection geometry", () => {
  assert.deepEqual(requiredProps(TC.UIA_STATE_SCHEMA), [
    "window", "nodes", "truncated", "searched", "mode", "digest", "walked", "skipped",
  ]);
  const frameItem = TC.UIA_STATE_SCHEMA.properties.frames.items;
  assert.deepEqual(requiredProps(frameItem), ["frame", "windowHwnd", "relation", "x", "y", "width", "height", "path"]);
  assert.ok(frameItem.properties.relation.description.includes("self"));
  assert.ok(frameItem.properties.relation.description.includes("owned-popup"));
  // the read window, the text observation and the OCR block all ride the same state
  assert.equal(TC.UIA_STATE_SCHEMA.properties.shot, TC.SCREENSHOT_VALUE_SCHEMA);
});

test("WAIT_CONDITION_SCHEMA: kind/is enums and the rect sub-schema", () => {
  const w = TC.WAIT_CONDITION_SCHEMA;
  assert.equal(w.additionalProperties, false);
  assert.deepEqual(w.properties.kind.enum, ["window", "control", "value", "text", "file", "region", "every", "any"]);
  assert.deepEqual(w.properties.is.enum, ["present", "absent", "not"]);
  assert.deepEqual(w.properties.match.enum, ["contains", "exact", "equals", "matches", "empty"]);
  assert.deepEqual(requiredProps(w.properties.rect), ["x", "y", "width", "height"]);
  assert.deepEqual(w.properties.mode.enum, ["stable", "changed", "matches"]);
});

test("BATCH_STEP_SCHEMA action enum is exactly STEP_ACTION_LIST; batch value freezes its step log keys", () => {
  assert.deepEqual(TC.BATCH_STEP_SCHEMA.properties.action.enum, STEP_ACTION_LIST);
  assert.equal(TC.BATCH_STEP_SCHEMA.properties.action.required, true);
  assert.deepEqual(requiredProps(TC.BATCH_VALUE_SCHEMA), ["performed", "count", "failedAt"]);
});

// ------------------------------------------- frames schema: mutation / isolation

test("FRAME_ITEM_PROPERTIES shares its nested property objects with SCREENSHOT_VALUE_SCHEMA (documented cross-talk)", () => {
  // Current production shape: FRAME_ITEM_PROPERTIES is a shallow spread, so the nested
  // schema objects are the SAME objects. Any later split must be a deliberate,
  // compatibility-checked change — which is exactly what this test forces.
  assert.ok(TC.FRAME_ITEM_PROPERTIES.path === TC.SCREENSHOT_VALUE_SCHEMA.properties.path,
    "the path property schema object is shared between the frames item and the screenshot value");
  assert.ok(TC.FRAME_ITEM_PROPERTIES.cursor === TC.SCREENSHOT_VALUE_SCHEMA.properties.cursor);

  // mutating through one alias is visible through the other — frozen current behavior
  const before = TC.SCREENSHOT_VALUE_SCHEMA.properties.path.type;
  TC.FRAME_ITEM_PROPERTIES.path.type = "mutated-by-test";
  assert.equal(TC.SCREENSHOT_VALUE_SCHEMA.properties.path.type, "mutated-by-test");
  // restore, and prove the restore landed
  TC.FRAME_ITEM_PROPERTIES.path.type = before;
  assert.equal(TC.SCREENSHOT_VALUE_SCHEMA.properties.path.type, before);
});

test("FRAME_ITEM_PROPERTIES top level is a distinct object: added keys do not leak into SCREENSHOT_VALUE_SCHEMA", () => {
  const probe = "__mutation_probe__";
  const before = Object.keys(TC.FRAME_ITEM_PROPERTIES).length;
  TC.FRAME_ITEM_PROPERTIES[probe] = { type: "string" };
  assert.equal(TC.SCREENSHOT_VALUE_SCHEMA.properties[probe], undefined,
    "a frames-item-only addition must not appear in the screenshot value schema");
  delete TC.FRAME_ITEM_PROPERTIES[probe];
  assert.equal(Object.keys(TC.FRAME_ITEM_PROPERTIES).length, before);
});

// ---------------------------------------------------------------- toLosslessJson

/**
 * Extract the module-private toLosslessJson from real source text and evaluate it.
 * The regex is anchored on the exact declaration; a rewrite that changes the shape
 * (rename, shared helper extraction, parameter change) must fail here, not silently.
 */
function extractToLosslessJson(relPath) {
  const src = readFileSync(join(ROOT, relPath), "utf8");
  const m = src.match(/function toLosslessJson\(value\) \{[\s\S]*?\n\}/);
  assert.ok(m, "toLosslessJson source not found in " + relPath + " — the dual contract changed shape");
  return (0, eval)("(0," + m[0] + ")");
}

const COPIES = [
  ["index.js", extractToLosslessJson("index.js")],
  ["see/apply.mjs", extractToLosslessJson("see/apply.mjs")],
];

for (const [name, fn] of COPIES) {
  test(`toLosslessJson (${name}): undefined, null and non-finite numbers become null`, () => {
    assert.equal(fn(undefined), null);
    assert.equal(fn(null), null);
    assert.equal(fn(NaN), null);
    assert.equal(fn(Infinity), null);
    assert.equal(fn(-Infinity), null);
    assert.equal(fn(1e309), null, "overflowed numbers must not stringify to null-as-JSON-error later");
  });

  test(`toLosslessJson (${name}): safe values pass through losslessly`, () => {
    assert.equal(fn(0), 0);
    // -0 is a finite number and passes through untouched (Object.is distinguishes it);
    // JSON.stringify renders both zeros as "0", so this is lossless, not a leak.
    assert.ok(Object.is(fn(-0), -0));
    assert.equal(fn(1.5), 1.5);
    assert.equal(fn(-42), -42);
    assert.equal(fn(1e15), 1e15);
    assert.equal(fn("text"), "text");
    assert.equal(fn(""), "");
    assert.equal(fn(true), true);
    assert.equal(fn(false), false);
  });

  test(`toLosslessJson (${name}): bigint becomes a number`, () => {
    assert.equal(fn(10n), 10);
    assert.deepEqual(fn([1n, 2n]), [1, 2]);
    assert.deepEqual(fn({ big: 7n }), { big: 7 });
  });

  test(`toLosslessJson (${name}): undefined nested in objects/arrays becomes null`, () => {
    assert.deepEqual(fn({ a: undefined, b: 1 }), { a: null, b: 1 });
    assert.deepEqual(fn([undefined, 2]), [null, 2]);
    assert.deepEqual(fn({ a: { b: undefined } }), { a: { b: null } });
    assert.deepEqual(fn({ a: [null, undefined] }), { a: [null, null] });
  });

  test(`toLosslessJson (${name}): arrays and nested objects survive a JSON round-trip`, () => {
    const input = { n: 1, s: "x", arr: [1, "y", null, { z: NaN, keep: true }], big: 7n, inner: { deep: [2] } };
    const out = fn(input);
    const round = JSON.parse(JSON.stringify(out));
    assert.deepEqual(round, { n: 1, s: "x", arr: [1, "y", null, { z: null, keep: true }], big: 7, inner: { deep: [2] } });
    assert.notEqual(out, input, "objects are copied, not passed through");
    assert.notEqual(out.arr, input.arr);
  });

  test(`toLosslessJson (${name}): a cycle throws instead of hanging the host`, () => {
    const a = { self: null };
    a.self = a;
    assert.throws(() => fn(a), RangeError, "unbounded recursion must surface as a stack overflow, never silence");
  });
}

test("the two toLosslessJson copies behave identically on a shared matrix", () => {
  const [_, a] = COPIES[0];
  const [__, b] = COPIES[1];
  const matrix = [
    undefined, null, 0, -1, 1.25, NaN, Infinity, 1e309, "s", "", true, 3n,
    [1, undefined, "x"], { a: undefined }, { a: { b: NaN } }, [], {},
  ];
  for (const v of matrix) {
    assert.deepEqual(b(v), a(v), "the see/apply.mjs copy diverged from index.js on " + JSON.stringify(String(v)));
  }
});

// ---------------------------------------------------------------- render helpers

test("formatDisplays: one line per screen, [primary] marker, newline-joined", () => {
  assert.equal(TC.formatDisplays([{ index: 0, deviceName: "D1", width: 2560, height: 1600, x: 0, y: 0, primary: true }]),
    "#0 D1 2560x1600 at (0,0) [primary]");
  assert.equal(TC.formatDisplays([{ index: 1, deviceName: "D2", width: 1920, height: 1080, x: 2560, y: 0 }]),
    "#1 D2 1920x1080 at (2560,0)");
  assert.equal(TC.formatDisplays([{ index: 0, deviceName: "A", width: 1, height: 2, x: 0, y: 0, primary: true }, { index: 1, deviceName: "B", width: 3, height: 4, x: 5, y: 6 }]),
    "#0 A 1x2 at (0,0) [primary]\n#1 B 3x4 at (5,6)");
  assert.equal(TC.formatDisplays(undefined), "");
  assert.equal(TC.formatDisplays([]), "");
});

test("stabilityValue: copies only valid fields, drops the rest, undefined when empty", () => {
  assert.equal(TC.stabilityValue(undefined), undefined);
  assert.equal(TC.stabilityValue(null), undefined);
  assert.equal(TC.stabilityValue({}), undefined);
  assert.equal(TC.stabilityValue({ state: "", polls: "x", width: 0, height: -1 }), undefined);
  assert.deepEqual(TC.stabilityValue({ state: "timeout", polls: 3, waitedMs: 120, budgetMs: 500, note: "n" }),
    { state: "timeout", polls: 3, waitedMs: 120, budgetMs: 500, note: "n" });
  assert.deepEqual(TC.stabilityValue({ state: "", polls: "x", width: 0, height: 100, stable: true }),
    { height: 100, stable: true }, "invalid fields are dropped individually, not wholesale");
  assert.deepEqual(TC.stabilityValue({ conflict: "stability_ms vs stable", sampled: "poll" }),
    { conflict: "stability_ms vs stable", sampled: "poll" });
  assert.deepEqual(TC.stabilityValue({ state: "stable", stable: false, pollMs: 1.5 }),
    { state: "stable", stable: false, pollMs: 1.5 });
  assert.equal(TC.stabilityValue({ resolvedBy: "", note: "" }), undefined);
});

test("captureTiming: rounding, always-present keys, optional keys only when >0", () => {
  assert.deepEqual(TC.captureTiming({}), { captureMs: 0, admitMs: 0 });
  assert.deepEqual(TC.captureTiming({ captureMs: 1.4, admitMs: 2.6 }), { captureMs: 1, admitMs: 3 });
  const t = TC.captureTiming({ queueMs: 5, startMs: 0, shot: { timing: { totalMs: 12.4, settleMs: 3, pollMs: 0, polls: 0 } } });
  assert.equal(t.queueMs, 5);
  assert.equal(t.startMs, undefined, "startMs must be positive to be worth reporting");
  assert.equal(t.backendMs, 12.4);
  assert.equal(t.settleMs, 3);
  assert.equal(t.pollMs, undefined);
  assert.equal(t.polls, undefined);
  const t2 = TC.captureTiming({ shot: { timing: { totalMs: 5, settleMs: 0, pollMs: 2, polls: 4 } } });
  assert.equal(t2.settleMs, undefined);
  assert.equal(t2.pollMs, 2);
  assert.equal(t2.polls, 4);
});

const SHOT_BASE = {
  path: "p.png", x: 10, y: 20, width: 100, height: 50, bytes: 12,
  screens: [{ index: 0, deviceName: "D1", width: 640, height: 480, x: 0, y: 0, primary: true }],
  cursor: { x: 5, y: 6 }, foreground: { title: "T" },
};

test("shotValue: required fields, format fallback, display formatting, foreground title", () => {
  const v = TC.shotValue(SHOT_BASE, {});
  assert.equal(v.path, "p.png");
  assert.equal(v.x, 10);
  assert.equal(v.y, 20);
  assert.equal(v.width, 100);
  assert.equal(v.height, 50);
  assert.equal(v.imageWidth, 100);
  assert.equal(v.imageHeight, 50);
  assert.equal(v.scale, 1);
  assert.equal(v.format, "png");
  assert.equal(v.bytes, 12);
  assert.deepEqual(v.cursor, { x: 5, y: 6 });
  assert.equal(v.activeWindow, "T");
  assert.equal(v.displays, "#0 D1 640x480 at (0,0) [primary]");
});

test("shotValue: encoded size wins; otherwise image size scales the screen region", () => {
  const encoded = TC.shotValue({ ...SHOT_BASE, encodedWidth: 80, encodedHeight: 40 }, {});
  assert.equal(encoded.imageWidth, 80);
  assert.equal(encoded.imageHeight, 40);
  const scaled = TC.shotValue({ ...SHOT_BASE, effectiveScale: 0.5 }, {});
  assert.equal(scaled.imageWidth, 50);
  assert.equal(scaled.imageHeight, 25);
  assert.equal(scaled.scale, 0.5);
  const viaScale = TC.shotValue({ ...SHOT_BASE, scale: 2 }, {});
  assert.equal(viaScale.imageWidth, 200);
  assert.equal(viaScale.imageHeight, 100);
  assert.equal(viaScale.scale, 2);
});

test("shotValue: crop is reported except when it is the whole surface", () => {
  const surface = { kind: "screen", x: 0, y: 0, width: 640, height: 480 };
  const whole = TC.shotValue({ ...SHOT_BASE, surface, cropRectSurface: { x: 0, y: 0, width: 640, height: 480 } }, {});
  assert.equal(whole.crop, undefined, "a whole-surface crop is not a crop");
  const part = TC.shotValue({ ...SHOT_BASE, surface, cropRectSurface: { x: 10, y: 20, width: 100, height: 50 } }, {});
  assert.deepEqual(part.crop, { x: 10, y: 20, width: 100, height: 50 });
});

test("shotValue: requested scale only when it differs, stability rides along", () => {
  const asked = TC.shotValue({ ...SHOT_BASE, requestedScale: 1.25 }, {});
  assert.equal(asked.scaleRequested, 1.25);
  assert.equal(asked.scaleEffective, 1);
  const sameScale = TC.shotValue({ ...SHOT_BASE, requestedScale: 1.00001 }, {});
  assert.equal(sameScale.scaleRequested, undefined, "a 1e-5 difference is rounding noise, not a rescale");
  const stable = TC.shotValue({ ...SHOT_BASE, stability: { state: "stable", stable: true } }, {});
  assert.equal(stable.stable, true);
  assert.deepEqual(stable.stability, { state: "stable", stable: true });
  const garbage = TC.shotValue({ ...SHOT_BASE, stability: { state: "", polls: "x" } }, {});
  assert.equal(garbage.stability, undefined);
});

test("shotValue: admitted flags spread into the value (unchanged/reused)", () => {
  const v = TC.shotValue(SHOT_BASE, { unchanged: true, reused: false });
  assert.equal(v.unchanged, true);
  assert.equal(v.reused, false);
});

test("renderState: no nodes names the window and the why", () => {
  const base = { window: { hwnd: 0, title: "", process: "", pid: 0 }, nodes: [], searched: false, walked: 0, truncated: false, skipped: 0 };
  let out = TC.renderState({ ...base });
  assert.ok(out.startsWith("No UI Automation nodes matched.\nwindow: no window resolved"), out);
  const w = { ...base, window: { hwnd: 123, title: "T", process: "P", pid: 45 } };
  out = TC.renderState({ ...w, searched: true });
  assert.ok(out.startsWith("No UI Automation node matched the search.\nwindow: hwnd=123 \"T\" [P] pid=45"), out);
});

test("renderState: a delta with no rows says nothing changed", () => {
  const w = { window: { hwnd: 7, title: "X", process: "Y", pid: 8 }, nodes: [], searched: false, walked: 4, truncated: false, skipped: 0,
    delta: { known: true, base: "snap1", same: 4, added: 0, moved: 0, altered: 0, removed: 0 } };
  const out = TC.renderState(w);
  assert.ok(out.startsWith("delta against snap1: nothing changed (4 node(s) identical).\nwindow: hwnd=7"), out);
});

test("renderState: one bare node with walked<=1 reads as no-children, with the advice", () => {
  const w = { window: { hwnd: 5, title: "X", process: "Y", pid: 6 }, searched: false, walked: 1, truncated: false, skipped: 0,
    nodes: [{ depth: 0, controlType: "ControlType.Pane", name: "X", patterns: [], enabled: true, offscreen: false, width: 0, height: 0, x: 0, y: 0 }] };
  const out = TC.renderState(w);
  assert.ok(out.startsWith("window: hwnd=5"), out);
  assert.ok(out.includes("the window exposed no child controls."), out);
});

test("renderState: node rows carry ref, stripped type, name, automationId, patterns; compact note present", () => {
  const w = { window: { hwnd: 1, title: "W", process: "P", pid: 2 }, searched: false, walked: 5, truncated: false, skipped: 0,
    nodes: [{ depth: 0, ref: "s1#3", controlType: "ControlType.Button", name: "OK", automationId: "okBtn", patterns: ["Invoke", "Toggle"], enabled: true, offscreen: false, width: 0, height: 0, x: 0, y: 0 }] };
  const out = TC.renderState(w);
  assert.ok(out.startsWith("1 node(s):"), out);
  assert.ok(out.includes("[s1#3] Button \"OK\" #okBtn [Invoke,Toggle]"), out);
  assert.ok(out.includes("(compact view: rows carry the ref, type, name and patterns."), out);
  assert.ok(out.includes("(the [s#.#] marker is that node"), out);
});

test("renderState: depth indentation, repeated marker, compact geometry without ref, disabled/offscreen", () => {
  const w = { window: { hwnd: 1, title: "W", process: "P", pid: 2 }, searched: true, walked: 9, truncated: false, skipped: 0,
    nodes: [
      { depth: 1, controlType: "ControlType.Text", name: "A", patterns: [], enabled: false, offscreen: true, width: 10, height: 10, x: 0, y: 0, repeated: 3 },
    ] };
  const out = TC.renderState(w);
  assert.ok(out.startsWith("1 matching node(s):"), out);
  assert.ok(out.includes("  Text \"A\" ×3 similar centre=(5,5) (disabled) (offscreen)"), out);
});

test("renderState: full (non-compact) rows carry centre geometry and the omitted/pruned notes", () => {
  const w = { window: { hwnd: 1, title: "W", process: "P", pid: 2 }, searched: false, walked: 5, truncated: false, skipped: 2, pruned: 1, cachePatterns: 0,
    nodes: [
      { depth: 0, ref: "s1#1", controlType: "ControlType.Button", name: "B", patterns: ["Invoke"], enabled: true, offscreen: false, width: 20, height: 10, x: 100, y: 200 },
    ] };
  const out = TC.renderState(w, false);
  assert.ok(out.includes("[s1#1] Button \"B\" centre=(110,205) [Invoke]"), out);
  assert.ok(out.includes("(2 anonymous container node(s) omitted"), out);
  assert.ok(out.includes("(1 row(s) of scaffolding"), out);
  assert.ok(out.includes("patterns: false"), out);
  assert.ok(!out.includes("compact view"), out);
});