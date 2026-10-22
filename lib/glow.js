/**
 * System-wide activity glow.
 *
 * A border-only, click-through overlay across all monitors, shown while an action
 * runs. Distinct from the in-page glow in client.js: this one is visible no matter
 * which window the user is looking at, because it is its own layered top-level
 * window rather than a div inside the Harness page.
 *
 * The overlay is a long-lived PowerShell process watching a state file, so showing
 * or hiding it costs a file write rather than a process start.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'glow.ps1');

const POWERSHELL_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
];

const STALE_MS = 2500;

export class ActivityGlow {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.enabled = options.enabled !== false;
    this.cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'dsh-kv-computer-use');
    this.statePath = join(this.cacheDir, 'glow.state');
    this.child = undefined;
    this.failures = 0;
  }

  get available() {
    return this.enabled && existsSync(SCRIPT_PATH) && POWERSHELL_CANDIDATES.some((p) => existsSync(p));
  }

  get status() {
    return {
      enabled: this.enabled,
      available: this.available,
      running: this.child !== undefined,
      failures: this.failures,
      statePath: this.statePath,
    };
  }

  start() {
    if (!this.available || this.child !== undefined) return;
    const ps = POWERSHELL_CANDIDATES.find((p) => existsSync(p));
    try {
      mkdirSync(this.cacheDir, { recursive: true });
    } catch {
      // cache dir already fine or unreadable; the overlay will simply not show
    }
    const child = spawn(ps, [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH, '-StatePath', this.statePath,
    ], { stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => {
      this.failures += 1;
      this.log('glow_spawn_error', { message: error.message });
      this.child = undefined;
    });
    child.on('exit', (code) => {
      this.log('glow_exited', { code });
      this.child = undefined;
    });
    this.child = child;
    this.log('glow_started', { pid: child.pid });
  }

  /** Mark the overlay as active for the next few seconds. */
  show() {
    if (!this.available) return;
    if (this.child === undefined) this.start();
    try {
      writeFileSync(this.statePath, String(Date.now()), 'utf8');
    } catch (error) {
      this.failures += 1;
      this.log('glow_state_write_failed', { message: String(error?.message ?? error) });
    }
  }

  /** Hide immediately (the overlay also self-hides when the timestamp goes stale). */
  hide() {
    try {
      if (existsSync(this.statePath)) rmSync(this.statePath);
    } catch {
      // best effort
    }
  }

  stop() {
    this.hide();
    if (this.child !== undefined) {
      const child = this.child;
      this.child = undefined;
      try { child.kill(); } catch { /* already gone */ }
    }
  }
}

export { STALE_MS };
