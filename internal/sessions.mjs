import { MODES } from './modes.mjs';

/** Missing ids share the anonymous session rather than bypassing authorization. */
export const sessionKey = (sessionId) => (sessionId === undefined || sessionId === null ? '' : String(sessionId));

/** Per-session three-mode grants. Missing records use the deployment default. */
export class SessionGrantStore {
  constructor({ defaultEnabled = false } = {}) {
    this.defaultEnabled = defaultEnabled === true;
    this.modes = new Map();
    this.listeners = new Set();
    for (const method of ['getMode', 'setMode', 'canObserve', 'canControl', 'isEnabled', 'grant', 'revoke', 'hasExplicit', 'forget', 'emit', 'onChange']) {
      this[method] = this[method].bind(this);
    }
  }

  getMode(sessionId) {
    return this.modes.get(sessionKey(sessionId)) ?? (this.defaultEnabled ? 'control' : 'disabled');
  }

  setMode(sessionId, mode) {
    if (!MODES.includes(mode)) {
      throw new RangeError(`Unknown computer-use mode: ${String(mode)}`);
    }
    this.modes.set(sessionKey(sessionId), mode);
    this.emit(sessionId);
    return mode;
  }

  emit(sessionId) {
    const mode = this.getMode(sessionId);
    for (const listener of this.listeners) listener(sessionId, mode);
  }

  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Session change listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  canObserve(sessionId) {
    return this.getMode(sessionId) !== 'disabled';
  }

  canControl(sessionId) {
    return this.getMode(sessionId) === 'control';
  }

  /** Legacy boolean API: enabled means full control, not watch. */
  isEnabled(sessionId) {
    return this.canControl(sessionId);
  }

  grant(sessionId) {
    return this.setMode(sessionId, 'control');
  }

  revoke(sessionId) {
    return this.setMode(sessionId, 'disabled');
  }

  hasExplicit(sessionId) {
    return this.modes.has(sessionKey(sessionId));
  }

  forget(sessionId) {
    return this.modes.delete(sessionKey(sessionId));
  }
}

export function createSessions({ defaultEnabled = true } = {}) {
  return new SessionGrantStore({ defaultEnabled });
}
