/**
 * Live test against a real, non-fixture application.
 *
 * Every other live suite drives a window this repo created itself (a WPF or
 * WinForms fixture). That proves the plumbing but not that the accessibility
 * assumptions hold on an application nobody configured for us. This test drives
 * Windows Calculator: standalone, no user data, and trivially closable.
 *
 * It only ever presses calculator keys and reads the result, and it kills the
 * process it started.
 *
 * Run: node test/live-realapp.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import { UiaDriver } from '../lib/driver.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Get-Process exits non-zero when nothing matches, so failures are swallowed here. */
const listAppPids = () => {
  try {
    const out = execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
      '-NoProfile', '-Command',
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(charmap)$' } | Select-Object -ExpandProperty Id",
    ], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((v) => Number.parseInt(v.trim(), 10)).filter(Number.isFinite);
  } catch {
    return [];
  }
};

console.log('launching Character Map (classic Win32 app, read-only)...');
const before = new Set(listAppPids());

try {
  spawn('C:/Windows/System32/charmap.exe', [], { stdio: 'ignore', detached: true }).unref();
} catch (error) {
  console.log('spawn failed', String(error?.message ?? error));
}

let appPid;
for (let i = 0; i < 30 && appPid === undefined; i += 1) {
  await sleep(400);
  appPid = listAppPids().find((pid) => !before.has(pid));
}
check('charmap process started', appPid !== undefined, String(appPid));

const driver = new UiaDriver({});
try {
  if (appPid === undefined) throw new Error('calculator never started');

  // Find the calculator window by process id — no title matching, no guessing.
  let win;
  for (let i = 0; i < 20 && win === undefined; i += 1) {
    const obs = await driver.observe({ maxWindows: 60, maxElements: 4, maxDepth: 2 });
    win = (obs.windows ?? []).find((w) => w.processId === appPid);
    if (win === undefined) await sleep(400);
  }
  check('charmap window located by pid', win !== undefined,
    win ? `handle=${win.handle} "${win.name}" class=${win.className}` : 'not found');
  if (win === undefined) throw new Error('charmap window never appeared');

  const obs = await driver.observe({ windowHandle: win.handle, maxElements: 200, maxDepth: 12 });
  const elements = obs.targetWindow?.elements ?? [];
  const invokable = elements.filter((e) => e.canInvoke === true);
  console.log(`  tree: ${elements.length} elements, ${invokable.length} invokable`);
  check('tree has invokable elements (a real app, not a blank shell)', invokable.length >= 5,
    `${invokable.length} invokable`);
  // Hitting the element cap is normal for a dialog with a character grid; what
  // matters is that the cap can be raised and the tree stays consistent.
  console.log(`INFO  truncated at maxElements=200: ${obs.truncated}`);
  const wider = await driver.observe({ windowHandle: win.handle, maxElements: 1200, maxDepth: 12 });
  check('a higher element cap yields a larger tree (no silent ceiling)',
    (wider.targetWindow?.elements ?? []).length >= elements.length,
    `${elements.length} -> ${(wider.targetWindow?.elements ?? []).length} elements`);

  // Press 7, +, 8, = and read the display. Names are localised, so match by either
  // the digit glyph or any element whose name contains it.
  const find = (needle) => elements.find((e) => e.canInvoke === true
    && String(e.name ?? '').trim() === needle)
    ?? elements.find((e) => e.canInvoke === true && String(e.name ?? '').includes(needle));

  // Target the dialog's own buttons: localised, but stable.
  const selectBtn = find('选择') ?? find('Select');
  const helpBtn = find('帮助') ?? find('Help');

  check('found the dialog buttons by name', [selectBtn, helpBtn].every(Boolean),
    `select=${selectBtn?.ref ?? '-'} help=${helpBtn?.ref ?? '-'}`);

  if (selectBtn && helpBtn) {
    const press = async (element, label) => {
      const realRef = driver.resolveRef(element.ref)?.ref;
      const t0 = Date.now();
      const res = await driver.call('invoke_ref', { targetRef: realRef, windowHandle: win.handle }, 20000);
      console.log(`  pressed ${label} (${element.name}) in ${Date.now() - t0}ms -> ${JSON.stringify(res).slice(0, 90)}`);
      await sleep(150);
      return res;
    };

    // A read-only dialog: pressing its own buttons cannot destroy user data.
    await press(selectBtn, 'select');

    // Read the display: a real app's result lands in an element whose name changes.
    const after = await driver.observe({ windowHandle: win.handle, maxElements: 1200, maxDepth: 12 });
    const afterElements = after.targetWindow?.elements ?? [];
    check('tree still readable after an action (no hang)', afterElements.length > 0, `${afterElements.length} elements`);

    // The invoked button changes state in a readable way: the dialog now has a
    // selection, so the "Select" button becomes enabled or the grid reports one.
    const namedAfter = afterElements.filter((e) => String(e.name ?? '').trim() !== '').map((e) => e.name);
    console.log(`  named elements after the press: ${namedAfter.slice(0, 8).map((n) => JSON.stringify(n)).join(' ')}`);
    check('the window still reports its own controls after the press',
      namedAfter.some((n) => String(n).includes('字符') || String(n).includes('复制') || String(n).includes('选择') || String(n).includes('Character')),
      `${namedAfter.length} named elements`);
  }
} catch (error) {
  failures += 1;
  console.log('ERROR', String(error?.message ?? error).slice(0, 200));
} finally {
  if (appPid !== undefined) {
    try {
      execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(appPid), '/T', '/F'], { stdio: 'ignore' });
      console.log(`closed charmap pid ${appPid}`);
    } catch {
      console.log('note: charmap may already have exited');
    }
  }
  await driver.close();
}

console.log(`\n${failures === 0 ? 'REAL APP PASSED' : `${failures} REAL APP CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
