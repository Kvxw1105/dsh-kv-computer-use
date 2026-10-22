/**
 * Observation freshness: the staleness boundary every mutating action crosses.
 *
 * Before an action is delivered, the target window is re-observed and three
 * independent fingerprints are compared against the observation the caller
 * cited:
 *
 *   identity  pid + class + bounds + title of the window
 *   tree      sha256 over the normalised element list
 *   pixels    sha256 over the window capture (optional, costs one capture)
 *
 * Mechanism taken from dsh-click's staleness boundary (identity + tree hash +
 * pixel hash, `staleCheckPixels` on by default), rewired so a stale observation
 * produces a HALTED_BEFORE_EFFECT receipt instead of a thrown error. That way the
 * model learns why it was refused and what to re-observe.
 */

import { createHash } from 'node:crypto';

const MAX_RECORDS = 64;

const sha = (input) => createHash('sha256').update(input).digest('hex').slice(0, 32);

/**
 * Identity facts that must not change between observation and action.
 *
 * `exePath` is part of the identity because a pid alone can be reused by a
 * different process. It is optional: when the daemon cannot resolve it, the rest
 * of the identity still applies (and the receipt says so through the hash).
 */
export function identityOf(window, exePath) {
  if (!window) return undefined;
  const radius = window.bounds ?? window.rect ?? {};
  return {
    pid: window.processId,
    className: window.className,
    name: window.name ?? window.title,
    x: radius.x,
    y: radius.y,
    width: radius.width,
    height: radius.height,
    exe: typeof exePath === 'string' && exePath !== '' ? exePath : undefined,
  };
}

export function hashIdentity(identity) {
  if (!identity) return undefined;
  return sha(JSON.stringify([
    identity.pid, identity.className, identity.name,
    identity.x, identity.y, identity.width, identity.height,
    identity.exe ?? '',
  ]));
}

/** Tree fingerprint: element shape only, not volatile values. */
export function hashTree(elements) {
  if (!Array.isArray(elements)) return undefined;
  const material = elements.map((element) => [
    element.ref,
    element.controlType,
    element.name,
    element.automationId,
    element.bounds?.x,
    element.bounds?.y,
    element.bounds?.width,
    element.bounds?.height,
    element.canInvoke ? 1 : 0,
    element.canSetValue ? 1 : 0,
  ].join('\u0001')).join('\u0002');
  return sha(material);
}

export function hashShot(base64Png) {
  if (typeof base64Png !== 'string' || base64Png === '') return undefined;
  return sha(base64Png);
}

export class FreshnessStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs ?? 30000;
    this.staleCheckPixels = options.staleCheckPixels !== false;
    /** @type {Map<string, object>} */
    this.records = new Map();
  }

  /** @param {{observationId: string, identity?: object, treeHash?: string, shotHash?: string, windowHandle?: number}} record */
  record(observation, extras = {}) {
    const identity = identityOf(observation.targetWindow ?? observation, extras.exePath);
    const entry = {
      observationId: observation.observationId,
      windowHandle: observation.targetWindow?.handle ?? observation.windowHandle,
      identity,
      identityHash: hashIdentity(identity),
      treeHash: hashTree(observation.targetWindow?.elements ?? []),
      // Remember how the tree was captured. A fingerprint taken at depth 12 cannot
      // be compared against one taken at depth 8: different element sets hash
      // differently and every action would look like a stale observation.
      shape: observation.shape,
      shotHash: observation.shotHash,
      at: Date.now(),
    };
    this.records.set(entry.observationId, entry);
    if (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    return entry;
  }

  get(observationId) {
    return observationId ? this.records.get(observationId) : undefined;
  }

  latest() {
    let best;
    for (const entry of this.records.values()) {
      // `>=` so several observations minted in the same millisecond resolve to the
      // most recently inserted one instead of the first.
      if (best === undefined || entry.at >= best.at) best = entry;
    }
    return best;
  }

  attachShot(observationId, base64Png) {
    const entry = this.records.get(observationId);
    if (entry !== undefined) entry.shotHash = hashShot(base64Png);
    return entry?.shotHash;
  }

  /**
   * Compare a fresh observation against a recorded one.
   * @param {object} recorded
   * @param {object} fresh - a new observation object (same shape as record())
   * @param {{skipPixels?: boolean}} [options]
   * @returns {{ok: boolean, reason?: string, detail?: string, checks: object}}
   */
  compare(recorded, fresh, options = {}) {
    const now = Date.now();
    const checks = {};
    const ageMs = now - recorded.at;

    checks.ttl = { ok: ageMs <= this.ttlMs, ageMs, ttlMs: this.ttlMs };

    // The fingerprints are computed even when the TTL has passed: expiry alone says
    // the citation is old, not that the screen changed, and the caller decides what
    // to do with that distinction.
    const freshIdentityHash = hashIdentity(identityOf(fresh.targetWindow ?? fresh, options.exePath));
    checks.identity = { ok: freshIdentityHash === recorded.identityHash, before: recorded.identityHash, after: freshIdentityHash };
    if (!checks.identity.ok) {
      return {
        ok: false,
        reason: 'WINDOW_CHANGED',
        detail: 'the target window identity changed (pid, class, geometry or title) since the cited observation',
        checks,
      };
    }

    const freshTreeHash = hashTree(fresh.targetWindow?.elements ?? []);
    checks.tree = { ok: freshTreeHash === recorded.treeHash, before: recorded.treeHash, after: freshTreeHash };
    if (!checks.tree.ok) {
      return {
        ok: false,
        reason: 'TREE_CHANGED',
        detail: 'the accessibility tree changed since the cited observation — re-observe before acting',
        checks,
      };
    }

    if (this.staleCheckPixels && options.skipPixels !== true && recorded.shotHash !== undefined) {
      const freshShot = hashShot(options.freshShot);
      checks.pixels = { ok: freshShot === undefined ? 'unknown' : freshShot === recorded.shotHash, before: recorded.shotHash, after: freshShot };
      if (checks.pixels.ok === false) {
        return {
          ok: false,
          reason: 'PIXELS_CHANGED',
          detail: 'the window pixels changed since the cited observation (animation, scroll or repaint)',
          checks,
        };
      }
    }

    if (!checks.ttl.ok) {
      return {
        ok: false,
        reason: 'OBSERVATION_EXPIRED',
        detail: `observation is ${ageMs}ms old, ttl is ${this.ttlMs}ms`,
        checks,
        unchanged: true,
      };
    }

    return { ok: true, checks };
  }
}
