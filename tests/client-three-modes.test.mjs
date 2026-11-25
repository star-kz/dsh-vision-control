import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const MODE_ORDER = ['disabled', 'watch', 'control'];
const MODE_ICON = { disabled: 'disabled', watch: 'watch', control: 'control' };
const MODE_TEXT = { disabled: '禁用功能', watch: '仅观看', control: '观看+操作' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

function statePayload(mode, overrides = {}) {
  return {
    ok: true, supported: true, sessionId: 'session-1', mode, enabled: mode !== 'disabled',
    control: { state: '', inFlight: 0, watch: null, lastAction: null, lease: null },
    ...overrides,
  };
}

function legacyPayload(enabled, overrides = {}) {
  const payload = statePayload(enabled ? 'control' : 'disabled', overrides);
  delete payload.mode;
  return payload;
}

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  listenerCount(type) { return this.listeners.get(type)?.size ?? 0; }
  dispatch(type, init = {}) {
    const event = {
      type, target: init.target ?? this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...init,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }
}

class FakeNode {
  constructor(type, props, children, ownerDocument) {
    this.type = type;
    this.props = props;
    this.children = children;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.focusCount = 0;
    for (const child of children) if (child instanceof FakeNode) child.parentNode = this;
  }
  focus() { this.focusCount += 1; this.ownerDocument.activeElement = this; }
  contains(target) {
    for (let node = target; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  getBoundingClientRect() {
    return this.props.rect ?? { left: 100, right: 124, top: 200, bottom: 224, width: 24, height: 24 };
  }
}

function flatten(children) {
  return children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
}
function textContent(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return node.children.map(textContent).join('');
}
function iconMode(harness, node = harness.trigger()) {
  const icons = harness.renderer.findAll((candidate) => typeof candidate.props['data-icon'] === 'string', node);
  assert.equal(icons.length, 1, 'expected exactly one SVG mode icon');
  assert.equal(icons[0].type, 'svg');
  assert.equal(icons[0].props.stroke, 'currentColor');
  return icons[0].props['data-icon'];
}

function sameDeps(left, right) {
  return left !== undefined && right !== undefined && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));
}

class FakeRenderer {
  constructor(React, component, props) {
    this.React = React;
    this.component = component;
    this.props = props;
    this.hooks = [];
    this.tree = null;
    this.queued = false;
    this.unmounted = false;
  }
  invalidate() {
    if (this.queued || this.unmounted) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (!this.unmounted) this.render(); });
  }
  useState(initialValue) {
    const index = this.hookIndex++;
    if (this.hooks[index] === undefined) {
      const slot = { kind: 'state', value: typeof initialValue === 'function' ? initialValue() : initialValue };
      slot.setValue = (nextValue) => {
        const value = typeof nextValue === 'function' ? nextValue(slot.value) : nextValue;
        if (Object.is(slot.value, value)) return;
        slot.value = value;
        this.invalidate();
      };
      this.hooks[index] = slot;
    }
    const slot = this.hooks[index];
    return [slot.value, slot.setValue];
  }
  useRef(initialValue) {
    const index = this.hookIndex++;
    if (this.hooks[index] === undefined) this.hooks[index] = { kind: 'ref', value: { current: initialValue } };
    return this.hooks[index].value;
  }
  useCallback(callback, deps) {
    const index = this.hookIndex++;
    const previous = this.hooks[index];
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      this.hooks[index] = { kind: 'callback', value: callback, deps };
    }
    return this.hooks[index].value;
  }
  useEffect(create, deps) {
    const index = this.hookIndex++;
    const previous = this.hooks[index];
    if (previous !== undefined && sameDeps(previous.deps, deps)) return;
    const slot = previous ?? { kind: 'effect', cleanup: undefined, deps };
    slot.deps = deps;
    this.hooks[index] = slot;
    this.pendingEffects.push({ slot, create });
  }
  render() {
    if (this.unmounted) return;
    this.hookIndex = 0;
    this.pendingEffects = [];
    this.tree = this.component(this.props);
    const effects = this.pendingEffects;
    this.pendingEffects = [];
    for (const { slot, create } of effects) {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = create();
    }
  }
  updateProps(props) { this.props = props; this.render(); }
  unmount() {
    if (this.unmounted) return;
    this.unmounted = true;
    for (const slot of this.hooks) {
      if (slot?.kind === 'effect' && typeof slot.cleanup === 'function') slot.cleanup();
      if (slot?.kind === 'effect') slot.cleanup = undefined;
    }
  }
  findAll(predicate, node = this.tree, found = []) {
    if (node instanceof FakeNode) {
      if (predicate(node)) found.push(node);
      for (const child of node.children) this.findAll(predicate, child, found);
    }
    return found;
  }
  findOne(predicate) {
    const matches = this.findAll(predicate);
    assert.equal(matches.length, 1, 'expected one matching node, got ' + matches.length);
    return matches[0];
  }
}

async function flush() { for (let index = 0; index < 40; index += 1) await Promise.resolve(); }

async function createHarness({ sessionId = 'session-1', fetchHandler } = {}) {
  const document = new FakeEventTarget();
  document.visibilityState = 'visible';
  document.activeElement = null;
  const elementsById = new Map();
  document.createElement = (type) => new FakeNode(type, {}, [], document);
  document.body = new FakeNode('body', {}, [], document);
  document.head = new FakeNode('head', {}, [], document);
  document.head.appendChild = (node) => {
    document.head.children.push(node);
    node.parentNode = document.head;
    if (node.id) elementsById.set(node.id, node);
  };
  document.getElementById = (id) => elementsById.get(id) ?? null;
  const window = new FakeEventTarget();
  window.document = document;
  let renderer;
  const React = {
    createElement(type, inputProps, ...inputChildren) {
      const props = { ...(inputProps ?? {}) };
      const children = flatten(inputChildren);
      if (typeof type === 'function') return type({ ...props, children });
      const node = new FakeNode(type, props, children, document);
      if (typeof props.ref === 'function') props.ref(node);
      else if (props.ref && typeof props.ref === 'object') props.ref.current = node;
      return node;
    },
    useState: (value) => renderer.useState(value),
    useRef: (value) => renderer.useRef(value),
    useCallback: (callback, deps) => renderer.useCallback(callback, deps),
    useEffect: (callback, deps) => renderer.useEffect(callback, deps),
  };
  const requests = [];
  let descriptor;
  let nextTimer = 1;
  const timers = new Map();
  const context = vm.createContext({
    window, document, console: { info() {}, warn() {}, error() {} }, AbortController, encodeURIComponent,
    setTimeout(callback, ms) { const id = nextTimer++; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options = {}) => {
      const request = { url, options, body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      return fetchHandler ? fetchHandler(request, requests.length) : response(statePayload('disabled'));
    },
  });
  window.__ModuleLoader__ = { load(value) { descriptor = value; } };
  vm.runInContext(clientSource, context, { filename: 'client.js' });
  assert.equal(descriptor?.id, '@k-launcher/dsh-vision-control');
  const portals = [];
  const ReactDOM = {
    createPortal(children, container) {
      const portal = new FakeNode('portal', { container }, [children], document);
      portal.parentNode = container;
      container.children.push(portal);
      portals.push(portal);
      return portal;
    },
  };
  const plugin = descriptor.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return ReactDOM;
    assert.fail(`unexpected module ${name}`);
  });
  let Component;
  plugin.apply({ slots: {
    inject(name, register) { assert.equal(name, 'conversation.input.left'); return register(); },
    register(definition, component) {
      assert.equal(definition.id, 'computer-use');
      Component = component;
      return () => {};
    },
  } });
  renderer = new FakeRenderer(React, Component, { sessionId });
  renderer.render();
  await flush();
  const trigger = () => renderer.findOne((node) => node.props.className?.split(' ').includes('dsh-cu-chip'));
  return {
    renderer, document, window, requests, timers, trigger, portals,
    menu: () => renderer.findOne((node) => node.props.role === 'menu'),
    items: () => renderer.findAll((node) => node.props.role === 'menuitemradio'),
    async click(node) {
      node.props.onClick?.({ target: node, preventDefault() {}, stopPropagation() {} });
      await flush();
    },
    async key(node, key) {
      const event = {
        key, target: document.activeElement ?? node, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
      };
      node.props.onKeyDown?.(event);
      await flush();
      return event;
    },
  };
}

test('collapsed trigger exposes current mode and opens three choices without POST', async (t) => {
  const harness = await createHarness({ fetchHandler: () => response(statePayload('control')) });
  t.after(() => harness.renderer.unmount());
  const trigger = harness.trigger();
  assert.equal(iconMode(harness, trigger), MODE_ICON.control);
  assert.equal(trigger.props['aria-haspopup'], 'menu');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.match(trigger.props['aria-label'], /观看\+操作/);
  assert.equal(harness.renderer.findAll((node) => node.props.role === 'menu').length, 0);
  await harness.click(trigger);
  assert.equal(harness.requests.filter((request) => request.options.method === 'POST').length, 0);
  assert.equal(harness.trigger().props['aria-expanded'], true);
  assert.deepEqual(harness.items().map(textContent), MODE_ORDER.map((mode) => MODE_TEXT[mode]));
  assert.deepEqual(harness.items().map((node) => node.props['aria-checked']), [false, false, true]);
  assert.equal(harness.menu().props['aria-label'], '电脑操作模式');
  assert.equal(harness.menu().props['data-overlay'], 'computer-use-mode');
  assert.equal(harness.menu().parentNode.type, 'portal');
  assert.equal(harness.menu().parentNode.props.container, harness.document.body);
  assert.deepEqual(harness.items().map((item) => harness.renderer.findAll((node) => node.props['data-icon'], item)[0]?.props['data-icon']), MODE_ORDER);
  assert.doesNotMatch(clientSource, /MODE_DETAILS[\s\S]*?[🚫👁💻]/u);
  assert.match(clientSource, /\.dsh-cu-menu \{[\s\S]*?position: fixed;[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
  assert.equal(harness.document.activeElement, harness.items()[2]);
});

test('new mode and legacy enabled payloads map to correct collapsed icons', async (t) => {
  const cases = [
    { payload: statePayload('disabled'), icon: 'disabled', name: 'new disabled', title: /已禁用.*模型不会看到/ },
    { payload: statePayload('watch'), icon: 'watch', name: 'new watch', title: /仅观看.*只能使用只读观察/ },
    { payload: statePayload('control'), icon: 'control', name: 'new control', title: /观看\+操作.*移动鼠标/ },
    { payload: legacyPayload(false), icon: 'disabled', name: 'legacy false' },
    { payload: legacyPayload(true), icon: 'control', name: 'legacy true' },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      const harness = await createHarness({ fetchHandler: () => response(fixture.payload) });
      t.after(() => harness.renderer.unmount());
      assert.equal(iconMode(harness), fixture.icon);
      if (fixture.title) assert.match(harness.trigger().props.title, fixture.title);
    });
  }
});

test('mode POST is authoritative, exact, and protected from duplicate selection', async (t) => {
  const pendingPost = deferred();
  const harness = await createHarness({ fetchHandler: (request) =>
    request.options.method === 'POST' ? pendingPost.promise : response(statePayload('disabled')) });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  const watchItem = harness.items()[1];
  const event = { target: watchItem, preventDefault() {}, stopPropagation() {} };
  watchItem.props.onClick(event);
  watchItem.props.onClick(event);
  await flush();
  const posts = harness.requests.filter((request) => request.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/computer-use/state');
  assert.deepEqual(posts[0].body, { sessionId: 'session-1', mode: 'watch' });
  assert.equal('enabled' in posts[0].body, false);
  assert.equal(iconMode(harness), 'disabled');
  pendingPost.resolve(response(statePayload('watch')));
  await flush();
  assert.equal(iconMode(harness), 'watch');
  await harness.click(harness.trigger());
  assert.deepEqual(harness.items().map((node) => node.props['aria-checked']), [false, true, false]);
});

test('failed mode POST retains old icon and displays server error', async (t) => {
  let getCount = 0;
  const harness = await createHarness({ fetchHandler: (request) => {
    if (request.options.method === 'POST') return response({ ok: false, error: 'mode refused' }, { ok: false, status: 409 });
    getCount += 1;
    return response(statePayload('control'));
  } });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  await harness.click(harness.items()[1]);
  await flush();
  assert.equal(getCount, 2, 'failed mutation is followed by one confirming read');
  assert.equal(iconMode(harness), 'control');
  assert.match(textContent(harness.renderer.findOne((node) => node.props.role === 'alert')), /mode refused/);
  assert.match(harness.trigger().props['aria-label'], /观看\+操作/);
});

test('partial stop failure shows confirmed watch mode but retains warning', async (t) => {
  let getCount = 0;
  const harness = await createHarness({ initialMode: 'control', fetchHandler: (request) => {
    if (request.options.method === 'POST') return response({ ok: false, mode: 'watch', error: 'release outcome unknown' }, { ok: false, status: 409 });
    getCount += 1;
    return response(statePayload(getCount === 1 ? 'control' : 'watch'));
  } });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  await harness.click(harness.items()[1]);
  await flush();
  assert.equal(iconMode(harness), 'watch');
  assert.match(textContent(harness.renderer.findOne((node) => node.props.role === 'alert')), /release outcome unknown/);
  assert.match(harness.trigger().props['aria-label'], /仅观看/);
});

test('partial stop warning survives subsequent successful polling reads', async (t) => {
  let getCount = 0;
  const harness = await createHarness({ initialMode: 'control', fetchHandler: (request) => {
    if (request.options.method === 'POST') return response({ ok: false, mode: 'watch', error: 'release outcome unknown' }, { ok: false, status: 409 });
    getCount += 1;
    return response(statePayload(getCount === 1 ? 'control' : 'watch'));
  } });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  await harness.click(harness.items()[1]);
  await flush();
  assert.equal(harness.renderer.findAll((node) => node.props.role === 'alert').length, 1);
  harness.window.dispatch('focus');
  await flush();
  assert.equal(getCount, 3);
  assert.match(textContent(harness.renderer.findOne((node) => node.props.role === 'alert')), /release outcome unknown/);
});

test('ordinary read failure preserves last confirmed control mode', async (t) => {
  let gets = 0;
  const harness = await createHarness({ fetchHandler: () => {
    gets += 1;
    return gets === 1 ? response(statePayload('control')) : response({ error: 'TEMPORARY_READ_DOWN' }, { ok: false, status: 500 });
  } });
  t.after(() => harness.renderer.unmount());
  harness.window.dispatch('focus');
  await flush();
  assert.equal(harness.trigger().props['data-mode'], 'control');
  assert.match(harness.trigger().props['aria-label'], /观看\+操作/);
  assert.match(textContent(harness.renderer.findOne((node) => node.props.role === 'alert')), /TEMPORARY_READ_DOWN/);
});

test('confirmed mode and accessible wording survive a later host-route 404', async (t) => {
  let gets = 0;
  const harness = await createHarness({ fetchHandler: () => {
    gets += 1;
    return gets === 1 ? response(statePayload('control')) : response({ error: 'NOT_MOUNTED' }, { ok: false, status: 404 });
  } });
  t.after(() => harness.renderer.unmount());
  harness.window.dispatch('focus');
  await flush();
  assert.equal(harness.trigger().props['data-mode'], 'control');
  assert.equal(harness.trigger().props['data-state'], 'unmounted');
  assert.equal(iconMode(harness), 'control');
  assert.match(harness.trigger().props['aria-label'], /观看\+操作/);
  assert.doesNotMatch(harness.trigger().props['aria-label'], /未能确认状态/);
  assert.match(harness.trigger().props.title, /最后一次确认/);
  assert.match(harness.trigger().props.title, /观看\+操作/);
  assert.match(harness.trigger().props.title, /主机半未加载/);
  assert.doesNotMatch(harness.trigger().props.title, /尚未确认/);
});

test('read failure alert and body-portal menu reserve non-overlapping space', async (t) => {
  let gets = 0;
  const harness = await createHarness({ fetchHandler: () => {
    gets += 1;
    return gets === 1 ? response(statePayload('control')) : response({ error: 'TEMPORARY_READ_DOWN' }, { ok: false, status: 500 });
  } });
  t.after(() => harness.renderer.unmount());
  harness.window.dispatch('focus');
  await flush();
  await harness.click(harness.trigger());
  const alert = harness.renderer.findOne((node) => node.props.role === 'alert');
  const menu = harness.menu();
  assert.equal(menu.parentNode.type, 'portal');
  assert.equal(menu.parentNode.props.container, harness.document.body);
  assert.equal(alert.props.style.bottom, 'calc(100% + 118px)');
  // Default fixture: trigger.top=200, upward menu top=82. The alert bottom is
  // trigger.top-118=82, so it ends exactly where the 112px menu begins.
  const menuTop = Number.parseFloat(menu.props.style.top);
  const alertBottom = 200 - 118;
  assert.equal(menuTop, 82);
  assert.ok(alertBottom <= menuTop, 'alert must not intersect the portaled menu');
});

test('initial read failure shows an unconfirmed neutral state, not disabled', async (t) => {
  const harness = await createHarness({ fetchHandler: () =>
    response({ error: 'INITIAL_READ_DOWN' }, { ok: false, status: 500 }) });
  t.after(() => harness.renderer.unmount());
  assert.equal(harness.trigger().props['data-state'], 'error');
  assert.equal(harness.trigger().props['data-mode'], 'unknown');
  assert.equal(iconMode(harness), 'unknown');
  assert.match(harness.trigger().props['aria-label'], /未能确认状态/);
  assert.match(harness.trigger().props.title, /尚未确认/);
  assert.doesNotMatch(harness.trigger().props.title, /最后一次确认/);
});

test('new session read failure does not inherit the previous session mode', async (t) => {
  const harness = await createHarness({ fetchHandler: (request) => {
    const sessionId = new URL(request.url, 'http://local').searchParams.get('sessionId');
    return sessionId === 'session-2'
      ? response({ error: 'NEW_SESSION_READ_DOWN' }, { ok: false, status: 500 })
      : response(statePayload('control'));
  } });
  t.after(() => harness.renderer.unmount());
  assert.equal(iconMode(harness), 'control');
  harness.renderer.updateProps({ sessionId: 'session-2' });
  await flush();
  assert.equal(harness.trigger().props['data-mode'], 'unknown');
  assert.equal(iconMode(harness), 'unknown');
  assert.match(harness.trigger().props['aria-label'], /未能确认状态/);
  assert.match(harness.trigger().props.title, /尚未确认/);
  assert.doesNotMatch(harness.trigger().props.title, /最后一次确认/);
});

test('initial host-route 404 remains explicitly unconfirmed', async (t) => {
  const harness = await createHarness({ fetchHandler: () =>
    response({ error: 'NOT_MOUNTED' }, { ok: false, status: 404 }) });
  t.after(() => harness.renderer.unmount());
  assert.equal(harness.trigger().props['data-mode'], 'unknown');
  assert.match(harness.trigger().props['aria-label'], /未能确认状态/);
  assert.match(harness.trigger().props.title, /尚未确认/);
  assert.doesNotMatch(harness.trigger().props.title, /最后一次确认/);
});

test('new session host-route 404 does not inherit confirmed control wording', async (t) => {
  const harness = await createHarness({ fetchHandler: (request) => {
    const sessionId = new URL(request.url, 'http://local').searchParams.get('sessionId');
    return sessionId === 'session-2'
      ? response({ error: 'NOT_MOUNTED' }, { ok: false, status: 404 })
      : response(statePayload('control'));
  } });
  t.after(() => harness.renderer.unmount());
  assert.equal(iconMode(harness), 'control');
  harness.renderer.updateProps({ sessionId: 'session-2' });
  await flush();
  assert.equal(harness.trigger().props['data-mode'], 'unknown');
  assert.match(harness.trigger().props['aria-label'], /未能确认状态/);
  assert.match(harness.trigger().props.title, /尚未确认/);
  assert.doesNotMatch(harness.trigger().props.title, /最后一次确认/);
});

test('superseded GET cannot overwrite successful mode POST', async (t) => {
  const staleGet = deferred();
  const modePost = deferred();
  let getCount = 0;
  const harness = await createHarness({ fetchHandler: (request) => {
    if (request.options.method === 'POST') return modePost.promise;
    getCount += 1;
    return getCount === 2 ? staleGet.promise : response(statePayload('control'));
  } });
  t.after(() => harness.renderer.unmount());
  harness.window.dispatch('focus');
  await flush();
  assert.equal(getCount, 2);
  await harness.click(harness.trigger());
  await harness.click(harness.items()[0]);
  modePost.resolve(response(statePayload('disabled')));
  await flush();
  assert.equal(iconMode(harness), 'disabled');
  staleGet.resolve(response(statePayload('control')));
  await flush();
  assert.equal(iconMode(harness), 'disabled');
});

test('mode response from previous session cannot replace current session mode', async (t) => {
  const previousSessionPost = deferred();
  const harness = await createHarness({ fetchHandler: (request) => {
    if (request.options.method === 'POST') return previousSessionPost.promise;
    const sessionId = new URL(request.url, 'http://local').searchParams.get('sessionId');
    return response(statePayload(sessionId === 'session-2' ? 'disabled' : 'control'));
  } });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  await harness.click(harness.items()[1]);
  harness.renderer.updateProps({ sessionId: 'session-2' });
  await flush();
  assert.equal(iconMode(harness), 'disabled');
  previousSessionPost.resolve(response(statePayload('watch')));
  await flush();
  assert.equal(iconMode(harness), 'disabled');
});

test('arrows, Home, End, and Enter navigate, select, and restore trigger focus', async (t) => {
  const modePost = deferred();
  const harness = await createHarness({ fetchHandler: (request) =>
    request.options.method === 'POST' ? modePost.promise : response(statePayload('disabled')) });
  t.after(() => harness.renderer.unmount());
  const trigger = harness.trigger();
  trigger.focus();
  await harness.key(trigger, 'ArrowDown');
  assert.equal(harness.trigger().props['aria-expanded'], true);
  assert.equal(harness.document.activeElement, harness.items()[0]);
  await harness.key(harness.menu(), 'ArrowDown');
  assert.equal(harness.document.activeElement, harness.items()[1]);
  await harness.key(harness.menu(), 'End');
  assert.equal(harness.document.activeElement, harness.items()[2]);
  await harness.key(harness.menu(), 'Home');
  assert.equal(harness.document.activeElement, harness.items()[0]);
  await harness.key(harness.menu(), 'ArrowUp');
  assert.equal(harness.document.activeElement, harness.items()[2]);
  await harness.key(harness.menu(), 'Enter');
  assert.equal(harness.renderer.findAll((node) => node.props.role === 'menu').length, 0);
  assert.equal(harness.document.activeElement, harness.trigger());
  assert.deepEqual(harness.requests.find((request) => request.options.method === 'POST').body,
    { sessionId: 'session-1', mode: 'control' });
  modePost.resolve(response(statePayload('control')));
  await flush();
  assert.equal(iconMode(harness), 'control');
});

test('Space selects active radio item', async (t) => {
  const modePost = deferred();
  const harness = await createHarness({ fetchHandler: (request) =>
    request.options.method === 'POST' ? modePost.promise : response(statePayload('control')) });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  await harness.key(harness.menu(), 'ArrowUp');
  assert.equal(harness.document.activeElement, harness.items()[1]);
  await harness.key(harness.menu(), ' ');
  assert.deepEqual(harness.requests.find((request) => request.options.method === 'POST').body,
    { sessionId: 'session-1', mode: 'watch' });
  assert.equal(harness.document.activeElement, harness.trigger());
  modePost.resolve(response(statePayload('watch')));
  await flush();
  assert.equal(iconMode(harness), 'watch');
});

test('Escape and outside pointerdown close menu and restore trigger focus', async (t) => {
  const harness = await createHarness({ fetchHandler: () => response(statePayload('watch')) });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  harness.document.dispatch('keydown', { key: 'Escape', target: harness.items()[1] });
  await flush();
  assert.equal(harness.renderer.findAll((node) => node.props.role === 'menu').length, 0);
  assert.equal(harness.document.activeElement, harness.trigger());
  await harness.click(harness.trigger());
  const outside = new FakeNode('button', {}, [], harness.document);
  harness.document.dispatch('pointerdown', { target: outside });
  await flush();
  assert.equal(harness.renderer.findAll((node) => node.props.role === 'menu').length, 0);
  assert.equal(harness.document.activeElement, harness.trigger());
  assert.equal(harness.requests.filter((request) => request.options.method === 'POST').length, 0);
});

test('watching keeps separate stop action and exact stop body', async (t) => {
  const watchingPayload = statePayload('control', { control: {
    state: 'watching', inFlight: 0, watch: { alive: true, seconds: 12, source: 'screen' },
    lastAction: null, lease: null,
  } });
  const harness = await createHarness({ fetchHandler: (request) =>
    response(request.url === '/computer-use/watch' ? statePayload('control') : watchingPayload) });
  t.after(() => harness.renderer.unmount());
  await harness.click(harness.trigger());
  assert.equal(harness.items().length, 3);
  assert.equal(harness.requests.some((request) => request.url === '/computer-use/watch'), false);
  const stop = harness.renderer.findOne((node) => node.type === 'button' && /停止盯屏/.test(textContent(node)));
  await harness.click(stop);
  assert.deepEqual(harness.requests.find((request) => request.url === '/computer-use/watch').body,
    { sessionId: 'session-1', action: 'stop' });
  assert.equal(harness.renderer.findAll((node) => node.type === 'button' && /停止盯屏/.test(textContent(node))).length, 0);
  assert.equal(iconMode(harness), 'control');
});

test('watch stop 409 remains visible even when confirming GET fails', async (t) => {
  const watchingPayload = statePayload('control', { control: {
    state: 'watching', inFlight: 0, watch: { alive: true, seconds: 12, source: 'screen' }, lastAction: null, lease: null,
  } });
  let gets = 0;
  const harness = await createHarness({ fetchHandler: (request) => {
    if (request.url === '/computer-use/watch') return response({ error: 'WATCH_RELEASE_STUCK' }, { ok: false, status: 409 });
    gets += 1;
    return gets === 1 ? response(watchingPayload) : response({ error: 'CONFIRM_READ_DOWN' }, { ok: false, status: 500 });
  } });
  t.after(() => harness.renderer.unmount());
  const stop = harness.renderer.findOne((node) => node.type === 'button' && /停止盯屏/.test(textContent(node)));
  await harness.click(stop);
  await flush();
  assert.equal(gets, 2);
  assert.match(textContent(harness.renderer.findOne((node) => node.props.role === 'alert')), /WATCH_RELEASE_STUCK/);
  assert.equal(iconMode(harness), 'control');
});

test('superseded reads do not leak an extra polling timer', async (t) => {
  const stale = deferred();
  const current = deferred();
  let gets = 0;
  const harness = await createHarness({ fetchHandler: () => {
    gets += 1;
    if (gets === 1) return response(statePayload('control'));
    if (gets === 2) return stale.promise;
    return current.promise;
  } });
  harness.window.dispatch('focus');
  await flush();
  harness.window.dispatch('focus');
  await flush();
  assert.equal(gets, 3);
  stale.resolve(response(statePayload('watch')));
  await flush();
  current.resolve(response(statePayload('control')));
  await flush();
  assert.equal(harness.timers.size, 1);
  harness.renderer.unmount();
  assert.equal(harness.timers.size, 0);
});

test('stopping remains authoritative and disables trigger', async (t) => {
  const stoppingPayload = statePayload('control', { control: {
    state: 'stopping', inFlight: 1, watch: { alive: true, seconds: 12, source: 'screen' },
    lastAction: null, lease: null,
  } });
  const harness = await createHarness({ fetchHandler: () => response(stoppingPayload) });
  t.after(() => harness.renderer.unmount());
  assert.equal(harness.trigger().props.disabled, true);
  assert.equal(iconMode(harness), 'control');
  assert.match(harness.trigger().props['aria-label'], /观看\+操作/);
  assert.match(harness.trigger().props['aria-label'], /停止中/);
  assert.match(harness.trigger().props.title, /停止中/);
});

test('menu and polling listeners are removed on unmount', async () => {
  const harness = await createHarness({ fetchHandler: () => response(statePayload('disabled')) });
  await harness.click(harness.trigger());
  assert.equal(harness.document.listenerCount('pointerdown'), 1);
  assert.equal(harness.document.listenerCount('keydown'), 1);
  harness.renderer.unmount();
  assert.equal(harness.document.listenerCount('pointerdown'), 0);
  assert.equal(harness.document.listenerCount('keydown'), 0);
  assert.equal(harness.document.listenerCount('visibilitychange'), 0);
  assert.equal(harness.window.listenerCount('focus'), 0);
  assert.equal(harness.timers.size, 0);
});
