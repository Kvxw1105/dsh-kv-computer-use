/**
 * dsh-kv-computer-use — transactional computer use for DeepSeek Harness (Windows).
 *
 * Design contract:
 *   - Every mutating action crosses one gate chain: envelope validation ->
 *     foreground/window guard -> driver or input execution -> postcondition
 *     verification -> five-state outcome -> persisted receipt.
 *   - Background-first. `requireBackground: true` refuses any action that would
 *     move the shared cursor or steal focus, before it happens.
 *   - Text-first observation. Element trees are returned as compact structured
 *     text with observation-scoped refs, so a text-only model never needs vision
 *     to act. OCR covers custom-drawn surfaces.
 *
 * The UIA execution engine is the MIT-licensed KV Computer Use driver
 * (kv-windows-uia-driver.exe); this plugin owns the DSH surface, the input and
 * OCR layers, and the receipt/verification contract around it.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { UiaDriver, DriverError } from './driver.js';
import { InputLayer } from './input.js';
import { OcrReader } from './ocr.js';
import { ReceiptStore } from './receipts.js';
import { FreshnessStore, hashShot, identityOf } from './freshness.js';
import { SetTextFallback } from './settext.js';
import { TextReader } from './textread.js';
import { ElementFocus } from './setfocus.js';
import { evaluateGuard, isDangerousLabel, isSecureField } from './guard.js';
import {
  PROTOCOL_VERSION,
  classifyInputMode,
  classifyOutcome,
  classifyRisk,
  evaluatePostcondition,
  validateEnvelope,
} from './contracts.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Renderer for tool results.
 *
 * `defineTool` wraps `output.render` unconditionally:
 *   render(args, value) { return userRender(args, value); }
 * so omitting it turns every call into "output.render failed: userRender is not a
 * function" at runtime. It is required, not optional.
 */
export function textRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export const name = 'dsh-kv-computer-use';
export const inject = ['tools', 'webServer'];

const ACTION_MAP = {
  invoke: 'invoke_ref',
  set_value: 'set_value_ref',
  type: 'type_text',
  hotkey: 'hotkey',
  click: 'click_point',
  scroll: 'scroll',
  focus: 'focus_window',
  wait: 'wait',
};

let counter = 0;
function nextActionId(prefix = 'act') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function apply(ctx, config = {}) {
  const settings = {
    allowedApps: Array.isArray(config.allowedApps) ? config.allowedApps : [],
    ttlMs: Number.isFinite(config.ttlMs) ? config.ttlMs : 30000,
    // Off by default: a blinking caret, a clock or a spinner changes the PNG
    // bytes on every capture, which would make every action look stale. Identity +
    // tree hashing already catch real UI changes; turn this on for static surfaces.
    staleCheckPixels: config.staleCheckPixels === true,
    autoSettle: config.autoSettle !== false,
    settleMaxMs: Number.isFinite(config.settleMaxMs) ? config.settleMaxMs : 2500,
    toolset: config.toolset === 'full' ? 'full' : 'core',
    verifyExecutable: config.verifyExecutable !== false,
  };

  const log = (event, fields = {}) => {
    try {
      process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), service: name, event, ...fields })}\n`);
    } catch {
      // never let logging break a turn
    }
  };

  const driver = new UiaDriver({ log });
  const input = new InputLayer({ log });
  const ocr = new OcrReader({ log });
  const settext = new SetTextFallback({ log });
  const textReader = new TextReader({ log });
  const elementFocus = new ElementFocus({ log });
  const receipts = new ReceiptStore();
  const freshness = new FreshnessStore({ ttlMs: settings.ttlMs, staleCheckPixels: settings.staleCheckPixels });
  const abort = { requested: false, reason: undefined };

  ctx.effect(() => () => {
    void driver.close();
  }, 'dsh-kv-computer-use.driver');

  // ---------- Client channel: activity + stop ----------
  const writeJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const webServer = ctx.get('webServer');
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/kv-computer-use',
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
        const route = pathname.startsWith('/kv-computer-use/') ? pathname.slice('/kv-computer-use/'.length) : '';

        if (route === 'state' && req.method === 'GET') {
          writeJson(res, 200, {
            ok: true,
            activity,
            aborted: abort.requested,
            abortReason: abort.reason,
            toolset: settings.toolset,
            driverAvailable: driver.available,
            updatedAt: Date.now(),
          });
          return;
        }

        if (route === 'abort' && req.method === 'POST') {
          abort.requested = true;
          abort.reason = 'stopped from the Web UI';
          writeJson(res, 200, { ok: true, aborted: true });
          return;
        }

        if (route === 'resume' && req.method === 'POST') {
          abort.requested = false;
          abort.reason = undefined;
          writeJson(res, 200, { ok: true, aborted: false });
          return;
        }

        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: route || '(empty)' } });
      },
    }), 'dsh-kv-computer-use: /kv-computer-use routes');
  }

  /**
   * Resolve the executable path for a pid, using the resident daemon when it is
   * already running. Deliberately does NOT start the daemon: paying 1.5s on every
   * observation just to widen the identity hash is a bad trade, and the pid plus
   * geometry already cover the common case.
   */
  async function resolveExePath(pid) {
    if (settings.verifyExecutable !== true) return undefined;
    const daemon = input.daemon;
    if (!daemon || !pid) return undefined;
    if (daemon.ready !== true) {
      // Bring the daemon up once, lazily: the helper compile plus process start is
      // ~1.8s and then every lookup is ~2ms. A daemon that already failed is not
      // retried, so a broken environment costs one attempt, not one attempt per call.
      if (daemon.failures > 0) return undefined;
      try {
        await input.ensureCompiled();
        await daemon.start();
      } catch {
        return undefined;
      }
    }
    try {
      const info = await daemon.processInfo(pid);
      return info?.found ? info.exePath : undefined;
    } catch {
      return undefined;
    }
  }

  /** Reject focus/coordinate actions that would land on the wrong window. */
  async function guardWindow(windowHandle) {
    if (windowHandle === undefined || !input.available) return undefined;
    const foreground = await input.foregroundHandle();
    if (foreground !== undefined && foreground !== windowHandle) {
      return {
        code: 'FOREGROUND_MISMATCH',
        message: `foreground window is ${foreground}, refused to act on ${windowHandle}; focus the target window first or pass guardWindow=false`,
        foreground,
      };
    }
    return undefined;
  }

  function resolveDriverRef(targetRef) {
    const element = driver.resolveRef(targetRef);
    const real = element?.ref;
    if (typeof real !== 'string' || !real.startsWith('uia:')) {
      throw new DriverError('INVALID_ELEMENT_REF', `element ${targetRef} carries no usable uia: runtime id`, false);
    }
    return real;
  }

  /**
   * Execute one policy-checked action and return a receipt.
   * @param {object} envelope
   * @returns {Promise<object>}
   */
  async function executeEnvelopeInner(envelope) {
    const startedAt = new Date().toISOString();
    const risk = envelope?.action ? classifyRisk(envelope.action) : 'read';
    const inputMode = envelope?.action ? classifyInputMode(envelope.action) : 'background';

    const problems = validateEnvelope(envelope);
    if (problems.length > 0) {
      const receipt = {
        protocolVersion: PROTOCOL_VERSION,
        actionId: envelope?.actionId ?? nextActionId(),
        startedAt,
        finishedAt: new Date().toISOString(),
        driver: 'none',
        status: 'blocked',
        outcome: 'HALTED_BEFORE_EFFECT',
        inputMode,
        risk,
        verification: { status: 'unknown', evidence: { reason: 'envelope rejected' } },
        error: { code: 'ENVELOPE_INVALID', message: problems.join('; '), retryable: false },
      };
      receipts.append(receipt);
      return receipt;
    }

    const action = envelope.action;

    /** Emit a blocked receipt without touching the desktop. */
    const refuse = (code, message) => {
      const receipt = {
        protocolVersion: PROTOCOL_VERSION,
        actionId: envelope.actionId,
        startedAt,
        finishedAt: new Date().toISOString(),
        driver: 'none',
        status: 'blocked',
        outcome: 'HALTED_BEFORE_EFFECT',
        inputMode,
        risk,
        reason: envelope.reason,
        observationId: envelope.observationId ?? driver.observationId,
        verification: { status: 'unknown', evidence: { reason: 'refused before execution' } },
        error: { code, message, retryable: false },
      };
      receipts.append(receipt);
      return receipt;
    };

    // 0) cooperative abort
    if (abort.requested && risk !== 'read') {
      return refuse('ABORTED_BY_USER', `a stop was requested (${abort.reason ?? 'no reason given'}); call cu_abort with clear=true to resume`);
    }

    // 1) guard: scope, credential fields, dangerous labels
    let targetElement;
    if (typeof action.targetRef === 'string') {
      try {
        targetElement = driver.resolveRef(action.targetRef);
      } catch (error) {
        return refuse(error?.code ?? 'REF_NOT_FOUND', String(error?.message ?? error));
      }
    }
    const targetWindow = driver.lastObservation?.window;
    const guard = evaluateGuard({
      action,
      element: targetElement,
      window: targetWindow,
      allowedApps: settings.allowedApps,
    });
    if (guard.verdict === 'deny') return refuse('GUARD_DENIED', guard.reason);
    if (guard.verdict === 'needs-approval' && envelope.approved !== true) {
      return refuse('APPROVAL_REQUIRED', `${guard.reason}; re-issue with approved=true once the user has agreed`);
    }

    // 2) freshness: never act on a stale picture of the screen
    if (risk !== 'read') {
      const cited = envelope.observationId ?? freshness.latest()?.observationId;
      const recorded = freshness.get(cited);
      if (recorded === undefined) {
        return refuse('NO_OBSERVATION', 'call cu_observe first; acting without a recorded observation is refused because the action cannot be verified against what the model actually saw');
      }
      const windowHandle = action.windowHandle ?? recorded.windowHandle;
      let probe;
      let freshShot;
      try {
        probe = await driver.peek({ windowHandle, maxElements: 300, maxDepth: 8 });
        if (settings.staleCheckPixels && recorded.shotHash !== undefined) {
          const shot = await driver.call('capture', { windowHandle, maxWidth: 640 }, 20000);
          freshShot = shot?.imageBase64;
        }
      } catch (error) {
        return refuse('STALENESS_PROBE_FAILED', `could not re-observe the target before acting: ${String(error?.message ?? error)}`);
      }
      const probeExePath = await resolveExePath(probe?.targetWindow?.processId);
      const verdict = freshness.compare(recorded, probe, { freshShot, exePath: probeExePath });
      if (!verdict.ok) return refuse(verdict.reason, `${verdict.detail} (observation ${cited})`);
      envelope.__freshness = verdict.checks;
    }

    let status = 'completed';
    let error;
    let result;
    let driverKind = 'windows-uia';

    try {
      switch (action.type) {
        case 'focus_window':
          result = await driver.call('focus_window', { windowHandle: action.windowHandle });
          break;
        case 'invoke_ref': {
          const targetRef = resolveDriverRef(action.targetRef);
          result = await driver.call('invoke_ref', {
            targetRef,
            windowHandle: action.windowHandle,
            background: action.background !== false,
          }, envelope.timeoutMs ?? 30000);
          break;
        }
        case 'set_value_ref': {
          const targetRef = resolveDriverRef(action.targetRef);
          try {
            result = await driver.call('set_value_ref', {
              targetRef,
              value: action.value,
              windowHandle: action.windowHandle,
            }, envelope.timeoutMs ?? 30000);
          } catch (error) {
            // Controls with only TextPattern (WinForms TextBox, parts of Electron)
            // have no ValuePattern. Fall back to WM_SETTEXT on the control handle,
            // which stays background — no focus change, no keystrokes.
            if (error?.code !== 'PATTERN_UNAVAILABLE' && error?.code !== 'ELEMENT_READ_ONLY') throw error;
            const fallback = await settext.setValue({
              windowHandle: action.windowHandle ?? driver.lastObservation?.windowHandle,
              runtimeId: targetRef,
              value: action.value,
            });
            if (!fallback.ok) throw error;
            result = { ...fallback, action: 'set_value_ref', targetRef, via: 'wm-settext' };
          }
          break;
        }
        case 'type_text': {
          driverKind = 'input';
          const mismatch = action.guardWindow === false ? undefined : await guardWindow(action.windowHandle);
          if (mismatch) throw new DriverError(mismatch.code, mismatch.message, false);
          // Keystrokes land on the focused *control*, not on "the window". Focus the
          // element the caller addressed before typing, and report what UIA says
          // owns focus afterwards.
          let focusResult;
          if (typeof action.targetRef === 'string' && elementFocus.available) {
            const realRef = resolveDriverRef(action.targetRef);
            focusResult = await elementFocus.focus({
              windowHandle: action.windowHandle ?? driver.lastObservation?.windowHandle,
              runtimeId: realRef,
            });
          }
          result = await input.typeText(action.text);
          if (focusResult !== undefined) result.focus = focusResult;
          break;
        }
        case 'hotkey': {
          driverKind = 'input';
          const mismatch = action.guardWindow === false ? undefined : await guardWindow(action.windowHandle);
          if (mismatch) throw new DriverError(mismatch.code, mismatch.message, false);
          result = await input.pressHotkey(action.keys);
          break;
        }
        case 'click_point': {
          driverKind = 'input';
          result = await input.clickPoint(action.x, action.y, action.button ?? 'left');
          break;
        }
        case 'scroll': {
          driverKind = 'input';
          result = await input.scroll(action.notches ?? -3, Boolean(action.horizontal));
          break;
        }
        case 'wait':
          await sleep(Math.min(Math.max(action.ms ?? 500, 0), 10000));
          result = { waitedMs: action.ms ?? 500 };
          break;
        case 'capture':
          result = await driver.call('capture', action.params ?? {}, 30000);
          break;
        default:
          throw new DriverError('ACTION_UNSUPPORTED', `action ${action.type} is not implemented`, false);
      }
    } catch (caught) {
      status = 'failed';
      error = {
        code: caught?.code ?? 'ACTION_FAILED',
        message: String(caught?.message ?? caught),
        retryable: Boolean(caught?.retryable),
      };
    }

    // Let the UI finish repainting before verifying, so a half-rendered frame is
    // never mistaken for a failed postcondition.
    let settle;
    if (settings.autoSettle && status === 'completed' && risk !== 'read') {
      settle = await settleScreen(action.windowHandle ?? driver.lastObservation?.windowHandle);
    }

    let verification;
    if (status !== 'completed') {
      verification = { status: 'unknown', evidence: { reason: 'action did not complete' } };
    } else if (result?.via === 'wm-settext' && typeof result.readBack === 'string' && result.readBack === action.value) {
      // The fallback already read the value back through WM_GETTEXT. That is a
      // direct measurement of the control's contents, stronger than an indirect
      // UIA lookup — and it is the only evidence available for controls that
      // expose neither ValuePattern nor a readable value field.
      verification = { status: 'passed', evidence: { matchedBy: 'wm-settext-readback', readBack: result.readBack } };
    } else {
      verification = await evaluatePostcondition(envelope.expectedPostcondition, {
        observe: (params) => driver.observe(params),
        windowHandle: action.windowHandle ?? driver.lastObservation?.windowHandle,
      });
    }

    const receipt = {
      protocolVersion: PROTOCOL_VERSION,
      actionId: envelope.actionId,
      startedAt,
      finishedAt: new Date().toISOString(),
      driver: driverKind,
      status,
      outcome: classifyOutcome({ status, verification: verification.status, risk, executed: status === 'completed' }),
      inputMode,
      risk,
      reason: envelope.reason,
      observationId: envelope.observationId ?? driver.observationId,
      requireBackground: envelope.requireBackground === true,
      result: status === 'completed' ? result : undefined,
      error,
      verification,
      freshness: envelope.__freshness,
      settle,
    };
    receipts.append(receipt);
    return receipt;
  }

  // ---------- activity state for the Client overlay ----------
  /**
   * Last screenshot per window: fingerprint plus the file it was written to, so an
   * unchanged screen can answer "same as before" while still giving the caller a
   * usable path (capture -> OCR chains keep working).
   */
  const lastShots = new Map();

  const activity = {
    active: false,
    action: undefined,
    startedAt: undefined,
    lastOutcome: undefined,
    lastAction: undefined,
    lastFinishedAt: undefined,
    totalActions: 0,
  };

  /**
   * Wrap every action so the Web UI can show what is happening right now and offer
   * a stop. The wrapper cannot swallow failures: it re-throws nothing and always
   * returns the inner receipt.
   */
  async function executeEnvelope(envelope) {
    activity.active = true;
    activity.action = envelope?.action?.type;
    activity.startedAt = Date.now();
    activity.totalActions += 1;
    let receipt;
    try {
      receipt = await executeEnvelopeInner(envelope);
      return receipt;
    } finally {
      activity.active = false;
      activity.lastOutcome = receipt?.outcome;
      activity.lastAction = envelope?.action?.type;
      activity.lastFinishedAt = Date.now();
    }
  }

  /** Build an envelope from flat tool arguments. */
  function buildEnvelope(args) {
    const type = ACTION_MAP[args.action];
    if (type === undefined) throw new Error(`unsupported action: ${args.action}`);
    const action = { type };
    if (args.targetRef !== undefined) action.targetRef = args.targetRef;
    if (args.windowHandle !== undefined) action.windowHandle = args.windowHandle;
    if (args.value !== undefined) action.value = args.value;
    if (args.text !== undefined) action.text = args.text;
    if (args.keys !== undefined) action.keys = args.keys;
    if (args.x !== undefined) action.x = args.x;
    if (args.y !== undefined) action.y = args.y;
    if (args.button !== undefined) action.button = args.button;
    if (args.notches !== undefined) action.notches = args.notches;
    if (args.horizontal !== undefined) action.horizontal = args.horizontal;
    if (args.ms !== undefined) action.ms = args.ms;
    if (args.guardWindow !== undefined) action.guardWindow = args.guardWindow;
    if (type === 'invoke_ref' && args.background !== undefined) action.background = args.background;

    // `focus` is only meaningful if the window really became foreground, and Windows
    // can silently refuse activation (foreground lock), so verify it by default
    // instead of reporting an unverified success.
    const defaultKind = type === 'focus_window' ? 'window_focused' : 'none';
    const effectiveKind = args.expectKind ?? defaultKind;

    const expectedPostcondition = effectiveKind === 'none'
      ? { kind: 'none' }
      : {
        kind: effectiveKind,
        value: args.expectValue,
        targetRef: args.expectTargetRef,
        windowHandle: args.windowHandle,
        name: args.expectName,
        automationId: args.expectAutomationId,
        timeoutMs: args.expectTimeoutMs ?? 1500,
      };

    return {
      actionId: args.actionId ?? nextActionId(),
      action,
      reason: args.reason,
      expectedPostcondition,
      risk: args.risk ?? classifyRisk(action),
      timeoutMs: args.timeoutMs ?? 30000,
      approved: args.approved,
      observationId: args.observationId,
      requireBackground: args.requireBackground,
    };
  }

  /** Wait until the window repaints stop, so the next observation is stable. */
  async function settleScreen(windowHandle, maxMs = settings.settleMaxMs) {
    const started = Date.now();
    let previous;
    let samples = 0;
    while (Date.now() - started < maxMs) {
      let shot;
      try {
        shot = await driver.call('capture', { windowHandle, maxWidth: 480 }, 10000);
      } catch {
        break;
      }
      const current = hashShot(shot?.imageBase64);
      samples += 1;
      if (current !== undefined && current === previous) {
        return { settled: true, ms: Date.now() - started, samples };
      }
      previous = current;
      await sleep(150);
    }
    return { settled: false, ms: Date.now() - started, samples, reason: 'still repainting at the deadline' };
  }

  /**
   * Make a value lossless-JSON safe.
   *
   * The harness snapshots every tool result with `snapshotJsonValue`, which
   * rejects undefined, Date, BigInt, function, symbol, Map, Set, array holes and
   * cycles — any one of them makes the entire result invalid and the tool
   * unusable at runtime, while logs and ordinary assertions look fine.
   *
   * Conversions: Date -> ISO string, BigInt -> number, Map -> object,
   * Set -> array, function/symbol -> dropped, cycles -> "[circular]".
   * `null` is preserved because it carries meaning here.
   */
  function clean(value, seen) {
    if (value === undefined) return undefined;
    if (value === null) return null;

    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return Number.isFinite(value) || type !== 'number' ? value : String(value);
    }
    if (type === 'bigint') return Number(value);
    if (type === 'function' || type === 'symbol') return undefined;
    if (value instanceof Date) return value.toISOString();

    const track = seen ?? new WeakSet();
    if (type === 'object') {
      if (track.has(value)) return '[circular]';
      track.add(value);
      try {
        if (value instanceof Map) {
          const out = {};
          for (const [key, item] of value.entries()) {
            const cleaned = clean(item, track);
            if (cleaned !== undefined) out[String(key)] = cleaned;
          }
          return out;
        }
        if (value instanceof Set) {
          const out = [];
          for (const item of value.values()) {
            const cleaned = clean(item, track);
            if (cleaned !== undefined) out.push(cleaned);
          }
          return out;
        }
        if (Array.isArray(value)) {
          const out = [];
          for (const item of value) {
            // A hole reads as undefined; dropping it keeps the array dense, which is
            // what the snapshotter accepts.
            const cleaned = clean(item, track);
            if (cleaned !== undefined) out.push(cleaned);
          }
          return out;
        }
        const out = {};
        for (const [key, item] of Object.entries(value)) {
          const cleaned = clean(item, track);
          if (cleaned !== undefined) out[key] = cleaned;
        }
        return out;
      } finally {
        track.delete(value);
      }
    }
    return undefined;
  }

  // ---------- tool registration with a configurable toolset ----------
  // core = the six tools needed for a normal task; full = everything.
  const CORE_TOOLS = new Set(['cu_status', 'cu_observe', 'cu_find', 'cu_capture', 'cu_ocr', 'cu_read', 'cu_act', 'cu_abort', 'cu_guard']);
  const skippedTools = [];
  const reg = (tool) => {
    if (settings.toolset !== 'full' && !CORE_TOOLS.has(tool.name)) {
      skippedTools.push(tool.name);
      return;
    }
    const original = tool.execute ?? tool.handler;
    const wrapped = {
      ...tool,
      // Forward `exec`: it carries the execution context (signal, agent) that the
      // harness passes to every tool. Swallowing it would silently disable
      // cancellation and any tool that reads the context.
      execute: async (args, exec) => clean(await original(args, exec)),
    };
    ctx.tools.register(wrapped);
  };

  // ---------- cu_status ----------
  reg(defineTool({
    name: 'cu_status',
    description: 'Report Computer Use readiness: UIA driver path and running state, input layer (SendKeys helper) and OCR availability, driver capabilities, elevation, and the receipt log path. Call this first when any computer-use tool returns a driver error.',
    parameters: {},
    output: { schema: { type: 'json' }, render: textRender },
    async execute() {
      let driverStatus;
      try {
        driverStatus = await driver.statusCall();
      } catch (error) {
        driverStatus = { available: false, error: { code: error?.code ?? 'DRIVER_ERROR', message: String(error?.message ?? error) } };
      }
      return {
        plugin: name,
        protocolVersion: PROTOCOL_VERSION,
        transport: driver.status(),
        driver: driverStatus,
        input: input.status,
        ocr: { available: ocr.available },
        guard: {
          allowedApps: settings.allowedApps,
          observationTtlMs: settings.ttlMs,
          staleCheckPixels: settings.staleCheckPixels,
          autoSettle: settings.autoSettle,
          aborted: abort.requested,
        },
        tools: { toolset: settings.toolset, skipped: skippedTools },
        receiptLog: receipts.path(),
      };
    },
  }));

  // ---------- cu_observe ----------
  reg(defineTool({
    name: 'cu_observe',
    description: 'Read the Windows desktop as structured text: window list plus the target window accessibility tree with compact refs (uia:rN), names, control types, bounds and whether each element can be invoked or set. Refs are scoped to the returned observationId - pass that id back when acting. Use windowHandle to target a specific window; omit it to observe the foreground window.',
    parameters: {
      windowHandle: { type: 'number', description: 'Target window handle from a previous cu_observe windows list. Omit for the foreground window.' },
      maxWindows: { type: 'number', description: 'Maximum windows to list (1-100, default 20).' },
      maxElements: { type: 'number', description: 'Maximum elements in the target tree (1-2000, default 250).' },
      maxDepth: { type: 'number', description: 'Tree depth limit (0-20, default 6).' },
      withPixels: { type: 'boolean', description: 'Also capture the window and store its pixel fingerprint, enabling pixel-level staleness checks on later actions. Costs one capture (~0.3s).' },
      autoOcr: { type: 'string', description: 'OCR fallback for useless trees: auto (default, only when the tree is sparse), on (always), off. Costs one capture + OCR (~2s) when it runs.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      const observation = await driver.observe({
        windowHandle: args.windowHandle,
        maxWindows: args.maxWindows,
        maxElements: args.maxElements,
        maxDepth: args.maxDepth,
      });
      let shotHash;
      if (args.withPixels === true) {
        try {
          const shot = await driver.call('capture', { windowHandle: observation.targetWindow?.handle ?? args.windowHandle, maxWidth: 640 }, 20000);
          shotHash = hashShot(shot?.imageBase64);
          observation.shotHash = shotHash;
        } catch (error) {
          observation.pixelFingerprintError = String(error?.message ?? error);
        }
      }
      const exePath = await resolveExePath(observation.targetWindow?.processId);
      const entry = freshness.record(observation, { exePath });

      // OCR fallback: an empty or nameless tree usually means a custom-drawn or
      // Electron surface, where pixels are the only readable source. Only pay the
      // ~2s cost when the tree actually looks useless, unless asked explicitly.
      const elements = observation.targetWindow?.elements ?? [];
      const named = elements.filter((e) => String(e.name ?? '').trim() !== '').length;
      const interactive = elements.filter((e) => e.canInvoke === true || e.canSetValue === true).length;
      const sparse = elements.length < 8 || interactive === 0 || named / Math.max(elements.length, 1) < 0.3;
      const mode = String(args.autoOcr ?? 'auto').toLowerCase();
      const wantOcr = mode === 'on' || (mode !== 'off' && sparse);

      let ocrSummary;
      if (wantOcr) {
        try {
          const shot = await driver.call('capture', { windowHandle: observation.targetWindow?.handle ?? args.windowHandle, maxWidth: 1600 }, 25000);
          const base64 = shot?.imageBase64 ?? shot?.image ?? shot?.png;
          if (typeof base64 === 'string') {
            const result = await ocr.recognizeBase64(base64);
            // Keep only what a text model can act on: text plus its anchor point.
            ocrSummary = {
              triggered: mode === 'on' ? 'explicit' : 'sparse-tree',
              engineLanguage: result.engineLanguage,
              lineCount: result.lineCount,
              truncated: (result.lines?.length ?? 0) > 40,
              lines: (result.lines ?? []).slice(0, 40).map((line) => ({
                text: String(line.text ?? '').slice(0, 120),
                x: line.x,
                y: line.y,
              })),
            };
          }
        } catch (error) {
          ocrSummary = { triggered: 'sparse-tree', error: String(error?.message ?? error).slice(0, 200) };
        }
      }

      return {
        ...observation,
        ...(ocrSummary ? { ocr: ocrSummary } : {}),
        freshness: {
          identity: entry.identity,
          treeHash: entry.treeHash,
          shotHash: entry.shotHash,
          ttlMs: settings.ttlMs,
        },
      };
    },
  }));

  // ---------- cu_find ----------
  reg(defineTool({
    name: 'cu_find',
    description: 'Search the target window for elements matching a query and return only the matches, with fresh refs and their observationId. Cheaper than reading a whole tree: use it to locate a button or field by name/automationId/controlType before acting. The returned refs are usable by cu_act immediately.',
    parameters: {
      query: { type: 'string', description: 'Text to look for. Case-insensitive substring unless by="regex".', required: true },
      windowHandle: { type: 'number', description: 'Window to search; defaults to the foreground window.' },
      by: { type: 'string', description: 'Match field: auto (default, name+automationId+controlType+value), name, automationId, controlType, value, or regex (applied to name and automationId).' },
      interactiveOnly: { type: 'boolean', description: 'Only return elements that can be invoked or set (buttons, fields).' },
      maxResults: { type: 'number', description: 'Maximum matches to return (default 20, max 100).' },
      maxElements: { type: 'number', description: 'How many elements to scan (default 800, max 2000).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      const query = String(args.query ?? '');
      if (query === '') throw new Error('query is required');
      const limit = Math.min(Math.max(args.maxResults ?? 20, 1), 100);

      const observation = await driver.observe({
        windowHandle: args.windowHandle,
        maxWindows: 20,
        maxElements: Math.min(Math.max(args.maxElements ?? 800, 1), 2000),
        maxDepth: 12,
      });
      const exePath = await resolveExePath(observation.targetWindow?.processId);
      const entry = freshness.record(observation, { exePath });
      const all = observation.targetWindow?.elements ?? [];

      const by = String(args.by ?? 'auto').toLowerCase();
      const needle = query.toLowerCase();
      let matcher;
      if (by === 'regex') {
        let re;
        try {
          re = new RegExp(query, 'i');
        } catch (error) {
          throw new Error(`invalid regex: ${error?.message ?? error}`);
        }
        matcher = (element) => re.test(String(element.name ?? '')) || re.test(String(element.automationId ?? ''));
      } else if (by === 'name') {
        matcher = (element) => String(element.name ?? '').toLowerCase().includes(needle);
      } else if (by === 'automationid') {
        matcher = (element) => String(element.automationId ?? '').toLowerCase().includes(needle);
      } else if (by === 'controltype') {
        matcher = (element) => String(element.controlType ?? '').toLowerCase().includes(needle);
      } else if (by === 'value') {
        matcher = (element) => String(element.value ?? '').toLowerCase().includes(needle);
      } else {
        matcher = (element) => ['name', 'automationId', 'controlType', 'value']
          .some((field) => String(element[field] ?? '').toLowerCase().includes(needle));
      }

      const filtered = all.filter((element) => matcher(element)
        && (args.interactiveOnly === true ? (element.canInvoke === true || element.canSetValue === true) : true));

      const interactive = all.filter((e) => e.canInvoke === true || e.canSetValue === true).length;

      return {
        observationId: observation.observationId,
        window: observation.targetWindow
          ? { handle: observation.targetWindow.handle, name: observation.targetWindow.name, processId: observation.targetWindow.processId }
          : undefined,
        scanned: all.length,
        interactive,
        matched: filtered.length,
        truncated: filtered.length > limit,
        elements: filtered.slice(0, limit),
        freshness: { treeHash: entry.treeHash, ttlMs: settings.ttlMs },
        ...(filtered.length === 0 && all.length > 0 && interactive === 0
          ? { hint: 'no interactive elements in this tree — the UI is probably custom-drawn; try cu_capture + cu_ocr to read it' }
          : {}),
      };
    },
  }));

  // ---------- cu_capture ----------
  reg(defineTool({
    name: 'cu_capture',
    description: 'Capture one window (or monitor, or a region) to a PNG file and return its path plus dimensions. Background-first: uses PrintWindow so occluded windows still capture; only activates the window when allowForeground is true. The file can be read with an image tool or passed to cu_ocr.',
    parameters: {
      windowHandle: { type: 'number', description: 'Window handle to capture. Omit with monitorHandle to capture a whole monitor.' },
      monitorHandle: { type: 'number', description: 'Monitor handle from cu_monitors. Mutually exclusive with windowHandle.' },
      maxWidth: { type: 'number', description: 'Downscale bound in pixels (320-3840). Smaller is cheaper for OCR and vision.' },
      allowForeground: { type: 'boolean', description: 'Allow bringing the window to the foreground when PrintWindow fails (default false).' },
      regionX: { type: 'number', description: 'Crop left edge in window-local pixels. Requires all four region fields.' },
      regionY: { type: 'number', description: 'Crop top edge in window-local pixels.' },
      regionWidth: { type: 'number', description: 'Crop width in pixels.' },
      regionHeight: { type: 'number', description: 'Crop height in pixels.' },
      dedupe: { type: 'boolean', description: 'When the window looks identical to the last capture, return unchanged=true instead of another image (saves tokens). Default true; pass false to force an image.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      if (args.windowHandle !== undefined && args.monitorHandle !== undefined) {
        throw new Error('Use windowHandle or monitorHandle, not both.');
      }
      // The driver crops from top-level x/y/width/height, not a nested region object.
      const crop = (args.regionX !== undefined && args.regionY !== undefined && args.regionWidth !== undefined && args.regionHeight !== undefined)
        ? { x: args.regionX, y: args.regionY, width: args.regionWidth, height: args.regionHeight }
        : {};
      const raw = await driver.call('capture', {
        windowHandle: args.windowHandle,
        monitorHandle: args.monitorHandle,
        maxWidth: args.maxWidth,
        allowForeground: args.allowForeground,
        ...crop,
      }, 30000);
      const base64 = raw?.imageBase64 ?? raw?.image ?? raw?.png;
      if (typeof base64 !== 'string') {
        throw new Error(`capture returned no image: ${JSON.stringify(raw).slice(0, 300)}`);
      }
      const shotHash = hashShot(base64);
      const shotKey = args.windowHandle ?? args.monitorHandle ?? 'screen';

      // Skip an identical frame: re-sending the same pixels spends tokens to say
      // nothing. The caller can force an image with dedupe:false.
      const previous = lastShots.get(shotKey);
      if (args.dedupe !== false && previous !== undefined && previous.hash === shotHash) {
        return {
          unchanged: true,
          windowHandle: args.windowHandle,
          shotHash,
          path: previous.path,
          bytes: previous.bytes,
          note: 'no visible change since the last capture; reusing the previous file (pass dedupe:false to force a new image)',
        };
      }

      const dir = join(tmpdir(), 'dsh-kv-cu');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `capture_${Date.now().toString(36)}.png`);
      const bytes = Buffer.from(base64, 'base64');
      writeFileSync(file, bytes);
      lastShots.set(shotKey, { hash: shotHash, path: file, bytes: bytes.length });
      // A capture doubles as a pixel fingerprint for the current observation.
      freshness.attachShot(driver.observationId, base64);
      const { imageBase64, image, png, ...metadata } = raw;
      return { path: file, bytes: bytes.length, shotHash, ...metadata };
    },
  }));

  // ---------- cu_ocr ----------
  reg(defineTool({
    name: 'cu_ocr',
    description: 'Run Windows OCR over a captured window and return recognised lines with word-level pixel coordinates. This is how a text-only model reads custom-drawn UI, canvas or an image-only window. Supply windowHandle (captures first) or imagePath from cu_capture.',
    parameters: {
      windowHandle: { type: 'number', description: 'Window to capture and OCR. Omit when using imagePath.' },
      imagePath: { type: 'string', description: 'Existing PNG path from cu_capture.' },
      language: { type: 'string', description: 'OCR language tag such as zh-Hans or en-US. Defaults to the user profile languages.' },
      maxWidth: { type: 'number', description: 'Downscale bound before OCR (default 1600).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      let base64;
      if (typeof args.imagePath === 'string' && args.imagePath !== '') {
        const { readFileSync } = await import('node:fs');
        base64 = readFileSync(args.imagePath).toString('base64');
      } else {
        const raw = await driver.call('capture', {
          windowHandle: args.windowHandle,
          maxWidth: args.maxWidth ?? 1600,
        }, 30000);
        base64 = raw?.imageBase64 ?? raw?.image ?? raw?.png;
        if (typeof base64 !== 'string') throw new Error('capture returned no image to OCR');
      }
      const result = await ocr.recognizeBase64(base64, { language: args.language });
      return result;
    },
  }));

  // ---------- cu_read ----------
  reg(defineTool({
    name: 'cu_read',
    description: 'Read text out of one control through UIA: TextPattern first, then ValuePattern, then WM_GETTEXT. Use it when cu_observe shows an element with no value field — document, rich-text, WinForms and Electron surfaces expose their contents only this way. Renderer independent, so it also works when the desktop is locked or the window is occluded.',
    parameters: {
      windowHandle: { type: 'number', description: 'Window handle; defaults to the last observed window.' },
      targetRef: { type: 'string', description: 'Element ref from cu_observe (uia:rN).', required: true },
      maxChars: { type: 'number', description: 'Maximum characters to return (default 2000).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      const element = driver.resolveRef(args.targetRef);
      const realRef = element?.ref;
      if (typeof realRef !== 'string' || !realRef.startsWith('uia:')) {
        throw new Error(`element ${args.targetRef} carries no usable uia: runtime id`);
      }
      return await textReader.readText({
        windowHandle: args.windowHandle ?? driver.lastObservation?.windowHandle,
        runtimeId: realRef,
        maxChars: args.maxChars ?? 2000,
      });
    },
  }));

  // ---------- cu_act ----------
  reg(defineTool({
    name: 'cu_act',
    description: 'Execute exactly one desktop action and return a receipt. Actions: invoke (semantic button press by ref), set_value (write into a field by ref), type (real keystrokes into the focused control), hotkey (key combination), click (pixel coordinate), scroll, focus, wait. PREFER set_value for text entry: it works in the background through UIA (ValuePattern, then WM_SETTEXT) and needs no window activation. type requires the target window to be foreground and Windows may refuse to activate a window that is not already in front, so keystrokes can land elsewhere - use type only when set_value reports that the control exposes no writable pattern. focus verifies activation via a window_focused postcondition by default. Every call requires a reason and is verified against expectKind before it is reported as VERIFIED. Outcome is one of VERIFIED, HALTED_BEFORE_EFFECT, COMPLETED_UNVERIFIED, RECONCILIATION_REQUIRED, FAILED. Set requireBackground=true to refuse anything that would move the shared cursor or steal focus.',
    parameters: {
      action: { type: 'string', description: 'One of: invoke, set_value, type, hotkey, click, scroll, focus, wait.', required: true },
      reason: { type: 'string', description: 'Why this action is being taken. Required and recorded in the receipt.', required: true },
      targetRef: { type: 'string', description: 'Element ref from cu_observe (uia:rN) for invoke/set_value.' },
      windowHandle: { type: 'number', description: 'Target window handle. For type/hotkey this is also the foreground guard.' },
      value: { type: 'string', description: 'Value for set_value.' },
      text: { type: 'string', description: 'Text to type for type (unicode safe, Chinese supported).' },
      keys: { type: 'array', description: 'Key list for hotkey, e.g. ["ctrl","shift","s"] or ["enter"].' },
      x: { type: 'number', description: 'Screen x for click.' },
      y: { type: 'number', description: 'Screen y for click.' },
      button: { type: 'string', description: 'click button: left (default), right, middle.' },
      notches: { type: 'number', description: 'Scroll notches; positive is up/right, default -3 (down).' },
      ms: { type: 'number', description: 'Wait duration for wait (max 10000).' },
      expectKind: { type: 'string', description: 'Postcondition to verify: none, text_present, value_equals, window_focused, element_exists, element_absent, driver_result.' },
      expectValue: { type: 'string', description: 'Expected text for text_present / value_equals.' },
      expectTargetRef: { type: 'string', description: 'Element ref for element_exists / element_absent.' },
      expectName: { type: 'string', description: 'Element name matcher for element_exists / element_absent.' },
      expectAutomationId: { type: 'string', description: 'AutomationId matcher for element_exists / element_absent.' },
      expectTimeoutMs: { type: 'number', description: 'How long to poll the postcondition (default 1500).' },
      requireBackground: { type: 'boolean', description: 'Refuse any action that needs focus or cursor movement.' },
      approved: { type: 'boolean', description: 'Explicit approval for destructive/external-write actions.' },
      guardWindow: { type: 'boolean', description: 'For type/hotkey: verify the target window is foreground first (default true). Set false to skip.' },
      risk: { type: 'string', description: 'Risk level override. May only escalate, never downgrade: read, reversible-write, external-write, destructive.' },
      observationId: { type: 'string', description: 'Observation the refs came from.' },
      timeoutMs: { type: 'number', description: 'Action timeout in ms (max 120000).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      const envelope = buildEnvelope(args);
      return await executeEnvelope(envelope);
    },
  }));

  // ---------- cu_sequence ----------
  reg(defineTool({
    name: 'cu_sequence',
    description: 'Run up to 10 actions in one call, serially, stopping at the first blocked or failed step. Cheaper than multiple cu_act calls because it needs one model round-trip. Each step takes the same fields as cu_act plus stepId.',
    parameters: {
      sequenceId: { type: 'string', description: 'Optional stable id for this sequence.' },
      steps: { type: 'array', description: 'Array of step objects: {stepId, action, reason, expectKind?, ...cu_act fields}.', required: true },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      const sequenceId = typeof args.sequenceId === 'string' && args.sequenceId !== '' ? args.sequenceId : nextActionId('seq');
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (steps.length === 0) throw new Error('steps must contain at least one step');
      if (steps.length > 10) throw new Error('a sequence may contain at most 10 steps');

      const startedAt = new Date().toISOString();
      const stepReceipts = [];
      let stoppedAtStep;
      let completed = 0;

      for (const [index, step] of steps.entries()) {
        const stepId = typeof step?.stepId === 'string' && step.stepId !== '' ? step.stepId : `s${index + 1}`;
        let receipt;
        try {
          receipt = await executeEnvelope(buildEnvelope({ ...step, actionId: `${sequenceId}:${stepId}` }));
        } catch (error) {
          receipt = {
            protocolVersion: PROTOCOL_VERSION,
            actionId: `${sequenceId}:${stepId}`,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            driver: 'none',
            status: 'failed',
            outcome: 'FAILED',
            inputMode: 'background',
            risk: 'read',
            error: { code: 'STEP_INVALID', message: String(error?.message ?? error), retryable: false },
            verification: { status: 'unknown' },
          };
        }
        stepReceipts.push({ ...receipt, stepId });
        if (receipt.status === 'completed') {
          completed += 1;
          continue;
        }
        stoppedAtStep = stepId;
        break;
      }

      const failed = stepReceipts.some((receipt) => receipt.status === 'failed');
      const blocked = stepReceipts.some((receipt) => receipt.status === 'blocked');
      const status = completed === steps.length ? 'completed' : blocked ? 'blocked' : 'partially-completed';
      const outcomes = stepReceipts.map((receipt) => receipt.outcome);
      const outcome = outcomes.includes('RECONCILIATION_REQUIRED')
        ? 'RECONCILIATION_REQUIRED'
        : outcomes.includes('FAILED') && status !== 'blocked'
          ? 'FAILED'
          : outcomes.includes('HALTED_BEFORE_EFFECT')
            ? 'HALTED_BEFORE_EFFECT'
            : outcomes.includes('COMPLETED_UNVERIFIED') || failed
              ? 'COMPLETED_UNVERIFIED'
              : 'VERIFIED';

      const record = {
        protocolVersion: PROTOCOL_VERSION,
        sequenceId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        outcome,
        risk: 'reversible-write',
        inputMode: 'background',
        totalSteps: steps.length,
        completedSteps: completed,
        stoppedAtStep,
        skippedSteps: steps.slice(completed + (stoppedAtStep ? 1 : 0)).map((step, i) => step?.stepId ?? `s${completed + i + 2}`),
        stepReceipts,
      };
      receipts.append(record);
      return record;
    },
  }));

  // ---------- cu_monitors ----------
  reg(defineTool({
    name: 'cu_monitors',
    description: 'List monitors with bounds, work area, foreground monitor, and a recommendedAgentMonitor that avoids the screen the user is currently using. Use it to park an agent window on a second screen.',
    parameters: {},
    output: { schema: { type: 'json' }, render: textRender },
    async execute() {
      return await driver.call('list_monitors', {});
    },
  }));

  // ---------- cu_place_window ----------
  reg(defineTool({
    name: 'cu_place_window',
    description: 'Move a window into a monitor work area WITHOUT activating it, so the agent works on a side screen while the user keeps their own screen. Defaults to the recommended agent monitor.',
    parameters: {
      windowHandle: { type: 'number', description: 'Window handle to move.' },
      processId: { type: 'number', description: 'Alternative: move the main window of this process.' },
      monitorHandle: { type: 'number', description: 'Target monitor from cu_monitors. Omit for the recommended agent monitor.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      if (args.windowHandle === undefined && args.processId === undefined) {
        throw new Error('windowHandle or processId is required');
      }
      return await driver.call('place_window', {
        windowHandle: args.windowHandle,
        processId: args.processId,
        monitorHandle: args.monitorHandle,
      });
    },
  }));

  // ---------- cu_abort ----------
  reg(defineTool({
    name: 'cu_abort',
    description: 'Emergency stop for desktop actions. Setting it makes every mutating action return HALTED_BEFORE_EFFECT until cleared, so the model cannot keep clicking after the user says stop. Read-only tools keep working. Call with clear=true to resume.',
    parameters: {
      clear: { type: 'boolean', description: 'Clear the stop flag instead of setting it.' },
      reason: { type: 'string', description: 'Why the stop was requested (recorded on every refused action).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      if (args.clear === true) {
        abort.requested = false;
        abort.reason = undefined;
        return { stopped: false };
      }
      abort.requested = true;
      abort.reason = typeof args.reason === 'string' && args.reason !== '' ? args.reason : 'no reason given';
      return { stopped: true, reason: abort.reason };
    },
  }));

  // ---------- cu_guard ----------
  reg(defineTool({
    name: 'cu_guard',
    description: 'Explain and test the action guard: application scope, observation TTL, pixel staleness checks, abort state, and whether a given label counts as dangerous or a credential field. Use it when an action was refused and you need to know why.',
    parameters: {
      label: { type: 'string', description: 'Optional target label to test against the dangerous-word and credential-field rules.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      const label = typeof args.label === 'string' ? args.label : '';
      return {
        allowedApps: settings.allowedApps,
        observationTtlMs: settings.ttlMs,
        staleCheckPixels: settings.staleCheckPixels,
        autoSettle: settings.autoSettle,
        verifyExecutable: settings.verifyExecutable,
        toolset: settings.toolset,
        aborted: abort.requested,
        abortReason: abort.reason,
        observations: [...freshness.records.values()].map((entry) => ({
          observationId: entry.observationId,
          windowHandle: entry.windowHandle,
          treeHash: entry.treeHash,
          shotHash: entry.shotHash,
          ageMs: Date.now() - entry.at,
          fresh: Date.now() - entry.at <= settings.ttlMs,
        })),
        test: label === '' ? undefined : {
          label,
          dangerous: isDangerousLabel(label),
          credentialField: isSecureField({ name: label, automationId: label }),
        },
      };
    },
  }));

  // ---------- cu_receipts ----------
  reg(defineTool({
    name: 'cu_receipts',
    description: 'Read persisted action receipts: what was attempted, why, the input mode, the five-state outcome and the verification evidence. Use it to audit a previous turn or to recover after RECONCILIATION_REQUIRED.',
    parameters: {
      limit: { type: 'number', description: 'How many recent receipts (default 20, max 200).' },
      actionId: { type: 'string', description: 'Fetch one receipt by actionId or sequenceId instead of the recent list.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    async execute(args) {
      if (typeof args.actionId === 'string' && args.actionId !== '') {
        const found = receipts.find(args.actionId);
        return found ?? { found: false, actionId: args.actionId };
      }
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 200);
      return { receiptLog: receipts.path(), receipts: receipts.recent(limit) };
    },
  }));

  log('plugin_applied', {
    driver: driver.status(),
    input: input.status,
    ocr: ocr.available,
    receiptLog: receipts.path(),
  });
}

export default { name, inject, apply };
