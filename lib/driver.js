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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Default request budget. Kept short on purpose: a UI Automation walk of a busy
 * Electron or Qt window (a compositor, an effects app mid-render) blocks on the
 * target's UI thread, and a 30s budget means the caller waits 30s to learn
 * nothing. Failing fast with a named error is more useful than hanging.
 */
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Candidate driver locations, most specific first.
 *
 * No personal path is baked in: the driver repo can live anywhere, so the search
 * roots come from KV_CU_DRIVER (an exact exe) or KV_CU_DRIVER_SEARCH (a
 * semicolon-separated list of roots, each probed for the exe directly and under
 * apps/windows-uia-driver/publish).
 */
export function defaultDriverCandidates() {
  const home = homedir();
  const candidates = [
    process.env.KV_CU_DRIVER,
    join(home, '.cache', 'dsh-kv-computer-use', 'kv-windows-uia-driver.exe'),
  ];

  // A pointer file written the first time the driver was located keeps the plugin
  // working after the user's checkout moves, without baking a path into the package.
  try {
    const pointer = join(home, '.cache', 'dsh-kv-computer-use', 'driver.path');
    if (existsSync(pointer)) {
      const remembered = readFileSync(pointer, 'utf8').trim();
      if (remembered !== '') candidates.push(remembered);
    }
  } catch {
    // an unreadable pointer is not fatal; the other candidates still apply
  }

  for (const root of String(process.env.KV_CU_DRIVER_SEARCH ?? '').split(';')) {
    const trimmed = root.trim();
    if (trimmed === '') continue;
    candidates.push(join(trimmed, 'kv-windows-uia-driver.exe'));
    candidates.push(join(trimmed, 'apps', 'windows-uia-driver', 'publish', 'kv-windows-uia-driver.exe'));
  }
  return candidates.filter((p) => typeof p === 'string' && p.length > 0);
}

/**
 * Remember where the driver was found so later runs do not depend on an env var.
 * Best effort: a read-only cache dir must not stop the plugin from working.
 */
export function rememberDriverPath(driverPath) {
  try {
    const dir = join(homedir(), '.cache', 'dsh-kv-computer-use');
    mkdirSync(dir, { recursive: true });
    const pointer = join(dir, 'driver.path');
    if (existsSync(pointer) && readFileSync(pointer, 'utf8').trim() === driverPath) return;
    writeFileSync(pointer, driverPath, 'utf8');
  } catch {
    // ignore: remembering the path is a convenience, not a requirement
  }
}

/**
 * Fingerprint the driver binary.
 *
 * The execution engine is a 155 MB binary that lives outside this package (a
 * checkout of the KV Computer Use project). Nothing else verifies it: a swapped or
 * truncated file would simply be spawned. Hashing it once per path lets a
 * replacement be detected instead of silently trusted.
 *
 * @param {string} driverPath
 * @returns {string|undefined} sha256 hex, or undefined when the file cannot be read
 */
export function fingerprintDriver(driverPath) {
  try {
    const hash = createHash('sha256');
    hash.update(readFileSync(driverPath));
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Compare the current driver against the fingerprint recorded on first use.
 * A missing record is accepted and written; a mismatch is refused.
 *
 * @param {string} driverPath
 * @param {{ trustDriver?: boolean, log?: Function }} [options]
 * @returns {{ ok: boolean, status: 'pinned'|'first-use'|'mismatch'|'unreadable'|'untrusted', expected?: string, actual?: string }}
 */
export function verifyDriver(driverPath, options = {}) {
  const log = options.log ?? (() => {});
  const actual = fingerprintDriver(driverPath);
  if (actual === undefined) return { ok: false, status: 'unreadable' };

  const dir = join(homedir(), '.cache', 'dsh-kv-computer-use');
  const record = join(dir, 'driver.sha256');

  let expected;
  try {
    if (existsSync(record)) expected = readFileSync(record, 'utf8').trim().split(/\s+/)[0];
  } catch {
    expected = undefined;
  }

  if (expected === undefined) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(record, `${actual}  ${driverPath}
`, 'utf8');
      log('driver_pinned', { sha256: actual.slice(0, 16) });
    } catch {
      // cannot record; still usable, just not pinned
    }
    return { ok: true, status: 'first-use', actual };
  }

  if (expected === actual) return { ok: true, status: 'pinned', expected, actual };

  if (options.trustDriver === true) {
    // Explicit opt-in for a deliberate driver upgrade.
    try {
      writeFileSync(record, `${actual}  ${driverPath}
`, 'utf8');
    } catch {
      // ignore
    }
    log('driver_repinned', { from: expected.slice(0, 16), to: actual.slice(0, 16) });
    return { ok: true, status: 'untrusted', expected, actual };
  }

  return { ok: false, status: 'mismatch', expected, actual };
}

export function resolveDriverPath() {
  for (const candidate of defaultDriverCandidates()) {
    if (existsSync(candidate)) {
      rememberDriverPath(candidate);
      return candidate;
    }
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
    this.trustDriver = options.trustDriver === true;
    this.verification = undefined;
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

    // Verify the binary once per session before executing it. A mismatch means the
    // file changed since first use (swapped, truncated, rebuilt) and is refused
    // unless the operator explicitly trusts it.
    if (this.verification === undefined) {
      this.verification = verifyDriver(this.driverPath, { trustDriver: this.trustDriver, log: this.log });
      this.log('driver_verified', { status: this.verification.status });
    }
    if (this.verification.ok !== true) {
      const v = this.verification;
      throw new DriverError(
        v.status === 'mismatch' ? 'DRIVER_UNTRUSTED' : 'DRIVER_UNREADABLE',
        v.status === 'mismatch'
          ? `driver hash changed (recorded ${String(v.expected).slice(0, 16)}, found ${String(v.actual).slice(0, 16)}) — refusing to execute it; if this is a deliberate upgrade set trustDriver: true or delete ~/.cache/dsh-kv-computer-use/driver.sha256`
          : 'driver binary could not be read for verification',
        false,
      );
    }

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
        const hint = method === 'observe'
          ? ' — the target window most likely has a busy UI thread (Electron/Qt/effects apps); retry with a smaller maxElements/maxDepth or target a different window'
          : '';
        reject(new DriverError('DRIVER_TIMEOUT', `${method} timed out after ${timeoutMs}ms${hint}`, true));
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
    // Observe gets a little more room than a single action (it walks a tree), but
    // still bounded so a wedged target surfaces as an error instead of a hang.
    const observeBudget = Math.min(Math.max(this.timeoutMs * 2, 8000), 20000);
    const raw = await this.call('observe', params, observeBudget);
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
    const shape = {
      windowHandle: params.windowHandle,
      maxElements: params.maxElements,
      maxDepth: params.maxDepth,
      maxWindows: params.maxWindows,
    };
    return {
      observationId,
      capturedAt: raw?.capturedAt ?? new Date().toISOString(),
      foregroundWindowHandle: raw?.foregroundWindowHandle,
      truncated: raw?.truncated ?? false,
      windows,
      targetWindow,
      shape,
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
