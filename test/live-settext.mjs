/**
 * Live test for the WM_SETTEXT fallback (controls without a UIA ValuePattern).
 *
 * Mounts the plugin with a fake context so the real tool path is exercised:
 *   cu_observe -> cu_act{set_value} -> driver reports PATTERN_UNAVAILABLE
 *   -> SetTextFallback writes through WM_SETTEXT -> observed value changes.
 *
 * Target is a WinForms TextBox from test/fixture.ps1, which has no ValuePattern.
 * Only that fixture process is touched.
 *
 * Run: node test/live-settext.mjs
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

const MARKER = 'WM-SETTEXT-测试-77';
const pidPath = join(tmpdir(), `kvcu-wf-${Date.now()}.pid`);
const script = join(process.cwd(), 'test', 'fixture.ps1');

console.log('starting WinForms fixture (no ValuePattern)...');
const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
  '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-PidPath', pidPath,
], { stdio: 'ignore' });
child.on('error', (e) => console.log('spawn error', e.code, e.message));

let fixturePid;
for (let i = 0; i < 40; i += 1) {
  await sleep(150);
  if (existsSync(pidPath)) {
    const value = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isFinite(value) && value > 0) { fixturePid = value; break; }
  }
}
check('fixture reports its pid', fixturePid !== undefined, String(fixturePid));

// ---------- mount the plugin ----------
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

  // locate the fixture window through the plugin
  let windowHandle;
  for (let i = 0; i < 25 && windowHandle === undefined; i += 1) {
    const obs = await call('cu_observe', { maxWindows: 60, maxElements: 5, maxDepth: 2 });
    const hit = (obs.windows ?? []).find((w) => w.processId === fixturePid);
    if (hit) windowHandle = hit.handle;
    else await sleep(200);
  }
  check('fixture window located by pid', windowHandle !== undefined, String(windowHandle));
  if (windowHandle === undefined) throw new Error('fixture window never appeared');

  // observe the tree and confirm this control genuinely lacks ValuePattern
  const obs = await call('cu_observe', { windowHandle, maxElements: 200, maxDepth: 10 });
  const elements = obs.targetWindow?.elements ?? [];
  const target = elements.find((e) => /Document|Edit/i.test(String(e.controlType ?? '')));
  check('found the text control', target !== undefined,
    target ? `${target.ref} ${target.controlType} canSetValue=${target.canSetValue}` : 'none');

  if (target !== undefined) {
    check('control really has no ValuePattern (fallback is required)',
      target.canSetValue === false, `canSetValue=${target.canSetValue}`);

    const receipt = await call('cu_act', {
      action: 'set_value',
      reason: 'live: WM_SETTEXT fallback',
      targetRef: target.ref,
      value: MARKER,
      windowHandle,
      observationId: obs.observationId,
      expectKind: 'value_equals',
      expectName: target.name,
      expectValue: MARKER,
      expectTimeoutMs: 1500,
    });
    console.log(`  receipt: status=${receipt.status} outcome=${receipt.outcome} `
      + `via=${receipt.result?.via ?? '-'} method=${receipt.result?.method ?? '-'} `
      + `readBack=${JSON.stringify(receipt.result?.readBack ?? null).slice(0, 40)}`);
    if (receipt.error) console.log(`  error: ${receipt.error.code} ${receipt.error.message}`);

    check('set_value completed via fallback', receipt.status === 'completed', receipt.error?.code);
    check('fallback path reported', receipt.result?.via === 'wm-settext' || receipt.result?.method === 'WM_SETTEXT',
      JSON.stringify(receipt.result ?? {}).slice(0, 120));
    check('WM_SETTEXT read back the written text', receipt.result?.readBack === MARKER,
      JSON.stringify(receipt.result?.readBack ?? null));
    check('postcondition verified', receipt.outcome === 'VERIFIED',
      `${receipt.outcome} ${JSON.stringify(receipt.verification?.evidence ?? {}).slice(0, 120)}`);

    // Confirm independently of the receipt. A control with no ValuePattern also
    // exposes no readable value field, so the only independent witnesses are the
    // native read-back and pixels: capture the window and OCR it.
    // WM_SETTEXT updates the control state immediately, but WinForms repaints on
    // its own schedule. Give it a moment, then retry: this distinguishes "not
    // shown yet" from "not shown at all".
    let ocrText = '';
    let ocrLines = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sleep(attempt === 0 ? 300 : 500);
      const shot = await call('cu_capture', { windowHandle, maxWidth: 800 });
      if (attempt === 0) check('capture produced a file', typeof shot?.path === 'string', shot?.path);
      const text = await call('cu_ocr', { imagePath: shot.path, language: 'zh-Hans' });
      ocrText = (text?.lines ?? []).map((line) => line.text).join(' ');
      ocrLines = text?.lineCount ?? 0;
      if (/WM-SETTEXT/i.test(ocrText)) break;
    }
    // Informational, not a pass/fail gate: PrintWindow returns a blank frame when
    // the desktop is locked, the session is disconnected, or the window is fully
    // occluded, so OCR availability depends on the environment rather than on the
    // write. The authoritative evidence for this control is the native read-back.
    if (/WM-SETTEXT/i.test(ocrText)) {
      console.log(`INFO  OCR independently sees the text on screen (${ocrLines} lines)`);
    } else {
      console.log(`INFO  OCR could not confirm on screen (${ocrLines} lines) — environment dependent `
        + '(locked/disconnected/occluded desktop); native read-back above is authoritative');
    }

    // Renderer-independent confirmation: read the control text through UIA TextPattern.
    const read = await call('cu_read', { windowHandle, targetRef: target.ref, observationId: obs.observationId, maxChars: 200 });
    check('cu_read returns the text through TextPattern',
      read?.ok === true && String(read.text ?? '').includes('WM-SETTEXT'),
      `via=${read?.method ?? '-'} text=${JSON.stringify(String(read?.text ?? '').slice(0, 60))}`);
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
  try { child.kill(); } catch { /* ignore */ }
  try { if (existsSync(pidPath)) rmSync(pidPath); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'WM_SETTEXT FALLBACK PASSED' : `${failures} FALLBACK CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
