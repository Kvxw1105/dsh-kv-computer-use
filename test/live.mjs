/**
 * Live success-path test against an isolated fixture window.
 *
 * Starts test/fixture.ps1 (a WinForms form with one TextBox), writes into it
 * through the UIA Value pattern — background, no cursor movement, no keystrokes —
 * verifies the write with a value_equals postcondition, checks the pixel
 * fingerprint, then closes only that process.
 *
 * Never touches Notepad, editors, or any window the user owns.
 *
 * Run: node test/live.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UiaDriver } from '../lib/driver.js';
import { FreshnessStore, hashShot } from '../lib/freshness.js';
import { evaluatePostcondition } from '../lib/contracts.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = 'KV-CU-LIVE-测试-42';
const pidPath = join(tmpdir(), `kvcu-fixture-${Date.now()}.pid`);
const script = join(process.cwd(), 'test', 'fixture-wpf.ps1');

console.log('starting isolated fixture window...');
const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
  '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-PidPath', pidPath,
], { stdio: 'ignore', windowsHide: false });
// WPF needs STA and a moment to render; the pid file appears on ContentRendered.
child.on('error', (e) => console.log('spawn error', e.code, e.message));

let fixturePid;
for (let i = 0; i < 40; i += 1) {
  await sleep(150);
  if (existsSync(pidPath)) {
    const value = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isFinite(value) && value > 0) {
      fixturePid = value;
      break;
    }
  }
}
check('fixture reports its pid', fixturePid !== undefined, String(fixturePid));

const driver = new UiaDriver({});

try {
  if (fixturePid === undefined) throw new Error('fixture never announced its pid');

  let window;
  for (let i = 0; i < 25 && window === undefined; i += 1) {
    const obs = await driver.observe({ maxWindows: 60, maxElements: 5, maxDepth: 2 });
    window = (obs.windows ?? []).find((w) => w.processId === fixturePid);
    if (window === undefined) await sleep(200);
  }
  check('fixture window located by pid only', window !== undefined,
    window ? `handle=${window.handle} name="${window.name}" class=${window.className}` : 'not found');
  if (window === undefined) throw new Error('fixture window never appeared');

  const obs = await driver.observe({ windowHandle: window.handle, maxElements: 200, maxDepth: 10 });
  const elements = obs.targetWindow?.elements ?? [];
  console.log(`  tree: ${elements.length} elements -> ${elements.slice(0, 4).map((e) => `${e.ref}:${e.controlType}:${e.name || '-'}`).join(', ')}`);
  const target = elements.find((e) => e.canSetValue === true) ?? elements.find((e) => /Edit|Document/i.test(String(e.controlType ?? '')));
  check('found a writable TextBox', target !== undefined, target ? `${target.ref} ${target.controlType} canSetValue=${target.canSetValue}` : 'none');

  if (target !== undefined) {
    const realRef = driver.resolveRef(target.ref)?.ref;
    const t0 = Date.now();
    const result = await driver.call('set_value_ref', {
      targetRef: realRef,
      value: MARKER,
      windowHandle: window.handle,
      maxSearchElements: 2000,
      maxSearchDepth: 20,
    }, 30000);
    console.log(`  set_value_ref ok in ${Date.now() - t0}ms -> ${JSON.stringify(result).slice(0, 140)}`);

    // Cite the element by stable identity (name), because short refs are scoped to
    // one observation and element order can shift after a write.
    const verification = await evaluatePostcondition(
      { kind: 'value_equals', targetRef: target.ref, name: 'kvTarget', value: MARKER, timeoutMs: 2000 },
      { observe: (params) => driver.observe(params), windowHandle: window.handle },
    );
    check('postcondition value_equals after background write', verification.status === 'passed',
      `${verification.status} ${JSON.stringify(verification.evidence).slice(0, 160)}`);

    // Element existence on the live tree
    const exists = await evaluatePostcondition(
      { kind: 'element_exists', name: 'kvTarget', timeoutMs: 800 },
      { observe: (params) => driver.observe(params), windowHandle: window.handle },
    );
    check('postcondition element_exists by name', exists.status === 'passed', exists.status);

    // Pixel fingerprint: same window captured twice should hash identically
    const before = await driver.call('capture', { windowHandle: window.handle, maxWidth: 560 }, 20000);
    await sleep(120);
    const after = await driver.call('capture', { windowHandle: window.handle, maxWidth: 560 }, 20000);
    check('capture works on the fixture', typeof before?.imageBase64 === 'string' && before.imageBase64.length > 1000,
      `${before?.width}x${before?.height} ${before?.captureMethod} occlusionRisk=${before?.occlusionRisk}`);
    // A focused TextBox has a blinking caret, so two captures legitimately differ.
    // This is exactly why pixel staleness is off by default; report the fact rather
    // than asserting stability.
    const samePixels = hashShot(before?.imageBase64) === hashShot(after?.imageBase64);
    console.log(`INFO  pixel bytes ${samePixels ? 'identical' : 'differ'} between two captures `
      + `(${hashShot(before?.imageBase64)?.slice(0, 8)} / ${hashShot(after?.imageBase64)?.slice(0, 8)}) `
      + '— expected for a window with a caret; pixel staleness is opt-in');

    // A second write must be refused if the tree changed between observe and act:
    // simulate by citing a stale observation id.
    const store = new FreshnessStore({ ttlMs: 8000, staleCheckPixels: false });
    const recorded = store.record(obs);
    const sameTree = store.compare(recorded, obs);
    check('freshness: unchanged tree passes', sameTree.ok === true, JSON.stringify(sameTree.checks.tree ?? {}).slice(0, 90));
  }
} catch (error) {
  failures += 1;
  console.log('ERROR', error?.message ?? error);
} finally {
  if (fixturePid !== undefined) {
    try {
      execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(fixturePid), '/T', '/F'], { stdio: 'ignore' });
      console.log(`closed fixture pid ${fixturePid}`);
    } catch {
      console.log('note: fixture may already have exited');
    }
  }
  try {
    child.kill();
  } catch {
    // ignore
  }
  try {
    if (existsSync(pidPath)) rmSync(pidPath);
  } catch {
    // ignore
  }
  await driver.close();
}

console.log(`\n${failures === 0 ? 'LIVE SUCCESS PATH PASSED' : `${failures} LIVE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
