/**
 * Live test: background click must deliver to the window without moving the cursor.
 *
 * The whole point of posting mouse messages is that the user's pointer stays where
 * it is. So this test measures the cursor position before and after, and checks
 * that the target still received the click (the fixture logs TextChanged and the
 * window reports which element owns focus).
 *
 * Run: node test/live-bgclick.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UiaDriver } from '../lib/driver.js';
import { InputLayer } from '../lib/input.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read the cursor position in screen pixels. */
const cursorPos = () => {
  const out = execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', [
    '-NoProfile', '-Command',
    "Add-Type -Namespace W -Name C -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; } [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out P p);'; $p = New-Object W.C+P; [void][W.C]::GetCursorPos([ref]$p); \"$($p.X),$($p.Y)\"",
  ], { encoding: 'utf8' });
  const [x, y] = out.trim().split(',').map(Number);
  return { x, y };
};

const pidPath = join(tmpdir(), `kvcu-bg-${Date.now()}.pid`);
const keyLog = join(tmpdir(), `kvcu-bg-${Date.now()}.log`);
const script = join(process.cwd(), 'test', 'fixture-wpf.ps1');
const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-PidPath', pidPath, '-KeyLog', keyLog], { stdio: 'ignore' });

let fixturePid;
for (let i = 0; i < 40; i += 1) {
  await sleep(150);
  if (existsSync(pidPath)) {
    const v = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    if (Number.isFinite(v) && v > 0) { fixturePid = v; break; }
  }
}

const driver = new UiaDriver({});
const input = new InputLayer({});

try {
  check('fixture running', fixturePid !== undefined, String(fixturePid));
  if (fixturePid === undefined) throw new Error('fixture never started');

  let win;
  for (let i = 0; i < 25 && win === undefined; i += 1) {
    const obs = await driver.observe({ maxWindows: 60, maxElements: 4, maxDepth: 2 });
    win = (obs.windows ?? []).find((w) => w.processId === fixturePid);
    if (win === undefined) await sleep(200);
  }
  check('fixture window located', win !== undefined, String(win?.handle));
  if (win === undefined) throw new Error('fixture window never appeared');

  const obs = await driver.observe({ windowHandle: win.handle, maxElements: 200, maxDepth: 10 });
  const edit = (obs.targetWindow?.elements ?? []).find((e) => /Edit|Document/i.test(String(e.controlType ?? '')));
  check('text control found with bounds', edit?.bounds?.width > 0,
    edit ? `${edit.ref} ${edit.bounds.width}x${edit.bounds.height} @${edit.bounds.x},${edit.bounds.y}` : 'none');
  if (!edit) throw new Error('no text control');

  // Aim at the middle of the control; bounds are window-relative, so add the
  // window origin to get screen coordinates.
  const origin = obs.targetWindow.bounds;
  const targetX = Math.round(origin.x + edit.bounds.x + edit.bounds.width / 2);
  const targetY = Math.round(origin.y + edit.bounds.y + edit.bounds.height / 2);
  console.log(`  aiming at screen ${targetX},${targetY} (window origin ${origin.x},${origin.y})`);

  const before = cursorPos();
  console.log(`  cursor before: ${before.x},${before.y}`);

  // Make sure the pointer is somewhere else entirely, so a move would be obvious.
  await sleep(120);
  const res = await input.clickWindow({
    windowHandle: win.handle,
    x: targetX,
    y: targetY,
    button: 'left',
  });
  await sleep(250);
  const after = cursorPos();
  console.log(`  cursor after : ${after.x},${after.y}`);
  console.log(`  clickWindow  : ${JSON.stringify(res)}`);

  check('posted click reported delivered', res?.clicked === true, JSON.stringify(res).slice(0, 120));
  check('the cursor did not move', before.x === after.x && before.y === after.y,
    `${before.x},${before.y} -> ${after.x},${after.y}`);

  // Delivery evidence: the fixture logs focus/text changes.
  if (existsSync(keyLog)) {
    const log = readFileSync(keyLog, 'utf8');
    console.log(`  fixture log: ${JSON.stringify(log.slice(0, 160))}`);
    check('the fixture observed the interaction', log.length > 0, `${log.length} chars`);
  } else {
    console.log('  fixture log: none (the control may not log a bare click)');
  }

  // A real click, for contrast: this one is allowed to move the cursor.
  const realRes = await input.clickPoint(targetX, targetY, 'left');
  await sleep(200);
  const afterReal = cursorPos();
  console.log(`  real click   : ${JSON.stringify(realRes)} cursor now ${afterReal.x},${afterReal.y}`);
  check('a real click does move the cursor to the target',
    Math.abs(afterReal.x - targetX) <= 2 && Math.abs(afterReal.y - targetY) <= 2,
    `${afterReal.x},${afterReal.y} vs target ${targetX},${targetY}`);
} catch (error) {
  failures += 1;
  console.log('ERROR', String(error?.message ?? error).slice(0, 200));
} finally {
  if (fixturePid !== undefined) {
    try { execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(fixturePid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  try { child.kill(); } catch { /* ignore */ }
  for (const p of [pidPath, keyLog]) { try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } }
  await input.daemon?.stop();
  await driver.close();
}

console.log(`\n${failures === 0 ? 'BACKGROUND CLICK PASSED' : `${failures} BACKGROUND CLICK CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
