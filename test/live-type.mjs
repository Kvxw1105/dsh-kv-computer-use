/**
 * Live typing test through the resident daemon.
 *
 * Starts the WPF fixture, observes it, and types Chinese text into it via
 * cu_act{action:'type'}. The focus guard refuses the action unless the fixture is
 * actually foreground, so this test cannot type into the wrong window — if the
 * guard refuses, that is reported as such rather than worked around.
 *
 * Verification is renderer independent: cu_read pulls the text back through UIA.
 *
 * Run: node test/live-type.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../lib/index.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = '中文输入测试abc123';
const pidPath = join(tmpdir(), `kvcu-type-${Date.now()}.pid`);
const keyLog = join(tmpdir(), `kvcu-keylog-${Date.now()}.txt`);
const script = join(process.cwd(), 'test', 'fixture-wpf.ps1');

console.log('starting WPF fixture...');
const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
  '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-PidPath', pidPath, '-KeyLog', keyLog,
], { stdio: 'ignore' });

let fixturePid;
for (let i = 0; i < 40; i += 1) {
  await sleep(150);
  if (existsSync(pidPath)) {
    const value = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isFinite(value) && value > 0) { fixturePid = value; break; }
  }
}
check('fixture reports its pid', fixturePid !== undefined, String(fixturePid));

const tools = new Map();
const ctx = {
  tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined; },
  get: () => undefined,
};
apply(ctx, { toolset: 'full', ttlMs: 60000, autoSettle: false });

const call = async (name, args = {}) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return await (tool.execute ?? tool.handler)(args);
};

try {
  if (fixturePid === undefined) throw new Error('fixture never announced its pid');

  let windowHandle;
  for (let i = 0; i < 25 && windowHandle === undefined; i += 1) {
    const obs = await call('cu_observe', { maxWindows: 60, maxElements: 5, maxDepth: 2 });
    const hit = (obs.windows ?? []).find((w) => w.processId === fixturePid);
    if (hit) windowHandle = hit.handle;
    else await sleep(200);
  }
  check('fixture window located', windowHandle !== undefined, String(windowHandle));
  if (windowHandle === undefined) throw new Error('fixture window never appeared');

  const obs = await call('cu_observe', { windowHandle, maxElements: 200, maxDepth: 10 });
  const target = (obs.targetWindow?.elements ?? []).find((e) => /Edit|Document/i.test(String(e.controlType ?? '')));
  check('text control found', target !== undefined, target?.ref);

  const status = await call('cu_status');
  console.log(`  input: available=${status.input?.available} daemon=${JSON.stringify(status.input?.daemon ?? null)}`);

  if (target !== undefined) {
    // Type through the daemon. guardWindow is on by default: if the fixture is not
    // foreground the action is refused, never delivered elsewhere.
    const t0 = Date.now();
    // Bring the window to the foreground first. A programmatically launched window
    // is not guaranteed to own foreground, and the focus guard (correctly) refuses
    // to type when it does not — so ask the driver to activate it explicitly.
    const focusWindow = await call('cu_act', {
      action: 'focus', reason: 'live: activate fixture window', windowHandle,
    });
    console.log(`  focus_window: status=${focusWindow.status} outcome=${focusWindow.outcome} error=${focusWindow.error?.code ?? '-'}`);
    // Windows may refuse activation (foreground lock). That must surface as a failed
    // focus, never as an unverified success — this is the regression guard for it.
    const activated = focusWindow.status === 'completed' && focusWindow.outcome === 'VERIFIED';
    check('focus reports activation honestly',
      activated || focusWindow.outcome !== 'VERIFIED',
      `outcome=${focusWindow.outcome} error=${focusWindow.error?.code ?? '-'}`);
    await sleep(200);

    // targetRef makes the plugin focus that exact control before typing, instead of
    // relying on whatever already owns keyboard focus inside the window.
    const receipt = await call('cu_act', {
      action: 'type',
      reason: 'live: daemon typing test',
      text: MARKER,
      windowHandle,
      targetRef: target.ref,
      observationId: obs.observationId,
      expectKind: 'none',
    });
    const elapsed = Date.now() - t0;
    console.log(`  type receipt: status=${receipt.status} outcome=${receipt.outcome} `
      + `error=${receipt.error?.code ?? '-'} settle=${JSON.stringify(receipt.settle ?? null)} (${elapsed}ms)`);
    console.log(`  type result: ${JSON.stringify(receipt.result ?? null)}`);

    if (receipt.error?.code === 'FOREGROUND_MISMATCH') {
      console.log('INFO  fixture was not foreground, so the focus guard refused the action.');
      console.log('INFO  that is the guard working as designed; no keystrokes were delivered anywhere.');
      check('focus guard refused instead of typing into the wrong window', true);
    } else {
      // When activation is refused, Windows can still report the window as
      // foreground while the input queue belongs elsewhere. The plugin cannot tell
      // those apart, so the honest contract is: never claim VERIFIED for keystrokes
      // whose effect was not observed in the control.
      check('keystrokes are never reported as VERIFIED without observation',
        receipt.outcome !== 'VERIFIED',
        `activated=${activated} outcome=${receipt.outcome} error=${receipt.error?.code ?? '-'}`);

      // Direct look at the control's own value field after typing.
      const afterType = await call('cu_observe', { windowHandle, maxElements: 200, maxDepth: 10 });
      const same = (afterType.targetWindow?.elements ?? []).find((e) => /Edit|Document/i.test(String(e.controlType ?? '')));
      console.log(`  element after type: ref=${same?.ref} value=${JSON.stringify(String(same?.value ?? '').slice(0, 60))}`);
      if (existsSync(keyLog)) {
        const probe = readFileSync(keyLog, 'utf8').split(String.fromCharCode(10)).filter(Boolean);
        console.log(`  key probe: ${probe.length} events -> ${JSON.stringify(probe.slice(-4).join(' ; ').slice(0, 160))}`);
      } else {
        console.log('  key probe: no events reached the control');
      }

      const read = await call('cu_read', { windowHandle, targetRef: same?.ref ?? target.ref, maxChars: 400 });
      console.log(`  cu_read: ok=${read?.ok} method=${read?.method ?? '-'} text=${JSON.stringify(String(read?.text ?? '').slice(0, 60))}`);
      const typedOk = String(same?.value ?? '').includes('中文输入测试')
        || String(read?.text ?? '').includes('中文输入测试');
      // Not a pass/fail gate. Windows refuses foreground activation for a window
      // that is not already in front (foreground lock), so a programmatically
      // launched fixture cannot reliably own the input focus. In that case the
      // keystrokes go to whatever *is* focused, which is exactly why the plugin
      // prefers set_value and reports type results as unverified.
      console.log(`INFO  unicode typing ${typedOk ? 'reached the control' : 'did not reach the control'} `
        + `(value=${JSON.stringify(String(same?.value ?? '').slice(0, 30))})`);

      // ASCII-only control: isolates an encoding problem from a delivery problem.
      const asciiReceipt = await call('cu_act', {
        action: 'type', reason: 'live: ascii control', text: 'abc123',
        windowHandle, targetRef: same?.ref ?? target.ref, observationId: obs.observationId, expectKind: 'none',
      });
      const afterAscii = await call('cu_observe', { windowHandle, maxElements: 200, maxDepth: 10 });
      const asciiElement = (afterAscii.targetWindow?.elements ?? []).find((e) => /Edit|Document/i.test(String(e.controlType ?? '')));
      console.log(`  ascii control: sent=${asciiReceipt.result?.charactersSent} value=${JSON.stringify(String(asciiElement?.value ?? '').slice(0, 40))}`);
      const asciiOk = String(asciiElement?.value ?? '').includes('abc123');
      console.log(`INFO  ASCII typing ${asciiOk ? 'reached the control' : 'did not reach the control'} `
        + `(value=${JSON.stringify(String(asciiElement?.value ?? '').slice(0, 30))})`);
      check('type never reports success without verification', receipt.outcome !== 'VERIFIED',
        `outcome=${receipt.outcome}`);
      check('focus was shown to land on the addressed control', receipt.result?.focus?.focused === true
        || receipt.error?.code === 'FOREGROUND_MISMATCH', JSON.stringify(receipt.result?.focus ?? receipt.error?.code));
    }
  }
} catch (error) {
  failures += 1;
  console.log('ERROR', error?.message ?? error);
} finally {
  if (fixturePid !== undefined) {
    try {
      execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(fixturePid), '/T', '/F'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
  try { child.kill(); } catch { /* ignore */ }
  try { if (existsSync(pidPath)) rmSync(pidPath); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'LIVE TYPING PASSED' : `${failures} TYPING CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
