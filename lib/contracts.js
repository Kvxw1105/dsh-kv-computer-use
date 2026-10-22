/**
 * Action contracts: risk classification, input mode, postcondition verification,
 * and five-state transactional outcomes.
 *
 * Ported from the MIT-licensed KV Computer Use contract layer
 * (apps/codex-mcp-server/src/computer-contracts.ts). The behavioural rules are
 * deliberately identical so receipts stay comparable across both surfaces.
 */

export const PROTOCOL_VERSION = 1;

/** @typedef {'read'|'reversible-write'|'external-write'|'destructive'} RiskLevel */
/** @typedef {'background'|'focus'|'coordinate'} InputMode */
/** @typedef {'VERIFIED'|'HALTED_BEFORE_EFFECT'|'COMPLETED_UNVERIFIED'|'RECONCILIATION_REQUIRED'|'FAILED'} ActionOutcome */

export const RISK_LEVELS = ['read', 'reversible-write', 'external-write', 'destructive'];
export const INPUT_MODES = ['background', 'focus', 'coordinate'];
export const ACTIONS = [
  'observe_window',
  'focus_window',
  'invoke_ref',
  'set_value_ref',
  'type_text',
  'hotkey',
  'click_point',
  'scroll',
  'capture',
  'wait',
];

export const POSTCONDITION_KINDS = [
  'none',
  'text_present',
  'value_equals',
  'window_focused',
  'element_exists',
  'element_absent',
  'driver_result',
];

/** Actions that move the shared cursor or steal keyboard focus. */
const FOCUS_ACTIONS = new Set(['focus_window', 'type_text', 'hotkey']);
const COORDINATE_ACTIONS = new Set(['click_point', 'scroll']);

/**
 * Risk is derived from the action, never trusted from the caller. A caller may
 * escalate (e.g. declare `destructive` for a delete button) but never downgrade.
 * @param {{type: string}} action
 * @returns {RiskLevel}
 */
export function classifyRisk(action) {
  if (action.type === 'wait' || action.type === 'observe_window' || action.type === 'capture') return 'read';
  if (action.type === 'click_point' || action.type === 'scroll') return 'reversible-write';
  if (action.type === 'invoke_ref' || action.type === 'set_value_ref' || action.type === 'type_text' || action.type === 'hotkey') {
    return 'reversible-write';
  }
  if (action.type === 'focus_window') return 'read';
  return 'reversible-write';
}

/**
 * @param {{type: string, background?: boolean}} action
 * @returns {InputMode}
 */
export function classifyInputMode(action) {
  if (action.type === 'invoke_ref') return action.background === false ? 'focus' : 'background';
  // A background click posts messages and never moves the cursor or takes focus;
  // only mode "real" needs the cursor and therefore counts as coordinate input.
  if (action.type === 'click_point') return action.mode === 'real' ? 'coordinate' : 'background';
  if (action.type === 'set_value_ref' || action.type === 'wait' || action.type === 'observe_window' || action.type === 'capture') {
    return 'background';
  }
  if (FOCUS_ACTIONS.has(action.type)) return 'focus';
  if (COORDINATE_ACTIONS.has(action.type)) return 'coordinate';
  return 'coordinate';
}

/**
 * Validate an action envelope before it reaches a driver.
 * @param {object} envelope
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateEnvelope(envelope) {
  const errors = [];
  const action = envelope?.action;
  if (!envelope || typeof envelope !== 'object') return ['envelope must be an object'];
  if (typeof envelope.actionId !== 'string' || envelope.actionId.trim() === '') errors.push('actionId is required');
  if (typeof envelope.reason !== 'string' || envelope.reason.trim() === '') errors.push('reason is required');
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
    errors.push('action.type is required');
    return errors;
  }
  if (!ACTIONS.includes(action.type)) errors.push(`unknown action type: ${action.type}`);

  const timeoutMs = envelope.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    errors.push('timeoutMs must be between 1 and 120000');
  }

  const expectedRisk = classifyRisk(action);
  if (envelope.risk !== expectedRisk && envelope.risk !== 'destructive') {
    errors.push(`risk mismatch: expected ${expectedRisk}`);
  }
  if (envelope.risk === 'destructive' && envelope.approved !== true) {
    errors.push('destructive actions require approved=true');
  }
  if (envelope.risk === 'external-write' && envelope.approved !== true) {
    errors.push('external-write actions require approved=true');
  }

  if (envelope.requireBackground === true) {
    const mode = classifyInputMode(action);
    if (mode !== 'background') {
      errors.push(`requireBackground forbids ${action.type} because it uses ${mode} input`);
    }
  }

  if (action.type === 'invoke_ref' || action.type === 'set_value_ref') {
    if (typeof action.targetRef !== 'string' || action.targetRef === '') {
      errors.push(`${action.type} requires targetRef`);
    }
  }
  if (action.type === 'set_value_ref' && typeof action.value !== 'string') {
    errors.push('set_value_ref requires a string value');
  }
  if (action.type === 'type_text' && typeof action.text !== 'string') {
    errors.push('type_text requires text');
  }
  if (action.type === 'hotkey' && !Array.isArray(action.keys)) {
    errors.push('hotkey requires a keys array');
  }
  if (action.type === 'click_point') {
    if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) errors.push('click_point requires integer x and y');
  }
  if (action.type === 'focus_window' && (!Number.isInteger(action.windowHandle) || action.windowHandle <= 0)) {
    errors.push('focus_window requires a positive windowHandle');
  }

  const post = envelope.expectedPostcondition;
  if (post === undefined || post === null || typeof post !== 'object') {
    errors.push('expectedPostcondition is required (use kind="none" when nothing can be verified)');
  } else {
    if (!POSTCONDITION_KINDS.includes(post.kind)) errors.push(`unknown postcondition kind: ${post.kind}`);
    if (post.timeoutMs !== undefined) {
      if (!Number.isInteger(post.timeoutMs) || post.timeoutMs < 0 || post.timeoutMs > timeoutMs) {
        errors.push('postcondition timeoutMs must be an integer between 0 and timeoutMs');
      }
    }
    if (post.pollIntervalMs !== undefined) {
      if (!Number.isInteger(post.pollIntervalMs) || post.pollIntervalMs < 50 || post.pollIntervalMs > 5000) {
        errors.push('postcondition pollIntervalMs must be an integer between 50 and 5000');
      }
    }
    if ((post.kind === 'element_exists' || post.kind === 'element_absent') && !post.targetRef && !post.name && !post.automationId && !post.controlType) {
      errors.push(`${post.kind} requires targetRef, name, automationId, or controlType`);
    }
  }
  return errors;
}

/**
 * Map a raw driver result into the five-state outcome. This is the single place
 * that decides whether an action may be reported as verified.
 * @param {{status: 'completed'|'blocked'|'failed', verification: 'passed'|'failed'|'unknown', risk: RiskLevel, executed?: boolean}} input
 * @returns {ActionOutcome}
 */
export function classifyOutcome({ status, verification, risk, executed = status === 'completed' }) {
  if (status === 'blocked') return 'HALTED_BEFORE_EFFECT';
  if (!executed) return risk === 'external-write' || risk === 'destructive' ? 'RECONCILIATION_REQUIRED' : 'FAILED';
  if (verification === 'passed') return 'VERIFIED';
  if (verification === 'unknown') return 'COMPLETED_UNVERIFIED';
  return risk === 'read' ? 'FAILED' : 'RECONCILIATION_REQUIRED';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Evaluate one postcondition against a live probe.
 * @param {object} post
 * @param {{windowHandle?: number, observe: Function, capture?: Function}} probe
 * @returns {Promise<{status: 'passed'|'failed'|'unknown', evidence?: object}>}
 */
export async function evaluatePostcondition(post, probe) {
  if (!post || post.kind === 'none') return { status: 'unknown', evidence: { reason: 'no postcondition declared' } };
  if (post.kind === 'driver_result') return { status: 'passed', evidence: { reason: 'driver reported success' } };

  const deadline = Date.now() + (post.timeoutMs ?? 1500);
  const pollIntervalMs = post.pollIntervalMs ?? 150;

  for (;;) {
    let state;
    try {
      state = await probe.observe({ windowHandle: post.windowHandle ?? probe.windowHandle });
    } catch (error) {
      return { status: 'unknown', evidence: { reason: 'observation failed', message: String(error?.message ?? error) } };
    }

    const elements = collectElements(state);
    const byRef = post.targetRef ? elements.find((e) => e.ref === post.targetRef) : undefined;

    if (post.kind === 'element_exists') {
      const hit = byRef ?? elements.find((e) => matchesElement(e, post));
      if (hit) return { status: 'passed', evidence: { ref: hit.ref, name: hit.name, controlType: hit.controlType } };
    } else if (post.kind === 'element_absent') {
      const hit = byRef ?? elements.find((e) => matchesElement(e, post));
      if (!hit) return { status: 'passed', evidence: { observedElements: elements.length } };
    } else if (post.kind === 'text_present') {
      const needle = String(post.value ?? '');
      if (needle !== '' && elements.some((e) => String(e.name ?? '').includes(needle))) {
        return { status: 'passed', evidence: { needle } };
      }
    } else if (post.kind === 'value_equals') {
      const expected = String(post.value ?? '');
      // Short refs are scoped to one observation; element order can shift after a
      // write (a scrollbar appears, a row is inserted). Fall back to stable
      // identity, then to "any element carries the value".
      if (byRef && String(byRef.value ?? '') === expected) {
        return { status: 'passed', evidence: { matchedBy: 'ref', ref: byRef.ref, value: byRef.value } };
      }
      const stable = elements.find((e) =>
        (post.name !== undefined && String(e.name ?? '') === String(post.name))
        || (post.automationId !== undefined && String(e.automationId ?? '') === String(post.automationId)));
      if (stable && String(stable.value ?? '') === expected) {
        return { status: 'passed', evidence: { matchedBy: 'identity', ref: stable.ref, name: stable.name, value: stable.value } };
      }
      const anyMatch = elements.find((e) => String(e.value ?? '') === expected);
      if (anyMatch) {
        return { status: 'passed', evidence: { matchedBy: 'value-scan', ref: anyMatch.ref, name: anyMatch.name, value: anyMatch.value } };
      }
    } else if (post.kind === 'window_focused') {
      const handle = post.windowHandle ?? probe.windowHandle;
      if (state?.windows?.foregroundWindowHandle !== undefined && state.windows.foregroundWindowHandle === handle) {
        return { status: 'passed', evidence: { windowHandle: handle } };
      }
    }

    if (Date.now() >= deadline) {
      return { status: 'failed', evidence: { kind: post.kind, timedOutAfterMs: post.timeoutMs ?? 1500 } };
    }
    await sleep(pollIntervalMs);
  }
}

function collectElements(state) {
  // The observation shape is { observationId, windows: [...], targetWindow: {...} }.
  // targetWindow sits at the top level, NOT under `windows` — reading it as
  // state.windows.targetWindow yields an empty list and silently fails every
  // element-based postcondition.
  const out = [];
  const target = state?.targetWindow ?? state?.windows?.targetWindow;
  if (target && Array.isArray(target.elements)) out.push(...target.elements);
  if (Array.isArray(state?.elements) && out.length === 0) out.push(...state.elements);
  return out;
}

function matchesElement(element, post) {
  if (post.automationId && element.automationId !== post.automationId) return false;
  if (post.controlType && String(element.controlType ?? '') !== String(post.controlType)) return false;
  if (post.name && String(element.name ?? '') !== String(post.name)) return false;
  return Boolean(post.automationId || post.controlType || post.name);
}
