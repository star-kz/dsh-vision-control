/**
 * Task 0B (test-only): behavior freeze for internal/schema-visibility.mjs.
 *
 * Covers the tool-schema visibility lifecycle (hide on grant loss, lift on re-grant,
 * release on session end) and the exact public strings the host sees. All agents here
 * are plain fakes — nothing touches a real session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSchemaVisibility, HIDEABLE_TOOL_NAMES } from "../internal/schema-visibility.mjs";
import {
  ALL_MANAGED_TOOL_NAMES,
  CONTROL_ONLY_TOOL_NAMES,
  WATCH_TOOL_NAMES,
} from "../internal/modes.mjs";

const HIDEABLE = [...ALL_MANAGED_TOOL_NAMES];

test("HIDEABLE_TOOL_NAMES is the exact 29-name managed list", () => {
  assert.deepEqual(HIDEABLE_TOOL_NAMES, HIDEABLE);
  assert.equal(HIDEABLE.length, 29);
});

/** A fake tools service: restrict() returns a FUNCTION (the cordis disposable form). */
function makeTools({ enforceDeny = false } = {}) {
  const lifted = [];
  const restricted = [];
  const events = [];
  const activeDenied = new Set();
  const denyReferences = new Map();
  return {
    lifted,
    restricted,
    events,
    activeDenied,
    get(name, scope) { return enforceDeny && activeDenied.has(name) ? undefined : { name, scope }; },
    restrict({ deny }) {
      const snapshot = [...deny];
      restricted.push(snapshot);
      events.push({ type: "restrict", deny: snapshot });
      for (const name of snapshot) {
        denyReferences.set(name, (denyReferences.get(name) ?? 0) + 1);
        activeDenied.add(name);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        lifted.push(snapshot);
        events.push({ type: "lift", deny: snapshot });
        for (const name of snapshot) {
          const count = (denyReferences.get(name) ?? 1) - 1;
          if (count <= 0) { denyReferences.delete(name); activeDenied.delete(name); }
          else denyReferences.set(name, count);
        }
      };
    },
  };
}

function makeAgent(tools, sessionId) {
  return { ctx: { tools }, session: sessionId === undefined ? undefined : { id: sessionId } };
}

test("sync: disabled feature reports advertised; toolSchemaState says advertised-by-config", () => {
  const sv = createSchemaVisibility({ enabled: false, isEnabled: () => false });
  const tools = makeTools();
  const agent = makeAgent(tools, 1);
  assert.equal(sv.sync(agent), "advertised");
  assert.equal(sv.toolSchemaState(1), "advertised-by-config");
  assert.equal(tools.restricted.length, 0, "nothing is hidden while the feature is off");
});

test("sync: grant present → visible; grant lost → hidden via restrict, then lifted again on re-grant", () => {
  let granted = true;
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => granted });
  const tools = makeTools();
  const agent = makeAgent(tools, 7);

  assert.equal(sv.sync(agent), "visible");
  assert.equal(tools.restricted.length, 0);

  granted = false;
  assert.equal(sv.sync(agent), "hidden");
  assert.equal(tools.restricted.length, 1, "restrict called exactly once");
  assert.deepEqual(tools.restricted[0], HIDEABLE, "restrict is asked to hide the whole HIDEABLE set");
  assert.equal(sv.restrictedCount(), 1);
  assert.equal(sv.toolSchemaState("7"), "hidden", "toolSchemaState takes the session-key string");

  granted = true;
  assert.equal(sv.sync(agent), "visible");
  assert.equal(tools.lifted.length, 1, "the restriction was lifted, not leaked");
  assert.equal(sv.restrictedCount(), 0);
  assert.equal(sv.toolSchemaState(7), "visible");
});

test("restrict failure keeps the previous deny active and reports an error, never visible", () => {
  let mode = "watch";
  const tools = makeTools();
  const originalRestrict = tools.restrict;
  let calls = 0;
  tools.restrict = (args) => {
    calls += 1;
    if (calls === 2) throw new Error("injected restrict failure");
    return originalRestrict(args);
  };
  const sv = createSchemaVisibility({ enabled: true, getMode: () => mode });
  const agent = makeAgent(tools, "restrict-failure");
  assert.equal(sv.sync(agent), "hidden");
  mode = "disabled";
  assert.equal(sv.sync(agent), "error");
  assert.equal(sv.toolSchemaState("restrict-failure"), "error");
  assert.equal(sv.restrictedCount(), 1, "old restriction was not released before replacement succeeded");
  assert.equal(tools.activeDenied.size, CONTROL_ONLY_TOOL_NAMES.length);
});

test("sync is idempotent while hidden: re-sync does not re-restrict", () => {
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false });
  const tools = makeTools();
  const agent = makeAgent(tools, 7);
  assert.equal(sv.sync(agent), "hidden");
  assert.equal(sv.sync(agent), "hidden");
  assert.equal(tools.restricted.length, 1);
  assert.equal(tools.lifted.length, 0);
});

test("release forgets a session restriction and lifts it", () => {
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false });
  const tools = makeTools();
  const agent = makeAgent(tools, 9);
  sv.sync(agent);
  assert.equal(sv.toolSchemaState("9"), "hidden", "toolSchemaState takes the session-key string");
  sv.release("9");
  assert.equal(tools.lifted.length, 1);
  assert.equal(sv.restrictedCount(), 0);
  assert.equal(sv.toolSchemaState(9), "visible");
  // releasing again is a no-op
  sv.release("9");
  assert.equal(tools.lifted.length, 1);
});

test("activate never leaves a session hidden: a live agent gets released even if sync still says hidden", () => {
  // The in-code contract: activate is the chip-ON path. Even if the grant value still reads
  // absent (which the production comment calls theoretically unreachable), the restriction is
  // released rather than kept — a stuck hidden state must not survive an activate call.
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false });
  const tools = makeTools();
  const agent = makeAgent(tools, 3);
  sv.sync(agent);
  assert.equal(sv.toolSchemaState("3"), "hidden");
  assert.equal(sv.activate(3), "visible");
  assert.equal(tools.lifted.length, 1, "activate released the restriction");
  assert.equal(sv.restrictedCount(), 0);
  assert.equal(sv.toolSchemaState("3"), "visible");
});

test("activate: unbound session key releases a leftover restriction and reports unbound", () => {
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false });
  const tools = makeTools();
  const agent = makeAgent(tools, 3);
  sv.sync(agent);
  // agent forgotten: activate finds nothing bound and releases the restriction in place
  sv.forget(agent);
  assert.equal(tools.lifted.length, 1);
  assert.equal(sv.toolSchemaState("3"), "visible");
  assert.equal(sv.activate(3), "unbound");
  assert.equal(tools.lifted.length, 1, "nothing left to lift");
});

test("activate: grant restored on a live agent flips it to visible", () => {
  let granted = false;
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => granted });
  const tools = makeTools();
  const agent = makeAgent(tools, 4);
  sv.remember(agent);
  assert.equal(sv.toolSchemaState("4"), "hidden");
  granted = true;
  assert.equal(sv.activate(4), "visible");
  assert.equal(tools.lifted.length, 1);
});

test("activate: no agent bound → unbound (the restriction is released in place)", () => {
  const sv = createSchemaVisibility({ enabled: false, isEnabled: () => false });
  assert.equal(sv.activate(12345), "unbound");
});

test("activate: agent bound but feature disabled → advertised", () => {
  const sv = createSchemaVisibility({ enabled: false, isEnabled: () => false });
  const tools = makeTools();
  const agent = makeAgent(tools, 21);
  sv.remember(agent);
  assert.equal(sv.activate(21), "advertised");
});

test("forget notifies onSessionDisposed with the string session id and cleans up", () => {
  const seen = [];
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false, onSessionDisposed: (id) => seen.push(id) });
  const tools = makeTools();
  const agent = makeAgent(tools, 42);
  sv.remember(agent);
  assert.equal(sv.liveAgentCount(), 1);
  sv.forget(agent);
  assert.deepEqual(seen, ["42"], "session id stringified for the host callback");
  assert.equal(sv.liveAgentCount(), 0);
  assert.equal(sv.restrictedCount(), 0);
  assert.equal(tools.lifted.length, 1);
  // remember with no session id is ignored
  sv.remember(makeAgent(makeTools(), undefined));
  assert.equal(sv.liveAgentCount(), 0);
});

test("restrict throwing is non-fatal but explicitly reports a schema error", () => {
  const tools = makeTools();
  tools.restrict = () => { throw new Error("platform refused"); };
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false, logger: { warn: () => {} } });
  const agent = makeAgent(tools, 5);
  assert.equal(sv.sync(agent), "error");
  assert.equal(sv.toolSchemaState("5"), "error");
});

test("restrict with an empty deny list is never called: sync reports visible", () => {
  const tools = makeTools();
  const restricted = [];
  tools.restrict = ({ deny }) => { restricted.push(deny.length); return () => {}; };
  tools.get = () => undefined; // nothing visible in this agent scope
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false });
  const agent = makeAgent(tools, 5);
  assert.equal(sv.sync(agent), "visible");
  assert.equal(restricted.length, 0, "an empty deny list never reaches the platform");
});

test("liftRestriction: the object-with-dispose form is also honored", () => {
  const disposed = [];
  const tools = makeTools();
  tools.restrict = ({ deny }) => ({ dispose() { disposed.push([...deny]); } });
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false });
  const agent = makeAgent(tools, 11);
  sv.sync(agent);
  assert.equal(sv.restrictedCount(), 1);
  sv.release("11");
  assert.deepEqual(disposed, [HIDEABLE]);
  assert.equal(sv.restrictedCount(), 0);
});

test("visibleOwnToolNames: consults tools.get per HIDEABLE name with the resolved scope", () => {
  const calls = [];
  const tools = {
    get(name, scope) { calls.push([name, scope]); return name === "computer_click" ? { name } : undefined; },
    restrict: () => () => {},
  };
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => true, scopeOf: (ctx) => (ctx.marker === "A" ? "scope-key" : undefined) });
  const agent = { ctx: { tools, marker: "A" } };
  assert.deepEqual(sv.visibleOwnToolNames(agent), ["computer_click"]);
  assert.ok(calls.some(([n, s]) => n === "computer_click" && s === "scope-key"), "the scopeOf result is passed through");
  assert.equal(calls.length, HIDEABLE.length);
});

test("scopeOf: null means no scope resolver; the tools service gets the raw ctx", () => {
  const calls = [];
  const tools = {
    get(name, scope) { calls.push([name, scope]); return { name }; },
    restrict: () => () => {},
  };
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => true, scopeOf: null });
  const ctx = { tools };
  const out = sv.visibleOwnToolNames({ ctx });
  assert.equal(out.length, HIDEABLE.length);
  assert.ok(calls.every(([, s]) => s === ctx), "scope falls back to the agent ctx itself");
});

test("scopeOf: a throwing resolver degrades to the raw ctx instead of failing the call", () => {
  const warned = [];
  const tools = {
    get(name, scope) { return { name, scope }; },
    restrict: () => () => {},
  };
  const sv = createSchemaVisibility({
    enabled: true,
    isEnabled: () => true,
    logger: { warn: (...a) => warned.push(a) },
    scopeOf: () => { throw new Error("scope resolve exploded"); },
  });
  const ctx = { tools };
  const getCalls = [];
  tools.get = (name, scope) => { getCalls.push([name, scope]); return { name, scope }; };
  const out = sv.visibleOwnToolNames({ ctx });
  assert.equal(out.length, HIDEABLE.length, "names still resolved after the fallback");
  assert.ok(getCalls.every(([, s]) => s === ctx), "scope fell back to the raw ctx");
});

test("deactivate on a live agent syncs; unknown key becomes unbound", () => {
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => true });
  assert.equal(sv.deactivate(987654), "unbound");
  const tools = makeTools();
  const agent = makeAgent(tools, 2);
  sv.remember(agent);
  assert.equal(sv.deactivate(2), "visible");
});

test("releaseAll lifts every hidden session and forgets the live agents", () => {
  const tools = makeTools();
  const sv = createSchemaVisibility({ enabled: true, isEnabled: () => false });
  sv.remember(makeAgent(tools, 1));
  sv.remember(makeAgent(tools, 2));
  sv.remember(makeAgent(tools, 3));
  assert.equal(sv.restrictedCount(), 3);
  assert.equal(sv.liveAgentCount(), 3);
  sv.releaseAll();
  assert.equal(sv.restrictedCount(), 0);
  assert.equal(sv.liveAgentCount(), 0);
  assert.equal(tools.lifted.length, 3);
});

test("getMode=watch hides only control tools; denied schemas really disappear from tools.get", () => {
  const tools = makeTools({ enforceDeny: true });
  const agent = makeAgent(tools, "watch");
  const sv = createSchemaVisibility({ enabled: true, getMode: () => "watch" });
  assert.equal(sv.sync(agent), "hidden");
  assert.deepEqual(tools.restricted, [CONTROL_ONLY_TOOL_NAMES]);
  for (const name of CONTROL_ONLY_TOOL_NAMES) {
    assert.equal(tools.get(name, agent.ctx), undefined, name + " must be absent from the schema lookup");
  }
  for (const name of WATCH_TOOL_NAMES) {
    assert.notEqual(tools.get(name, agent.ctx), undefined, name + " stays visible");
  }
});

test("getMode=control advertises every managed schema and never installs an empty restriction", () => {
  const tools = makeTools();
  const agent = makeAgent(tools, "control");
  const sv = createSchemaVisibility({ enabled: true, getMode: () => "control" });
  assert.equal(sv.sync(agent), "visible");
  assert.equal(tools.restricted.length, 0);
  for (const name of ALL_MANAGED_TOOL_NAMES) assert.notEqual(tools.get(name, agent.ctx), undefined);
});

test("watch/control transitions lift restrictions; stricter modes install before lifting the old set", () => {
  let mode = "watch";
  const tools = makeTools({ enforceDeny: true });
  const agent = makeAgent(tools, "switch");
  const sv = createSchemaVisibility({ enabled: true, getMode: () => mode });
  sv.sync(agent);
  assert.deepEqual(tools.events, [{ type: "restrict", deny: CONTROL_ONLY_TOOL_NAMES }]);

  mode = "control";
  assert.equal(sv.sync(agent), "visible");
  assert.deepEqual(tools.events.map((event) => event.type), ["restrict", "lift"]);
  assert.equal(tools.activeDenied.size, 0);

  mode = "watch";
  assert.equal(sv.sync(agent), "hidden");
  assert.deepEqual(tools.events.map((event) => event.type), ["restrict", "lift", "restrict"]);
  assert.deepEqual(tools.events[2].deny, CONTROL_ONLY_TOOL_NAMES);

  mode = "disabled";
  assert.equal(sv.sync(agent), "hidden");
  assert.deepEqual(tools.events.map((event) => event.type), ["restrict", "lift", "restrict", "restrict", "lift"]);
  assert.deepEqual([...tools.events[3].deny].sort(), [...ALL_MANAGED_TOOL_NAMES].sort());
  assert.deepEqual(tools.events[2].deny, CONTROL_ONLY_TOOL_NAMES);
  for (const name of ALL_MANAGED_TOOL_NAMES) assert.equal(tools.get(name, agent.ctx), undefined);
});

test("mode-aware activate keeps watch restrictions and releases them only for control", () => {
  let mode = "disabled";
  const tools = makeTools({ enforceDeny: true });
  const agent = makeAgent(tools, "activate-mode");
  const sv = createSchemaVisibility({ enabled: true, getMode: () => mode });
  assert.equal(sv.sync(agent), "hidden");
  assert.deepEqual(tools.restricted, [ALL_MANAGED_TOOL_NAMES]);

  mode = "watch";
  assert.equal(sv.activate("activate-mode"), "hidden");
  assert.deepEqual([...tools.activeDenied].sort(), [...CONTROL_ONLY_TOOL_NAMES].sort());
  for (const name of WATCH_TOOL_NAMES) assert.notEqual(tools.get(name, agent.ctx), undefined);

  mode = "control";
  assert.equal(sv.activate("activate-mode"), "visible");
  assert.equal(tools.activeDenied.size, 0);
  assert.deepEqual(tools.events.map((event) => event.type), ["restrict", "restrict", "lift", "lift"]);
});

test("invalid getMode values fail closed to disabled", () => {
  const tools = makeTools();
  const agent = makeAgent(tools, "invalid");
  const sv = createSchemaVisibility({ enabled: true, getMode: () => "WATCH", isEnabled: () => true });
  assert.equal(sv.sync(agent), "hidden");
  assert.deepEqual(tools.restricted, [ALL_MANAGED_TOOL_NAMES]);
});

test("an injected tools service supports agents without ctx.tools", () => {
  const tools = makeTools();
  const agent = { ctx: {}, session: { id: "injected" } };
  const sv = createSchemaVisibility({ tools, enabled: true, getMode: () => "watch" });
  assert.equal(sv.sync(agent), "hidden");
  assert.deepEqual(tools.restricted, [CONTROL_ONLY_TOOL_NAMES]);
});
