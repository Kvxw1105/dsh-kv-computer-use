/**
 * Harness test: mount the plugin with a fake Cordis context and drive the tool
 * surface directly. Verifies the refusal paths end-to-end without moving the
 * mouse or keyboard: every mutating call here is expected to be refused.
 *
 * Run: node test/harness.mjs
 */

import { apply } from '../lib/index.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const tools = new Map();
const disposers = [];
const ctx = {
  tools: {
    register(tool) {
      // duplicate registration is a hard error in the real harness
      if (tools.has(tool.name)) throw new Error(`tool ${tool.name} already registered`);
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
  },
  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  },
  get() {
    return undefined;
  },
};

apply(ctx, { toolset: 'core' });

console.log(`registered: ${[...tools.keys()].join(', ')}`);
check('core toolset registers nine tools', tools.size === 9, `${tools.size} tools`);
for (const required of ['cu_status', 'cu_observe', 'cu_find', 'cu_capture', 'cu_ocr', 'cu_read', 'cu_act', 'cu_abort', 'cu_guard']) {
  check(`tool present: ${required}`, tools.has(required));
}
check('full-only tools skipped in core', !tools.has('cu_sequence') && !tools.has('cu_receipts'));

const invoke = async (name, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no such tool ${name}`);
  const fn = tool.execute ?? tool.handler ?? tool.run;
  if (typeof fn !== 'function') throw new Error(`tool ${name} exposes no callable (keys: ${Object.keys(tool).join(',')})`);
  return await fn(args);
};

// ---------- status ----------
const status = await invoke('cu_status');
check('status: driver reachable', status?.driver?.protocolVersion === 1, `pid=${status?.driver?.processId}`);
check('status: guard config present', status?.guard?.observationTtlMs > 0, JSON.stringify(status?.guard));
check('status: toolset reported', status?.tools?.toolset === 'core', JSON.stringify(status?.tools));

// ---------- act without any observation must be refused ----------
const noObs = await invoke('cu_act', {
  action: 'invoke',
  reason: 'harness: no observation yet',
  targetRef: 'uia:r1',
});
check('act without observation: halted before effect',
  noObs?.outcome === 'HALTED_BEFORE_EFFECT' && noObs?.status === 'blocked',
  `${noObs?.error?.code}: ${noObs?.error?.message?.slice(0, 80)}`);

// ---------- observe ----------
const observation = await invoke('cu_observe', { maxWindows: 6, maxElements: 40, maxDepth: 6 });
check('observe: observationId', typeof observation?.observationId === 'string', observation?.observationId);
check('observe: freshness recorded', typeof observation?.freshness?.treeHash === 'string',
  `tree=${observation?.freshness?.treeHash?.slice(0, 12)} identity=${JSON.stringify(observation?.freshness?.identity)}`);
const obsId = observation.observationId;

// ---------- act with a bogus ref must be refused, not executed ----------
const badRef = await invoke('cu_act', {
  action: 'invoke',
  reason: 'harness: bogus ref',
  targetRef: 'uia:r9999',
  observationId: obsId,
});
check('act with unknown ref: refused', badRef?.outcome === 'HALTED_BEFORE_EFFECT', badRef?.error?.code);

// ---------- expired observation must be refused ----------
const expired = await invoke('cu_act', {
  action: 'invoke',
  reason: 'harness: expired observation',
  targetRef: 'uia:r1',
  observationId: 'obs_does_not_exist',
});
check('act citing unknown observation: refused', expired?.outcome === 'HALTED_BEFORE_EFFECT', expired?.error?.code);

// ---------- credential field guard ----------
const pw = await invoke('cu_act', {
  action: 'type',
  reason: 'harness: credential field',
  text: 'hunter2',
  observationId: obsId,
});
check('act typing without target window: refused', pw?.outcome === 'HALTED_BEFORE_EFFECT', pw?.error?.code);

// ---------- abort switch ----------
const stop = await invoke('cu_abort', { reason: 'harness stop' });
check('abort: sets flag', stop?.stopped === true);
const whileStopped = await invoke('cu_act', {
  action: 'invoke',
  reason: 'harness: while stopped',
  targetRef: 'uia:r1',
  observationId: obsId,
});
check('abort: mutating action refused', whileStopped?.error?.code === 'ABORTED_BY_USER', whileStopped?.error?.message?.slice(0, 60));
const cleared = await invoke('cu_abort', { clear: true });
check('abort: clears', cleared?.stopped === false);

// ---------- guard introspection ----------
const guard = await invoke('cu_guard', { label: '删除全部' });
check('guard: explains dangerous label', guard?.test?.dangerous === true);
check('guard: lists observations', Array.isArray(guard?.observations) && guard.observations.length > 0,
  `${guard?.observations?.length} tracked`);

// ---------- receipts carry the refusals ----------
const receiptFile = status.receiptLog;
check('receipts: log path', typeof receiptFile === 'string' && receiptFile.endsWith('receipts.jsonl'), receiptFile);

for (const dispose of disposers.reverse()) {
  try {
    dispose();
  } catch {
    // ignore teardown noise
  }
}

console.log(`\n${failures === 0 ? 'ALL HARNESS CHECKS PASSED' : `${failures} HARNESS CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
