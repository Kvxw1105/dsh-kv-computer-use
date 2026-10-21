/**
 * Windows UIA driver transport.
 *
 * The driver (`kv-windows-uia-driver.exe`) speaks one JSON object per line over
 * stdio: request `{id, method, params}` -> response `{id, ok, result, error}`.
 * It is reused verbatim; this module only owns process lifecycle, request
 * correlation, timeouts and the observation-scoped short references (`uia:rN`)
 * that keep element trees small enough for a text model.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TIMEOUT_MS = 20000;

/** Candidate driver locations, most specific first. */
export function defaultDriverCandidates() {
  const home = homedir();
  return [
    process.env.KV_CU_DRIVER,
    join(home, '.cache', 'dsh-kv-computer-use', 'kv-windows-uia-driver.exe'),
    'D:\\Users\\kvxkf\\Documents\\自动化发布社媒工作空间\\kv-browser-bridge-action-seq-20260811\\apps\\windows-uia-driver\\publish\\kv-windows-uia-driver.exe',
  ].filter((p) => typeof p === 'string' && p.length > 0);
}

export function resolveDriverPath() {
  for (const candidate of defaultDriverCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export class DriverError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    this.retryable = retryable;
  }
}

export class UiaDriver {
  /** @param {{driverPath?: string, timeoutMs?: number, log?: Function}} options */
  constructor(options = {}) {
    this.driverPath = options.driverPath ?? resolveDriverPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
    this.child = undefined;
    this.pending = new Map();
    this.stdinBuffer = '';
    this.lastObservation = undefined;
    this.startFailures = 0;
  }

  get available() {
    return this.driverPath !== undefined;
  }

  status() {
    return {
      available: this.available,
      driverPath: this.driverPath,
      running: this.child !== undefined,
      startFailures: this.startFailures,
    };
  }

  ensureProcess() {
    if (this.child !== undefined) return this.child;
    if (!this.driverPath) throw new DriverError('DRIVER_NOT_FOUND', 'kv-windows-uia-driver.exe was not found. Set KV_CU_DRIVER to its absolute path.', false);

    const child = spawn(this.driverPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => this.consume(chunk));
    child.stderr.on('data', (chunk) => this.log('driver_stderr', { text: String(chunk).slice(0, 400) }));
    child.on('exit', (code, signal) => this.onExit(code, signal));
    child.on('error', (error) => {
      this.startFailures += 1;
      this.log('driver_spawn_error', { message: error.message });
      this.failAll(new DriverError('DRIVER_SPAWN_FAILED', error.message, true));
      this.child = undefined;
    });

    this.child = child;
    this.log('driver_started', { pid: child.pid });
    return child;
  }

  consume(chunk) {
    this.stdinBuffer += chunk;
    let index;
    while ((index = this.stdinBuffer.indexOf('\n')) >= 0) {
      const line = this.stdinBuffer.slice(0, index).trim();
      this.stdinBuffer = this.stdinBuffer.slice(index + 1);
      if (line === '') continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        this.log('driver_bad_line', { line: line.slice(0, 200) });
        continue;
      }
      const entry = this.pending.get(payload.id);
      if (entry === undefined) continue;
      this.pending.delete(payload.id);
      clearTimeout(entry.timer);
      if (payload.ok === true) {
        entry.resolve(payload.result);
      } else {
        const error = payload.error ?? {};
        entry.reject(new DriverError(error.code ?? 'DRIVER_ERROR', error.message ?? 'driver reported failure', Boolean(error.retryable)));
      }
    }
  }

  onExit(code, signal) {
    this.log('driver_exited', { code, signal });
    this.child = undefined;
    this.failAll(new DriverError('DRIVER_EXITED', `driver exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`, true));
  }

  failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** @param {string} method @param {object} params @param {number} [timeoutMs] */
  call(method, params = {}, timeoutMs = this.timeoutMs) {
    const child = this.ensureProcess();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DriverError('DRIVER_TIMEOUT', `${method} timed out after ${timeoutMs}ms`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DriverError('DRIVER_WRITE_FAILED', String(error?.message ?? error), true));
      }
    });
  }

  async statusCall() {
    return await this.call('status', {});
  }

  /**
   * Observe windows and normalise elements into observation-scoped short refs.
   * @param {{windowHandle?: number, maxWindows?: number, maxElements?: number, maxDepth?: number, format?: 'compact'|'full'}} params
   */
  async observe(params = {}) {
    const raw = await this.call('observe', params, Math.max(this.timeoutMs, 30000));
    // The driver already mints an observationId and returns `elements` at the top
    // level next to `targetWindow`; reuse both rather than inventing a second id.
    const observationId = raw?.observationId ?? `obs_${Date.now().toString(36)}`;
    const refMap = new Map();
    let counter = 0;

    // Driver field names are camelCase of the C# records:
    // ElementObservation(ref, depth, name, automationId, className, controlType,
    // value, isEnabled, isOffscreen, isKeyboardFocusable, canInvoke, canSetValue,
    // bounds) and WindowObservation(handle, name, className, processId, isEnabled,
    // isOffscreen, bounds, monitorHandle).
    const compactElements = (list) => {
      if (!Array.isArray(list)) return [];
      return list.map((element) => {
        counter += 1;
        const ref = `uia:r${counter}`;
        refMap.set(ref, element);
        return {
          ref,
          controlType: element.controlType,
          name: element.name,
          automationId: element.automationId,
          value: element.value,
          bounds: element.bounds,
          isEnabled: element.isEnabled,
          canInvoke: element.canInvoke,
          canSetValue: element.canSetValue,
          depth: element.depth,
        };
      });
    };

    const windows = Array.isArray(raw?.windows) ? raw.windows.map((w) => ({
      handle: w.handle,
      name: w.name,
      className: w.className,
      processId: w.processId,
      isEnabled: w.isEnabled,
      isOffscreen: w.isOffscreen,
      bounds: w.bounds,
      monitorHandle: w.monitorHandle,
    })) : [];

    let targetWindow;
    if (raw?.targetWindow) {
      targetWindow = {
        handle: raw.targetWindow.handle,
        name: raw.targetWindow.name,
        className: raw.targetWindow.className,
        processId: raw.targetWindow.processId,
        bounds: raw.targetWindow.bounds,
        monitorHandle: raw.targetWindow.monitorHandle,
        elements: compactElements(raw?.elements),
      };
    }

    this.lastObservation = { observationId, refMap, windowHandle: targetWindow?.handle, window: targetWindow };
    return {
      observationId,
      capturedAt: raw?.capturedAt ?? new Date().toISOString(),
      foregroundWindowHandle: raw?.foregroundWindowHandle,
      truncated: raw?.truncated ?? false,
      windows,
      targetWindow,
      format: params.format ?? 'compact',
    };
  }

  /** Resolve a short ref (uia:rN) to the raw element seen in the last observation. */
  resolveRef(targetRef) {    if (!this.lastObservation) {
      throw new DriverError('NO_OBSERVATION', 'Call cu_observe before acting on a ref; element refs are scoped to one observation.', false);
    }
    const element = this.lastObservation.refMap.get(targetRef);
    if (element === undefined) {
      throw new DriverError('REF_NOT_FOUND', `ref ${targetRef} is not part of observation ${this.lastObservation.observationId}; re-observe first.`, false);
    }
    return element;
  }

  /**
   * Re-observe without disturbing the refs the caller is holding.
   * Used by the freshness boundary so a staleness check never invalidates the
   * observation the model is working from.
   * @param {{windowHandle?: number, maxElements?: number, maxDepth?: number}} params
   */
  async peek(params = {}) {
    const saved = this.lastObservation;
    try {
      return await this.observe(params);
    } finally {
      this.lastObservation = saved;
    }
  }

  get observationId() {
    return this.lastObservation?.observationId;
  }

  async close() {
    this.failAll(new DriverError('DRIVER_CLOSED', 'driver closed by the host', false));
    if (this.child !== undefined) {
      const child = this.child;
      this.child = undefined;
      try {
        child.stdin.end();
      } catch {
        // already closed
      }
      child.kill();
    }
  }
}
