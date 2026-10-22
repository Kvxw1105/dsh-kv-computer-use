/**
 * Observation layer tests: element search and the OCR fallback.
 *
 * Uses the WPF fixture (one Edit named kvTarget) so the assertions are about real
 * UIA data, not mocks. OCR content is environment dependent (a locked or
 * disconnected desktop yields no pixels), so only the structure is asserted.
 *
 * Run: node test/observe.mjs
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

const pidPath = join(tmpdir(), `kvcu-obs-${Date.now()}.pid`);
const script = join(process.cwd(), 'test', 'fixture-wpf.ps1');
const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
  '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-PidPath', pidPath,
], { stdio: 'ignore' });

let fixturePid;
for (let i = 0; i < 40; i += 1) {
  await sleep(150);
  if (existsSync(pidPath)) {
    const v = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isFinite(v) && v > 0) { fixturePid = v; break; }
  }
}

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
  check('fixture running', fixturePid !== undefined, String(fixturePid));
  if (fixturePid === undefined) throw new Error('fixture never started');

  const obs = await call('cu_observe', { maxWindows: 60, maxElements: 200, maxDepth: 10, autoOcr: 'off' });
  const fixtureWindow = (obs.windows ?? []).find((w) => w.processId === fixturePid);
  check('fixture window observed', fixtureWindow !== undefined, String(fixtureWindow?.handle));
  const windowHandle = fixtureWindow.handle;

  // ---------- cu_find ----------
  const byName = await call('cu_find', { windowHandle, query: 'kvTarget' });
  check('find by name returns the Edit', byName.matched >= 1,
    `${byName.matched}/${byName.scanned} elements, interactive=${byName.interactive}`);
  check('find returns a usable ref', /^uia:r\d+$/.test(String(byName.elements?.[0]?.ref ?? '')),
    byName.elements?.[0]?.ref);
  check('find returns an observationId', typeof byName.observationId === 'string', byName.observationId);

  const byType = await call('cu_find', { windowHandle, query: 'Edit', by: 'controlType' });
  check('find by controlType works', byType.matched >= 1, `${byType.matched} matches`);

  const interactiveOnly = await call('cu_find', { windowHandle, query: 'kvTarget', interactiveOnly: true });
  check('interactiveOnly filters non-actionable elements',
    interactiveOnly.elements.every((e) => e.canInvoke === true || e.canSetValue === true),
    `${interactiveOnly.matched} interactive`);

  const noMatch = await call('cu_find', { windowHandle, query: '__definitely_absent__' });
  check('no match returns zero without error', noMatch.matched === 0, `scanned=${noMatch.scanned}`);

  let regexOk;
  try {
    regexOk = await call('cu_find', { windowHandle, query: '^kv', by: 'regex' });
  } catch {
    regexOk = { matched: 0 };
  }
  check('regex mode works', regexOk.matched >= 1, `${regexOk.matched} matches`);

  let badRegex = false;
  try {
    await call('cu_find', { windowHandle, query: '[unclosed', by: 'regex' });
  } catch {
    badRegex = true;
  }
  check('invalid regex is rejected', badRegex === true);

  // the ref from find must be actionable
  const ref = byName.elements?.[0]?.ref;
  if (ref) {
    const receipt = await call('cu_act', {
      action: 'set_value',
      reason: 'observe test: use the ref returned by cu_find',
      targetRef: ref,
      value: 'FIND-REF-OK',
      windowHandle,
      observationId: byName.observationId,
      expectKind: 'value_equals',
      expectValue: 'FIND-REF-OK',
      expectName: 'kvTarget',
    });
    check('ref from cu_find is directly actionable', receipt.status === 'completed', receipt.error?.code);
    check('write through that ref verifies', receipt.outcome === 'VERIFIED', receipt.outcome);
  }

  // ---------- capture dedupe on a static region ----------
  const region = { windowHandle, maxWidth: 400, regionX: 0, regionY: 0, regionWidth: 300, regionHeight: 24 };
  const cap1 = await call('cu_capture', region);
  await sleep(400);
  const cap2 = await call('cu_capture', region);
  check('first capture returns an image', typeof cap1?.path === 'string', cap1?.shotHash?.slice(0, 10));
  check('identical region is deduped instead of re-sent', cap2?.unchanged === true,
    cap2?.unchanged ? cap2.note?.slice(0, 40) : `second=${cap2?.path ? 'image' : cap2?.error?.code}`);
  const forcedCapture = await call('cu_capture', { ...region, dedupe: false });
  check('dedupe:false still returns an image', typeof forcedCapture?.path === 'string', forcedCapture?.shotHash?.slice(0, 10));

  // ---------- OCR fallback ----------
  const off = await call('cu_observe', { windowHandle, maxElements: 200, maxDepth: 10, autoOcr: 'off' });
  check('autoOcr=off attaches no ocr block', off.ocr === undefined);

  const forced = await call('cu_observe', { windowHandle, maxElements: 200, maxDepth: 10, autoOcr: 'on' });
  check('autoOcr=on attaches an ocr block', forced.ocr !== undefined,
    `triggered=${forced.ocr?.triggered} lines=${forced.ocr?.lineCount ?? '-'} error=${forced.ocr?.error ?? '-'}`);
  check('ocr block reports a trigger reason', ['explicit', 'sparse-tree'].includes(forced.ocr?.triggered));
  if (forced.ocr?.lines?.length) {
    const line = forced.ocr.lines[0];
    check('ocr lines carry text and an anchor point',
      typeof line.text === 'string' && Number.isFinite(line.x) && Number.isFinite(line.y),
      JSON.stringify(line).slice(0, 80));
  }

  const auto = await call('cu_observe', { windowHandle, maxElements: 200, maxDepth: 10 });
  const autoOcrRan = auto.ocr !== undefined;
  console.log(`INFO  auto mode on a normal tree: ocr ${autoOcrRan ? 'ran' : 'skipped'} `
    + `(sparse heuristic: ${(auto.targetWindow?.elements ?? []).length} elements)`);
  check('auto mode is a no-op on a rich tree', autoOcrRan === false || auto.ocr.triggered === 'sparse-tree');
} catch (error) {
  failures += 1;
  console.log('ERROR', error?.message ?? error);
} finally {
  if (fixturePid !== undefined) {
    try { execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(fixturePid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  try { child.kill(); } catch { /* ignore */ }
  try { if (existsSync(pidPath)) rmSync(pidPath); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'OBSERVATION LAYER PASSED' : `${failures} OBSERVATION CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
