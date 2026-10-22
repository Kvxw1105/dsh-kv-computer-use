/**
 * Output shape test: every tool result must be lossless JSON.
 *
 * The harness rejects a tool result containing `undefined` with
 * "value is not lossless JSON", which makes the tool unusable at runtime. That
 * failure mode is invisible to ordinary assertions (undefined simply disappears
 * when logged), so it gets its own test: results are compared before and after a
 * JSON round-trip and any surviving key with an undefined value fails.
 *
 * Run: node test/output-shape.mjs
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

/** Deep-walk for undefined values, reporting the path. */
function findUndefined(value, path = '$') {
  const hits = [];
  if (value === undefined) {
    hits.push(path);
    return hits;
  }
  if (value === null) return hits;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      hits.push(...findUndefined(item, `${path}[${index}]`));
    });
    return hits;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      hits.push(...findUndefined(item, `${path}.${key}`));
    }
  }
  return hits;
}

const tools = new Map();
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined; },
  get: () => undefined,
};
apply(ctx, { toolset: 'full', autoSettle: false });

const call = async (name, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return await (tool.execute ?? tool.handler)(args);
};

const audit = (name, result) => {
  const hits = findUndefined(result);
  check(`${name}: no undefined in result`, hits.length === 0, hits.slice(0, 3).join(', '));
  let roundTrip;
  try {
    roundTrip = JSON.parse(JSON.stringify(result));
  } catch (error) {
    check(`${name}: result is serialisable`, false, String(error?.message ?? error));
    return;
  }
  check(`${name}: survives a JSON round-trip`, JSON.stringify(roundTrip) === JSON.stringify(result),
    'undefined would differ here');
};

// ---------- tools that touch the desktop ----------
audit('cu_status', await call('cu_status'));
audit('cu_guard', await call('cu_guard', { label: '删除全部' }));
audit('cu_observe', await call('cu_observe', { maxWindows: 8, maxElements: 40, maxDepth: 5, autoOcr: 'off' }));
audit('cu_find', await call('cu_find', { query: '__absent__' }));
audit('cu_receipts', await call('cu_receipts', { limit: 5 }));

// ---------- refusal paths ----------
audit('cu_act (no observation)', await call('cu_act', {
  action: 'invoke', reason: 'output-shape test', targetRef: 'uia:r1', observationId: 'obs_missing',
}));
audit('cu_read (bad ref)', await call('cu_read', { targetRef: 'uia:r9999' }).catch((error) => ({ error: String(error?.message ?? error) })));
audit('cu_capture (no target)', await call('cu_capture', {}).catch((error) => ({ error: String(error?.message ?? error) })));

// ---------- every registered tool has a matching implementation ----------
for (const [name, tool] of tools) {
  check(`${name}: exposes a callable`, typeof (tool.execute ?? tool.handler) === 'function');
  check(`${name}: has a description`, typeof tool.description === 'string' && tool.description.length > 20,
    `${String(tool.description ?? '').length} chars`);
}

console.log(`\n${failures === 0 ? 'OUTPUT SHAPE PASSED' : `${failures} OUTPUT SHAPE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
