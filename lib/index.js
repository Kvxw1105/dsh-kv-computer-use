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

export const name = 'dsh-kv-computer-use';
export const inject = ['tools'];

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

export function apply(ctx) {
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
  const receipts = new ReceiptStore();

  ctx.effect(() => () => {
    void driver.close();
  }, 'dsh-kv-computer-use.driver');

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
  async function executeEnvelope(envelope) {
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
          result = await driver.call('set_value_ref', {
            targetRef,
            value: action.value,
            windowHandle: action.windowHandle,
          }, envelope.timeoutMs ?? 30000);
          break;
        }
        case 'type_text': {
          driverKind = 'input';
          const mismatch = action.guardWindow === false ? undefined : await guardWindow(action.windowHandle);
          if (mismatch) throw new DriverError(mismatch.code, mismatch.message, false);
          result = await input.typeText(action.text);
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

    const verification = status === 'completed'
      ? await evaluatePostcondition(envelope.expectedPostcondition, {
        observe: (params) => driver.observe(params),
        windowHandle: action.windowHandle ?? driver.lastObservation?.windowHandle,
      })
      : { status: 'unknown', evidence: { reason: 'action did not complete' } };

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
    };
    receipts.append(receipt);
    return receipt;
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

    const expectedPostcondition = args.expectKind === undefined || args.expectKind === 'none'
      ? { kind: 'none' }
      : {
        kind: args.expectKind,
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

  // ---------- cu_status ----------
  ctx.tools.register(defineTool({
    name: 'cu_status',
    description: 'Report Computer Use readiness: UIA driver path and running state, input layer (SendKeys helper) and OCR availability, driver capabilities, elevation, and the receipt log path. Call this first when any computer-use tool returns a driver error.',
    parameters: {},
    output: { schema: { type: 'json' } },
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
        receiptLog: receipts.path(),
      };
    },
  }));

  // ---------- cu_observe ----------
  ctx.tools.register(defineTool({
    name: 'cu_observe',
    description: 'Read the Windows desktop as structured text: window list plus the target window accessibility tree with compact refs (uia:rN), names, control types, bounds and whether each element can be invoked or set. Refs are scoped to the returned observationId - pass that id back when acting. Use windowHandle to target a specific window; omit it to observe the foreground window.',
    parameters: {
      windowHandle: { type: 'number', description: 'Target window handle from a previous cu_observe windows list. Omit for the foreground window.' },
      maxWindows: { type: 'number', description: 'Maximum windows to list (1-100, default 20).' },
      maxElements: { type: 'number', description: 'Maximum elements in the target tree (1-2000, default 250).' },
      maxDepth: { type: 'number', description: 'Tree depth limit (0-20, default 6).' },
    },
    output: { schema: { type: 'json' } },
    async execute(args) {
      const observation = await driver.observe({
        windowHandle: args.windowHandle,
        maxWindows: args.maxWindows,
        maxElements: args.maxElements,
        maxDepth: args.maxDepth,
      });
      return observation;
    },
  }));

  // ---------- cu_capture ----------
  ctx.tools.register(defineTool({
    name: 'cu_capture',
    description: 'Capture one window (or monitor, or a region) to a PNG file and return its path plus dimensions. Background-first: uses PrintWindow so occluded windows still capture; only activates the window when allowForeground is true. The file can be read with an image tool or passed to cu_ocr.',
    parameters: {
      windowHandle: { type: 'number', description: 'Window handle to capture. Omit with monitorHandle to capture a whole monitor.' },
      monitorHandle: { type: 'number', description: 'Monitor handle from cu_monitors. Mutually exclusive with windowHandle.' },
      maxWidth: { type: 'number', description: 'Downscale bound in pixels (320-3840). Smaller is cheaper for OCR and vision.' },
      allowForeground: { type: 'boolean', description: 'Allow bringing the window to the foreground when PrintWindow fails (default false).' },
      region: { type: 'object', description: 'Optional crop region {x, y, width, height} in window-local pixels.' },
    },
    output: { schema: { type: 'json' } },
    async execute(args) {
      if (args.windowHandle !== undefined && args.monitorHandle !== undefined) {
        throw new Error('Use windowHandle or monitorHandle, not both.');
      }
      const raw = await driver.call('capture', {
        windowHandle: args.windowHandle,
        monitorHandle: args.monitorHandle,
        maxWidth: args.maxWidth,
        allowForeground: args.allowForeground,
        ...(args.region ?? {}),
      }, 30000);
      const base64 = raw?.imageBase64 ?? raw?.image ?? raw?.png;
      if (typeof base64 !== 'string') {
        throw new Error(`capture returned no image: ${JSON.stringify(raw).slice(0, 300)}`);
      }
      const dir = join(tmpdir(), 'dsh-kv-cu');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `capture_${Date.now().toString(36)}.png`);
      writeFileSync(file, Buffer.from(base64, 'base64'));
      const { imageBase64, image, png, ...metadata } = raw;
      return { path: file, bytes: Buffer.from(base64, 'base64').length, ...metadata };
    },
  }));

  // ---------- cu_ocr ----------
  ctx.tools.register(defineTool({
    name: 'cu_ocr',
    description: 'Run Windows OCR over a captured window and return recognised lines with word-level pixel coordinates. This is how a text-only model reads custom-drawn UI, canvas or an image-only window. Supply windowHandle (captures first) or imagePath from cu_capture.',
    parameters: {
      windowHandle: { type: 'number', description: 'Window to capture and OCR. Omit when using imagePath.' },
      imagePath: { type: 'string', description: 'Existing PNG path from cu_capture.' },
      language: { type: 'string', description: 'OCR language tag such as zh-Hans or en-US. Defaults to the user profile languages.' },
      maxWidth: { type: 'number', description: 'Downscale bound before OCR (default 1600).' },
    },
    output: { schema: { type: 'json' } },
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

  // ---------- cu_act ----------
  ctx.tools.register(defineTool({
    name: 'cu_act',
    description: 'Execute exactly one desktop action and return a receipt. Actions: invoke (semantic button press by ref), set_value (write into a field by ref), type (unicode text into the focused window), hotkey (key combination), click (pixel coordinate), scroll, focus, wait. Every call requires a reason and is verified against expectKind before it is reported as VERIFIED. Outcome is one of VERIFIED, HALTED_BEFORE_EFFECT, COMPLETED_UNVERIFIED, RECONCILIATION_REQUIRED, FAILED. Set requireBackground=true to refuse anything that would move the shared cursor or steal focus.',
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
    output: { schema: { type: 'json' } },
    async execute(args) {
      const envelope = buildEnvelope(args);
      return await executeEnvelope(envelope);
    },
  }));

  // ---------- cu_sequence ----------
  ctx.tools.register(defineTool({
    name: 'cu_sequence',
    description: 'Run up to 10 actions in one call, serially, stopping at the first blocked or failed step. Cheaper than multiple cu_act calls because it needs one model round-trip. Each step takes the same fields as cu_act plus stepId.',
    parameters: {
      sequenceId: { type: 'string', description: 'Optional stable id for this sequence.' },
      steps: { type: 'array', description: 'Array of step objects: {stepId, action, reason, expectKind?, ...cu_act fields}.', required: true },
    },
    output: { schema: { type: 'json' } },
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
  ctx.tools.register(defineTool({
    name: 'cu_monitors',
    description: 'List monitors with bounds, work area, foreground monitor, and a recommendedAgentMonitor that avoids the screen the user is currently using. Use it to park an agent window on a second screen.',
    parameters: {},
    output: { schema: { type: 'json' } },
    async execute() {
      return await driver.call('list_monitors', {});
    },
  }));

  // ---------- cu_place_window ----------
  ctx.tools.register(defineTool({
    name: 'cu_place_window',
    description: 'Move a window into a monitor work area WITHOUT activating it, so the agent works on a side screen while the user keeps their own screen. Defaults to the recommended agent monitor.',
    parameters: {
      windowHandle: { type: 'number', description: 'Window handle to move.' },
      processId: { type: 'number', description: 'Alternative: move the main window of this process.' },
      monitorHandle: { type: 'number', description: 'Target monitor from cu_monitors. Omit for the recommended agent monitor.' },
    },
    output: { schema: { type: 'json' } },
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

  // ---------- cu_receipts ----------
  ctx.tools.register(defineTool({
    name: 'cu_receipts',
    description: 'Read persisted action receipts: what was attempted, why, the input mode, the five-state outcome and the verification evidence. Use it to audit a previous turn or to recover after RECONCILIATION_REQUIRED.',
    parameters: {
      limit: { type: 'number', description: 'How many recent receipts (default 20, max 200).' },
      actionId: { type: 'string', description: 'Fetch one receipt by actionId or sequenceId instead of the recent list.' },
    },
    output: { schema: { type: 'json' } },
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
