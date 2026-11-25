import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionGrantStore, createSessions, sessionKey } from '../internal/sessions.mjs';

test('SessionGrantStore defaults to disabled and normalizes session keys', () => {
  const store = new SessionGrantStore();
  assert.equal(store.defaultEnabled, false);
  for (const id of [undefined, null, 'anonymous']) {
    if (id !== 'anonymous') assert.equal(sessionKey(id), '');
    assert.equal(store.getMode(id), 'disabled');
    assert.equal(store.canObserve(id), false);
    assert.equal(store.canControl(id), false);
    assert.equal(store.isEnabled(id), false);
    assert.equal(store.hasExplicit(id), false);
  }
  assert.equal(sessionKey(5), '5');
  assert.equal(sessionKey('s'), 's');
});

test('defaultEnabled=true means control until an explicit mode overrides it', () => {
  const store = new SessionGrantStore({ defaultEnabled: true });
  assert.equal(store.defaultEnabled, true);
  assert.equal(store.getMode('s'), 'control');
  assert.equal(store.canObserve('s'), true);
  assert.equal(store.canControl('s'), true);
  assert.equal(store.isEnabled('s'), true);
  store.setMode('s', 'watch');
  assert.equal(store.getMode('s'), 'watch');
  assert.equal(store.canObserve('s'), true);
  assert.equal(store.canControl('s'), false);
  assert.equal(store.isEnabled('s'), false);
  store.forget('s');
  assert.equal(store.getMode('s'), 'control');
  assert.equal(store.hasExplicit('s'), false);
});

test('setMode tracks all three states and explicit disabled survives forget semantics', () => {
  const store = new SessionGrantStore({ defaultEnabled: true });
  store.setMode('s', 'disabled');
  assert.equal(store.getMode('s'), 'disabled');
  assert.equal(store.hasExplicit('s'), true);
  store.setMode('s', 'watch');
  assert.equal(store.getMode('s'), 'watch');
  assert.equal(store.canObserve('s'), true);
  assert.equal(store.canControl('s'), false);
  store.setMode('s', 'control');
  assert.equal(store.getMode('s'), 'control');
  assert.equal(store.canObserve('s'), true);
  assert.equal(store.canControl('s'), true);
});

test('setMode rejects invalid values instead of silently normalizing them', () => {
  const store = new SessionGrantStore({ defaultEnabled: true });
  for (const bad of [undefined, null, '', 'WATCH', ' watch ', 'enabled', true, false, 0, 1, {}, [], ['watch']]) {
    assert.throws(() => store.setMode('s', bad), RangeError);
    assert.equal(store.getMode('s'), 'control');
    assert.equal(store.hasExplicit('s'), false);
  }
});

test('legacy grant/revoke/isEnabled map to control/disabled and keep explicit records', () => {
  const store = new SessionGrantStore({ defaultEnabled: false });
  store.grant('s');
  assert.equal(store.getMode('s'), 'control');
  assert.equal(store.isEnabled('s'), true);
  assert.equal(store.hasExplicit('s'), true);
  store.setMode('s', 'watch');
  assert.equal(store.isEnabled('s'), false, 'watch is observable but not enabled for control');
  store.revoke('s');
  assert.equal(store.getMode('s'), 'disabled');
  assert.equal(store.canObserve('s'), false);
  assert.equal(store.hasExplicit('s'), true);
  store.forget('s');
  assert.equal(store.getMode('s'), 'disabled');
  assert.equal(store.hasExplicit('s'), false);
});

test('methods remain safe when destructured by the host and stores stay isolated', () => {
  const a = createSessions({ defaultEnabled: false });
  const b = createSessions({ defaultEnabled: false });
  const { isEnabled, getMode, grant, setMode } = a;
  grant('s');
  assert.equal(isEnabled('s'), true);
  assert.equal(getMode('s'), 'control');
  setMode('s', 'watch');
  assert.equal(getMode('s'), 'watch');
  assert.equal(b.getMode('s'), 'disabled');
  assert.ok(a instanceof SessionGrantStore);
});
