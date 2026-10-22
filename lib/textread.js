/**
 * Read text out of a control through UIA, with a fallback ladder.
 *
 * TextPattern -> ValuePattern -> WM_GETTEXT.
 *
 * Why this exists: `cu_observe` only reports what the driver maps (name, value,
 * canInvoke, canSetValue). Controls backed by TextPattern expose no value field,
 * so a text model cannot see their contents at all. TextPattern is read-only —
 * useless for writing, ideal for reading.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'textread.ps1');

const POWERSHELL_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
];

export class TextReader {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'dsh-kv-computer-use');
  }

  get available() {
    return existsSync(SCRIPT_PATH) && POWERSHELL_CANDIDATES.some((p) => existsSync(p));
  }

  /**
   * @param {{windowHandle: number, runtimeId: string, maxChars?: number}} args
   * @returns {Promise<{ok: boolean, method?: string, text?: string, length?: number, error?: string, message?: string}>}
   */
  async readText({ windowHandle, runtimeId, maxChars = 2000 }) {
    if (!this.available) return { ok: false, error: 'READER_UNAVAILABLE', message: 'textread script or PowerShell missing' };
    const ps = POWERSHELL_CANDIDATES.find((p) => existsSync(p));
    mkdirSync(this.cacheDir, { recursive: true });

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outPath = join(this.cacheDir, `read_${stamp}.json`);

    try {
      await new Promise((resolve, reject) => {
        execFile(ps, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', SCRIPT_PATH,
          '-WindowHandle', String(windowHandle),
          '-RuntimeId', String(runtimeId),
          '-MaxChars', String(maxChars),
          '-OutPath', outPath,
        ], { timeout: 60000, windowsHide: true }, (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`text read failed: ${String(stderr || error.message).slice(0, 300)}`));
            return;
          }
          resolve();
        });
      });

      if (!existsSync(outPath)) return { ok: false, error: 'NO_OUTPUT', message: 'reader produced no result file' };
      const raw = readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(raw);
    } finally {
      try {
        if (existsSync(outPath)) unlinkSync(outPath);
      } catch {
        // best effort
      }
    }
  }
}
