/**
 * Smoke test: exercises the contract chain end-to-end without touching the
 * mouse or keyboard. Safe action is `wait`; verification is an element_exists
 * postcondition against the live tree.
 *
 * Run: node test/smoke.mjs
 */

import { UiaDriver } from '../lib/driver.js';
import { InputLayer } from '../lib/input.js';
import { OcrReader } from '../lib/ocr.js';
import { ReceiptStore } from '../lib/receipts.js';
import {
  classifyInputMode,
  classifyOutcome,
  classifyRisk,
  evaluatePostcondition,
  validateEnvelope,
} from '../lib/contracts.js';

let failures = 0;
const ok = (label, detail = '') => console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (label, condition, detail = '') => (condition ? ok(label, detail) : bad(label, detail));

// ---------- pure contract checks ----------
check('risk: wait is read', classifyRisk({ type: 'wait' }) === 'read');
check('risk: click_point is reversible-write', classifyRisk({ type: 'click_point' }) === 'reversible-write');
check('input: invoke_ref defaults background', classifyInputMode({ type: 'invoke_ref' }) === 'background');
check('input: invoke_ref background=false is focus', classifyInputMode({ type: 'invoke_ref', background: false }) === 'focus');
check('input: type_text is focus', classifyInputMode({ type: 'type_text' }) === 'focus');
check('outcome: verified', classifyOutcome({ status: 'completed', verification: 'passed', risk: 'read' }) === 'VERIFIED');
check('outcome: blocked halts', classifyOutcome({ status: 'blocked', verification: 'passed', risk: 'read' }) === 'HALTED_BEFORE_EFFECT');
check('outcome: write + failed verification needs reconciliation',
  classifyOutcome({ status: 'completed', verification: 'failed', risk: 'reversible-write' }) === 'RECONCILIATION_REQUIRED');

const goodEnvelope = {
  actionId: 'a1',
  action: { type: 'wait', ms: 10 },
  reason: 'test',
  expectedPostcondition: { kind: 'none' },
  risk: 'read',
  timeoutMs: 5000,
  requireBackground: true,
};
check('validate: legal envelope passes', validateEnvelope(goodEnvelope).length === 0, validateEnvelope(goodEnvelope).join('; '));

const missingReason = { ...goodEnvelope, reason: '' };
check('validate: missing reason rejected', validateEnvelope(missingReason).length > 0);

const bgViolation = {
  ...goodEnvelope,
  action: { type: 'type_text', text: 'x' },
  risk: 'reversible-write',
  requireBackground: true,
};
check('validate: requireBackground forbids type_text',
  validateEnvelope(bgViolation).some((e) => e.includes('requireBackground')), validateEnvelope(bgViolation).join('; '));

const riskDowngrade = { ...goodEnvelope, action: { type: 'click_point', x: 1, y: 2 }, risk: 'read' };
check('validate: risk downgrade rejected', validateEnvelope(riskDowngrade).some((e) => e.includes('risk mismatch')));

// ---------- live driver checks ----------
const driver = new UiaDriver({});
check('driver: path resolved', driver.available, driver.driverPath ?? 'not found');

if (!driver.available) {
  console.log('\nDriver not found; live checks skipped.');
  process.exit(failures === 0 ? 0 : 1);
}

const status = await driver.statusCall();
check('driver: status protocolVersion', status?.protocolVersion === 1, `pid=${status?.processId} elevated=${status?.isElevated}`);
check('driver: capabilities advertised', Array.isArray(status?.capabilities) && status.capabilities.length >= 9,
  `${status?.capabilities?.length ?? 0} caps`);

const observation = await driver.observe({ maxWindows: 5, maxElements: 60, maxDepth: 6 });
check('observe: returns observationId', typeof observation.observationId === 'string' && observation.observationId.length > 0,
  observation.observationId);
check('observe: lists windows', Array.isArray(observation.windows), `${observation.windows.length} windows`);
check('observe: foreground handle present', Number.isInteger(observation.foregroundWindowHandle),
  String(observation.foregroundWindowHandle));

const elements = observation.targetWindow?.elements ?? [];
check('observe: target window has elements', elements.length > 0, `${elements.length} elements`);
const first = elements[0];
check('observe: element has scoped ref', typeof first?.ref === 'string' && /^uia:r\d+$/.test(first.ref), first?.ref);
check('observe: element carries bounds (not rect)', first?.bounds !== undefined, JSON.stringify(first?.bounds));

// ref must resolve back to a real UIA runtime id
let resolvedReal;
try {
  resolvedReal = driver.resolveRef(first.ref)?.ref;
} catch (error) {
  resolvedReal = undefined;
  bad('resolveRef: threw', String(error?.message ?? error));
}
check('resolveRef: maps short ref to uia: runtime id',
  typeof resolvedReal === 'string' && resolvedReal.startsWith('uia:') && !/^uia:r\d+$/.test(resolvedReal),
  resolvedReal);

// ---------- postcondition verification ----------
const targetName = first?.name ?? '';
const verify = targetName === ''
  ? { status: 'unknown', evidence: { reason: 'first element has no name' } }
  : await evaluatePostcondition(
    { kind: 'element_exists', name: targetName, timeoutMs: 1000 },
    { observe: (params) => driver.observe(params), windowHandle: observation.targetWindow?.handle },
  );
if (targetName === '') {
  check('postcondition: verification ran', true, 'skipped (no named element)');
} else {
  check('postcondition: element_exists on a live element', verify.status === 'passed',
    `${verify.status} ${JSON.stringify(verify.evidence)}`);
}

const absent = await evaluatePostcondition(
  { kind: 'element_absent', name: '__kv_cu_definitely_absent__', timeoutMs: 300 },
  { observe: (params) => driver.observe(params), windowHandle: observation.targetWindow?.handle },
);
check('postcondition: element_absent on a missing element', absent.status === 'passed', absent.status);

// ---------- receipts ----------
const receipts = new ReceiptStore();
const probe = { protocolVersion: 1, actionId: 'smoke_wait', status: 'completed', outcome: 'VERIFIED', note: 'smoke test' };
receipts.append(probe);
const found = receipts.find('smoke_wait');
check('receipts: append and find round-trip', found?.actionId === 'smoke_wait', receipts.path());

// ---------- auxiliary layers ----------
const input = new InputLayer({});
const ocr = new OcrReader({});
console.log(`INFO  input layer available=${input.available} (helper compiled=${input.compiled})`);
console.log(`INFO  ocr available=${ocr.available}`);

await driver.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
