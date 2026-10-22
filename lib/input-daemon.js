/**
 * Resident input daemon client.
 *
 * Keeps one PowerShell process alive with the compiled input helper loaded, so an
 * input action costs a round-trip (~30-80ms) instead of a process start (~1.4s).
 *
 * Falls back transparently: if the daemon cannot start or dies mid-flight, the
 * caller keeps using the one-shot path in input.js.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'input-daemon.ps1');

const POWERSHELL_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
];

const DEFAULT_TIMEOUT_MS = 20000;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

export class InputDaemon {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.dllPath = options.dllPath ?? join(homedir(), '.cache', 'dsh-kv-computer-use', 'KvCuInput.dll');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleShutdownMs = options.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
    this.child = undefined;
    this.buffer = '';
    this.pending = new Map();
    this.counter = 0;
    this.ready = false;
    this.idleTimer = undefined;
    this.startupMs = undefined;
    this.failures = 0;
  }

  get available() {
    return existsSync(SCRIPT_PATH) && existsSync(this.dllPath) && POWERSHELL_CANDIDATES.some((p) => existsSync(p));
  }

  get status() {
    return {
      available: this.available,
      running: this.child !== undefined,
      ready: this.ready,
      startupMs: this.startupMs,
      failures: this.failures,
    };
  }

  async start() {
    if (this.child !== undefined && this.ready) return;
    if (!this.available) throw new Error('input daemon unavailable (script, helper DLL or PowerShell missing)');
    const ps = POWERSHELL_CANDIDATES.find((p) => existsSync(p));
    const started = Date.now();

    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH, '-DllPath', this.dllPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consume(chunk));
    child.stderr.on('data', (chunk) => this.log('daemon_stderr', { text: String(chunk).slice(0, 300) }));
    child.on('error', (error) => {
      this.failures += 1;
      this.log('daemon_spawn_error', { message: error.message });
      this.failAll(new Error(`daemon spawn failed: ${error.message}`));
      this.child = undefined;
      this.ready = false;
    });
    child.on('exit', (code, signal) => {
      this.log('daemon_exited', { code, signal });
      this.child = undefined;
      this.ready = false;
      this.failAll(new Error(`input daemon exited (code=${code ?? 'null'})`));
    });

    this.child = child;

    // Wait for the ready handshake so the first real action is not counted twice.
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('input daemon did not become ready in time')), 15000);
      const timer = setInterval(() => {
        if (this.ready) {
          clearInterval(timer);
          clearTimeout(deadline);
          this.startupMs = Date.now() - started;
          resolve();
        }
      }, 25);
    });
    this.log('daemon_ready', { startupMs: this.startupMs });
  }

  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === '') continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        this.log('daemon_bad_line', { line: line.slice(0, 160) });
        continue;
      }
      if (payload.id === 'ready') {
        this.ready = true;
        continue;
      }
      const entry = this.pending.get(payload.id);
      if (entry === undefined) continue;
      this.pending.delete(payload.id);
      clearTimeout(entry.timer);
      if (payload.ok === true) entry.resolve(payload.result);
      else entry.reject(new Error(payload.error ?? 'daemon reported failure'));
    }
  }

  failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** @param {object} request */
  async send(request) {
    await this.start();
    const id = String(++this.counter);
    const payload = { ...request, id };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon request ${request.op} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`daemon write failed: ${error?.message ?? error}`));
      }
      this.touchIdle();
    });
  }

  touchIdle() {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.log('daemon_idle_shutdown', {});
      void this.stop();
    }, this.idleShutdownMs);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  async typeText(text) {
    const textB64 = Buffer.from(text, 'utf16le').toString('base64');
    const sent = await this.send({ op: 'type', textB64 });
    return { charactersSent: Number(sent) || 0, via: 'daemon' };
  }

  async pressVirtualKey(vk) {
    return await this.send({ op: 'key', vk });
  }

  async keyDown(vk) {
    return await this.send({ op: 'keydown', vk });
  }

  async keyUp(vk) {
    return await this.send({ op: 'keyup', vk });
  }

  /**
   * Real chord: hold every modifier, tap the final key, release in reverse order.
   * @param {number[]} codes virtual-key codes, modifiers first
   */
  async pressChord(codes) {
    const held = [];
    try {
      for (const code of codes.slice(0, -1)) {
        await this.keyDown(code);
        held.push(code);
      }
      const last = codes[codes.length - 1];
      await this.keyDown(last);
      await this.keyUp(last);
    } finally {
      for (const code of held.reverse()) {
        try {
          await this.keyUp(code);
        } catch {
          // best effort release; a stuck modifier is worse than a failed release log
        }
      }
    }
    return { virtualKeys: codes, via: 'daemon' };
  }

  /**
   * Click without moving the cursor by posting mouse messages to the window.
   * @returns {Promise<boolean>} false when the target ignored the messages
   */
  async clickWindow(windowHandle, x, y, button = 'left') {
    const ok = await this.send({ op: 'clickbg', hwnd: windowHandle, x: Math.round(x), y: Math.round(y), button });
    return ok === true;
  }

  async clickPoint(x, y, button = 'left') {
    const ok = await this.send({ op: 'click', x: Math.round(x), y: Math.round(y), button });
    return { clicked: ok === true, x, y, button, via: 'daemon' };
  }

  async scroll(notches, horizontal = false) {
    await this.send({ op: 'scroll', notches: Math.round(notches), horizontal });
    return { notches, horizontal, via: 'daemon' };
  }

  /**
   * @param {number} pid
   * @returns {Promise<{found: boolean, pid: number, exePath?: string, startedAt?: string, name?: string}>}
   */
  async processInfo(pid) {
    return await this.send({ op: 'procinfo', pid: Math.round(pid) });
  }

  async foregroundHandle() {
    const value = await this.send({ op: 'fg' });
    const handle = Number(value);
    return Number.isFinite(handle) ? handle : undefined;
  }

  async stop() {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    if (child === undefined) return;
    try {
      child.stdin.write('{"id":"quit","op":"quit"}\n');
    } catch {
      // already gone
    }
    const killed = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
    }, 1500);
    if (typeof killed.unref === 'function') killed.unref();
  }
}
