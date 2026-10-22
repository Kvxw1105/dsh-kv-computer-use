/**
 * Process identity test: the exe path that widens the freshness identity.
 *
 * A pid alone can be reused by another process, so the freshness boundary also
 * compares the executable path when the resident daemon can resolve it. This test
 * checks the daemon op and that an observation actually carries the path.
 *
 * Run: node test/procinfo.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InputLayer } from '../lib/input.js';
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

// ---------- daemon op ----------
const layer = new InputLayer({});
await layer.ensureCompiled();
const daemon = layer.daemon;
await daemon.start();
check('daemon started for process lookup', daemon.ready === true, `startup=${daemon.startupMs}ms`);

const self = await daemon.processInfo(process.pid);
check('processInfo resolves the current process', self?.found === true, `pid=${self?.pid}`);
check('processInfo returns an executable path',
  typeof self?.exePath === 'string' && self.exePath.toLowerCase().includes('node'),
  self?.exePath);
check('processInfo returns a start time', typeof self?.startedAt === 'string', self?.startedAt);

const ghost = await daemon.processInfo(999999);
check('unknown pid reports found=false', ghost?.found === false, JSON.stringify(ghost));

// ---------- an observation carries it ----------
const pidPath = join(tmpdir(), `kvcu-pi-${Date.now()}.pid`);
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
apply(ctx, { toolset: 'core', ttlMs: 60000, autoSettle: false });

const call = async (name, args = {}) => {
  const tool = tools.get(name);
  return await (tool.execute ?? tool.handler)(args);
};

try {
  check('fixture running', fixturePid !== undefined, String(fixturePid));
  if (fixturePid !== undefined) {
    const obs = await call('cu_observe', { maxWindows: 60, maxElements: 100, maxDepth: 8, autoOcr: 'off' });
    const win = (obs.windows ?? []).find((w) => w.processId === fixturePid);
    check('fixture window found', win !== undefined, String(win?.handle));

    const scoped = await call('cu_observe', { windowHandle: win.handle, maxElements: 100, maxDepth: 8, autoOcr: 'off' });
    const identity = scoped.freshness?.identity;
    console.log(`  identity: ${JSON.stringify(identity)}`);
    check('identity carries the pid', identity?.pid === fixturePid, String(identity?.pid));
    check('identity carries the executable path',
      typeof identity?.exe === 'string' && identity.exe.toLowerCase().includes('powershell'),
      String(identity?.exe));

    // A different window must not validate against this identity.
    const other = (obs.windows ?? []).find((w) => w.processId !== fixturePid && w.bounds?.width > 400);
    if (other !== undefined) {
      const otherObs = await call('cu_observe', { windowHandle: other.handle, maxElements: 60, maxDepth: 6, autoOcr: 'off' });
      check('a different window produces a different identity hash',
        otherObs.freshness?.identity?.pid !== identity?.pid,
        `${otherObs.freshness?.identity?.pid} vs ${identity?.pid}`);
    }
  }
} finally {
  if (fixturePid !== undefined) {
    try { execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(fixturePid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  try { child.kill(); } catch { /* ignore */ }
  try { if (existsSync(pidPath)) rmSync(pidPath); } catch { /* ignore */ }
  await daemon.stop();
}

console.log(`\n${failures === 0 ? 'PROCESS IDENTITY PASSED' : `${failures} IDENTITY CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
