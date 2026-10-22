/**
 * Layer tests: guard rules and the freshness boundary.
 * Pure logic, no desktop interaction.
 *
 * Run: node test/layers.mjs
 */

import { evaluateGuard, checkAppScope, isDangerousLabel, isSecureField } from '../lib/guard.js';
import { FreshnessStore, hashTree, hashShot, identityOf, hashIdentity } from '../lib/freshness.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// ---------- guard: dangerous labels ----------
for (const label of ['删除', '清空回收站', '确认支付', '退出登录', 'Delete file', 'Transfer funds', 'Sign out']) {
  check(`dangerous: ${label}`, isDangerousLabel(label) === true);
}
for (const label of ['取消', '保存', '下一步', 'Cancel', 'Save', 'Next']) {
  check(`safe: ${label}`, isDangerousLabel(label) === false);
}

// ---------- guard: credential fields ----------
for (const field of [{ name: 'Password' }, { name: '登录密码' }, { automationId: 'api_key_input' }, { isPassword: true }]) {
  check(`secure field: ${JSON.stringify(field)}`, isSecureField(field) === true);
}
check('not secure: username', isSecureField({ name: 'Username' }) === false);
check('not secure: empty', isSecureField({}) === false);

// ---------- guard: app scope ----------
const notepad = { name: 'Untitled - Notepad', className: 'Notepad', processId: 1234 };
check('scope: empty allowlist allows', checkAppScope([], notepad).allowed === true);
check('scope: matching title allows', checkAppScope(['notepad'], notepad).allowed === true);
check('scope: matching pid allows', checkAppScope(['1234'], notepad).allowed === true);
const denied = checkAppScope(['chrome'], notepad);
check('scope: non-matching denies', denied.allowed === false, denied.reason);
check('scope: no window denies when scoped', checkAppScope(['chrome'], undefined).allowed === false);

// ---------- guard: full verdict ----------
const allowVerdict = evaluateGuard({ action: { type: 'invoke_ref', targetRef: 'uia:r1' }, element: { name: 'OK' }, window: notepad, allowedApps: [] });
check('verdict: normal button allows', allowVerdict.verdict === 'allow');

const pwVerdict = evaluateGuard({ action: { type: 'type_text', text: 'hunter2' }, element: { name: 'Password' }, window: notepad, allowedApps: [] });
check('verdict: typing into password denies', pwVerdict.verdict === 'deny', pwVerdict.reason);

const dangerVerdict = evaluateGuard({ action: { type: 'invoke_ref', targetRef: 'uia:r2' }, element: { name: '删除全部' }, window: notepad, allowedApps: [] });
check('verdict: dangerous label needs approval', dangerVerdict.verdict === 'needs-approval', dangerVerdict.reason);

const scopedVerdict = evaluateGuard({ action: { type: 'invoke_ref', targetRef: 'uia:r1' }, element: { name: 'OK' }, window: notepad, allowedApps: ['chrome'] });
check('verdict: out-of-scope denies', scopedVerdict.verdict === 'deny', scopedVerdict.reason);

// ---------- freshness: tree hashing ----------
const treeA = [
  { ref: 'uia:r1', controlType: 'Button', name: 'OK', bounds: { x: 0, y: 0, width: 10, height: 10 }, canInvoke: true },
  { ref: 'uia:r2', controlType: 'Edit', name: '', bounds: { x: 0, y: 20, width: 50, height: 10 }, canSetValue: true },
];
const treeB = [
  { ref: 'uia:r1', controlType: 'Button', name: 'OK', bounds: { x: 0, y: 0, width: 10, height: 10 }, canInvoke: true },
  { ref: 'uia:r2', controlType: 'Edit', name: '', bounds: { x: 0, y: 20, width: 50, height: 10 }, canSetValue: true },
];
const treeC = [treeA[0]];
check('hashTree: identical trees hash equal', hashTree(treeA) === hashTree(treeB));
check('hashTree: different trees differ', hashTree(treeA) !== hashTree(treeC));
check('hashTree: undefined for bad input', hashTree(undefined) === undefined);

// ---------- freshness: identity + compare ----------
const window = { handle: 100, name: 'Notepad', className: 'Notepad', processId: 42, bounds: { x: 0, y: 0, width: 800, height: 600 } };
// shotHash must be the digest produced by hashShot(), because compare() hashes the
// freshly captured bytes before comparing.
const observation = { observationId: 'obs_a', targetWindow: { ...window, elements: treeA }, shotHash: hashShot('shot1') };

const store = new FreshnessStore({ ttlMs: 5000, staleCheckPixels: true });
const entry = store.record(observation);
check('record: captures identity', entry.identity.pid === 42 && entry.identity.width === 800);
check('record: captures tree hash', entry.treeHash === hashTree(treeA));

const same = store.compare(entry, { observationId: 'obs_b', targetWindow: { ...window, elements: treeB }, shotHash: 'shot1' }, { freshShot: 'shot1' });
check('compare: unchanged window passes', same.ok === true, JSON.stringify(same.checks.tree));

// Geometry is NOT part of the identity hash: a virtual monitor connecting or a
// resolution switch rewrites every window's bounds at once, and treating that as
// "a different window" would refuse every action right after a display change.
// A window that merely moved keeps the same identity; its element bounds still
// change, which the tree fingerprint catches.
// Same tree, different window rectangle: identity holds, tree is unchanged.
const moved = store.compare(entry, {
  targetWindow: { ...window, bounds: { x: 0, y: 0, width: 900, height: 600 }, elements: treeA },
});
check('compare: geometry-only change does not break identity', moved.ok === true,
  `ok=${moved.ok} reason=${moved.reason ?? '-'}`);

const otherProcess = store.compare(entry, { targetWindow: { ...window, processId: 999 } });
check('compare: a different process still fails identity',
  otherProcess.ok === false && otherProcess.reason === 'WINDOW_CHANGED', otherProcess.detail);

const otherTitle = store.compare(entry, { targetWindow: { ...window, name: 'Somewhere Else' } });
check('compare: a different window title still fails identity',
  otherTitle.ok === false && otherTitle.reason === 'WINDOW_CHANGED', otherTitle.detail);

// A display change that also repaints the content is caught by the tree, not identity.
const displayShift = store.compare(
  entry,
  { targetWindow: { ...window, bounds: { x: 0, y: 0, width: 900, height: 600 }, elements: treeC } },
);
check('compare: display shift plus real content change is still refused',
  displayShift.ok === false && displayShift.reason === 'TREE_CHANGED', displayShift.detail);

const rebuilt = store.compare(entry, { targetWindow: { ...window, elements: treeC } });
check('compare: tree change fails', rebuilt.ok === false && rebuilt.reason === 'TREE_CHANGED', rebuilt.detail);

const repainted = store.compare(entry, { targetWindow: { ...window, elements: treeB } }, { freshShot: 'shot2' });
check('compare: pixel change fails', repainted.ok === false && repainted.reason === 'PIXELS_CHANGED', repainted.detail);

const noPixelCheck = new FreshnessStore({ ttlMs: 5000, staleCheckPixels: false });
const entryNoPixel = noPixelCheck.record(observation);
const skipped = noPixelCheck.compare(entryNoPixel, { targetWindow: { ...window, elements: treeB } }, { freshShot: 'shot2' });
check('compare: pixels skipped when disabled', skipped.ok === true);

const expired = new FreshnessStore({ ttlMs: 1 });
const entryExpired = expired.record(observation);
await new Promise((r) => setTimeout(r, 20));
const stale = expired.compare(entryExpired, { targetWindow: { ...window, elements: treeB } });
check('compare: ttl expiry fails', stale.ok === false && stale.reason === 'OBSERVATION_EXPIRED', stale.detail);

// ---------- expired but unchanged: distinguishable from changed ----------
const expiredStore = new FreshnessStore({ ttlMs: 1 });
const expiredEntry = expiredStore.record(observation);
await new Promise((r) => setTimeout(r, 20));

const expiredSame = expiredStore.compare(expiredEntry, { targetWindow: { ...window, elements: treeB } });
check('expired + identical content is flagged unchanged',
  expiredSame.ok === false && expiredSame.reason === 'OBSERVATION_EXPIRED' && expiredSame.unchanged === true,
  `reason=${expiredSame.reason} unchanged=${expiredSame.unchanged}`);
check('expired comparison still reports both fingerprints',
  expiredSame.checks.identity?.ok === true && expiredSame.checks.tree?.ok === true,
  `identity=${expiredSame.checks.identity?.ok} tree=${expiredSame.checks.tree?.ok}`);

const expiredChanged = expiredStore.compare(expiredEntry, { targetWindow: { ...window, elements: treeC } });
check('expired + changed content is NOT flagged unchanged',
  expiredChanged.unchanged !== true && expiredChanged.checks.tree?.ok === false,
  `tree=${expiredChanged.checks.tree?.ok}`);

// ---------- freshness: latest / cap ----------
const small = new FreshnessStore({ ttlMs: 5000 });
for (let i = 0; i < 80; i += 1) small.record({ observationId: `obs_${i}`, targetWindow: { ...window, elements: treeA } });
check('store: record count is capped', small.records.size <= 64, String(small.records.size));
check('store: latest resolves', small.latest()?.observationId === 'obs_79', small.latest()?.observationId);
check('identityOf: undefined for no window', identityOf(undefined) === undefined);
check('hashIdentity: stable', hashIdentity(identityOf(window)) === hashIdentity(identityOf({ ...window })));

console.log(`\n${failures === 0 ? 'ALL LAYER CHECKS PASSED' : `${failures} LAYER CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
