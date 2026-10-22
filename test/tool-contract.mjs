/**
 * Tool contract test: reproduce the harness tool pipeline locally.
 *
 * Three independent ways a tool can be registered successfully and still be dead
 * at runtime, all of which log cleanly and pass ordinary assertions:
 *
 *   1. output.render missing -> "output.render failed: userRender is not a function"
 *      (defineTool wraps it unconditionally)
 *   2. result containing a non-JSON value -> "value is not lossless JSON"
 *   3. execute throwing on the empty/edge argument set the model actually sends
 *
 * This test mounts the plugin, then for every registered tool: calls the renderer,
 * executes with a minimal argument set, and snapshots the result with the harness's
 * own predicate.
 *
 * Run: node test/tool-contract.mjs
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

// Real harness predicate.
let snapshotJsonValue;
for (const candidate of ['@deepseek-ai/dsh-util-values', 'file:///D:/DSH-rc2/packages/util/values/lib/index.js']) {
  try {
    const mod = await import(candidate);
    if (typeof mod.snapshotJsonValue === 'function') { snapshotJsonValue = mod.snapshotJsonValue; break; }
  } catch {
    // next
  }
}
if (snapshotJsonValue === undefined) {
  console.log('FATAL  cannot load snapshotJsonValue');
  process.exit(1);
}

const tools = new Map();
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined; },
  get: () => undefined,
};
apply(ctx, { toolset: 'full', autoSettle: false });

console.log(`registered ${tools.size} tools`);

/**
 * Minimal arguments each tool needs to reach its own logic. Anything that touches
 * the desktop is given a value that fails early (bad ref / missing window) so the
 * suite never types, clicks or activates anything.
 */
const MINIMAL = {
  cu_status: {},
  cu_observe: { maxWindows: 4, maxElements: 10, maxDepth: 3, autoOcr: 'off' },
  cu_find: { query: '__tool_contract_absent__', maxElements: 20 },
  cu_capture: { maxWidth: 200 },
  cu_ocr: { imagePath: 'Z:\\__does_not_exist__.png' },
  cu_read: { targetRef: 'uia:r1' },
  cu_act: { action: 'wait', reason: 'tool contract test', ms: 1, observationId: 'obs_absent' },
  cu_sequence: { steps: [] },
  cu_monitors: {},
  cu_place_window: {},
  cu_abort: { clear: true },
  cu_guard: {},
  cu_receipts: { limit: 2 },
};

for (const [name, tool] of tools) {
  const args = MINIMAL[name] ?? {};

  // 1) renderer must exist and be callable
  check(`${name}: has output.render`, typeof tool.output?.render === 'function');
  if (typeof tool.output?.render === 'function') {
    try {
      const rendered = tool.output.render(args, { ok: true, sample: 'x' });
      check(`${name}: renderer returns content blocks`,
        Array.isArray(rendered) && rendered.every((block) => typeof block?.type === 'string'),
        `blocks=${Array.isArray(rendered) ? rendered.length : 'n/a'}`);
    } catch (error) {
      check(`${name}: renderer does not throw`, false, String(error?.message ?? error).slice(0, 90));
    }
  }

  // 2) execute must not blow up on unexpected input, and its output must snapshot
  let result;
  try {
    result = await (tool.execute ?? tool.handler)(args);
    check(`${name}: execute resolves`, true, result === undefined ? 'no value' : 'value');
  } catch (error) {
    // A thrown error is acceptable (bad ref, missing file); an unusable tool is not.
    check(`${name}: execute rejects with an error object`, error instanceof Error, String(error?.message ?? error).slice(0, 70));
    continue;
  }

  if (result !== undefined) {
    check(`${name}: result snapshots as lossless JSON`, snapshotJsonValue(result) !== undefined);
  }
}

// 3) every tool advertises a schema the tool loader accepted
for (const [name, tool] of tools) {
  check(`${name}: parameters schema present`, tool.parameters !== undefined && typeof tool.parameters === 'object');
  check(`${name}: output schema present`, tool.output?.schema !== undefined && typeof tool.output.schema === 'object');
}

// 4) the core/full split is still coherent
const names = [...tools.keys()].sort();
console.log(`tools: ${names.join(', ')}`);
check('full toolset exposes 13 tools', tools.size === 13, `${tools.size}`);

console.log(`\n${failures === 0 ? 'TOOL CONTRACT PASSED' : `${failures} TOOL CONTRACT CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
