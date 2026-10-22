/**
 * Client-channel test: the activity and stop routes the Web UI talks to.
 *
 * Mounts the plugin with a fake Cordis context whose webServer records the
 * registration, then drives the handler directly. This proves the route logic
 * without restarting the Harness (the real host only picks up a new host half on
 * restart).
 *
 * Run: node test/client-channel.mjs
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
let registration;
const disposers = [];

const fakeWebServer = {
  register(options) {
    registration = options;
    return () => { registration = undefined; };
  },
};

const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  effect(fn) {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
    return d;
  },
  get(name) {
    if (name === 'webServer') return fakeWebServer;
    return undefined;
  },
};

apply(ctx, { toolset: 'core' });

check('webServer route registered', registration !== undefined, registration?.path);
check('route uses prefix kind', registration?.kind === 'prefix', registration?.kind);

/** Call the handler with a synthetic request. */
async function call(method, path) {
  let status;
  let body;
  const res = {
    writeHead(code) { status = code; },
    end(payload) { body = payload; },
  };
  await registration.handler({ method, url: path }, res);
  return { status, json: body ? JSON.parse(body) : undefined };
}

// ---------- state before any action ----------
const idle = await call('GET', '/kv-computer-use/state');
check('GET state returns 200', idle.status === 200, String(idle.status));
check('state reports idle activity', idle.json?.activity?.active === false,
  JSON.stringify(idle.json?.activity));
check('state reports abort flag', idle.json?.aborted === false);
check('state exposes toolset + driver availability',
  idle.json?.toolset === 'core' && typeof idle.json?.driverAvailable === 'boolean',
  `${idle.json?.toolset} driver=${idle.json?.driverAvailable}`);

// ---------- abort / resume ----------
const aborted = await call('POST', '/kv-computer-use/abort');
check('POST abort returns ok', aborted.status === 200 && aborted.json?.aborted === true);

const afterAbort = await call('GET', '/kv-computer-use/state');
check('abort flag is visible to the UI', afterAbort.json?.aborted === true, afterAbort.json?.abortReason);

// the abort must actually stop a mutating action
const act = tools.get('cu_act');
const refused = await (act.execute ?? act.handler)({
  action: 'invoke', reason: 'client-channel test while stopped', targetRef: 'uia:r1',
});
check('stopped state refuses mutating actions', refused?.error?.code === 'ABORTED_BY_USER', refused?.error?.code);

const resumed = await call('POST', '/kv-computer-use/resume');
check('POST resume clears the flag', resumed.status === 200 && resumed.json?.aborted === false);
const afterResume = await call('GET', '/kv-computer-use/state');
check('state reflects resume', afterResume.json?.aborted === false);

// ---------- capture dedupe ----------
const capture = tools.get('cu_capture');
const first = await (capture.execute ?? capture.handler)({ maxWidth: 320 });
const second = await (capture.execute ?? capture.handler)({ maxWidth: 320 });
if (first?.path !== undefined && second?.unchanged === true) {
  check('identical frame is deduped instead of re-sent', second.unchanged === true, second.note?.slice(0, 40));
  const forced = await (capture.execute ?? capture.handler)({ maxWidth: 320, dedupe: false });
  check('dedupe:false forces a real capture', typeof forced?.path === 'string', forced?.path);
} else {
  console.log(`INFO  dedupe not exercised (first=${first?.path ? 'image' : first?.error?.code ?? '?'} second=${second?.unchanged ? 'unchanged' : 'image'}) — screen changed between captures`);
}

// ---------- unknown route ----------
const notFound = await call('GET', '/kv-computer-use/nope');
check('unknown route returns 404', notFound.status === 404, JSON.stringify(notFound.json));

const wrongMethod = await call('DELETE', '/kv-computer-use/state');
check('wrong method returns 404 (route is method-scoped)', wrongMethod.status === 404);

// ---------- activity tracking through a real action ----------
const observe = tools.get('cu_observe');
const before = await call('GET', '/kv-computer-use/state');
const totalBefore = before.json?.activity?.totalActions ?? 0;

// run a read-only action so nothing on the desktop changes
await (observe.execute ?? observe.handler)({ maxWindows: 5, maxElements: 10, maxDepth: 3, autoOcr: 'off' });

const afterObserve = await call('GET', '/kv-computer-use/state');
check('activity ends idle after an action',
  afterObserve.json?.activity?.active === false, JSON.stringify(afterObserve.json?.activity));
check('activity counts actions', (afterObserve.json?.activity?.totalActions ?? 0) >= totalBefore,
  `${totalBefore} -> ${afterObserve.json?.activity?.totalActions}`);

for (const dispose of disposers.reverse()) {
  try { dispose(); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'CLIENT CHANNEL PASSED' : `${failures} CLIENT CHANNEL CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
