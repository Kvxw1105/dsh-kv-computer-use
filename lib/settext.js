/**
 * Background text write for controls without a UIA ValuePattern.
 *
 * Some controls (WinForms TextBox, parts of Electron/Chromium) expose only
 * TextPattern, which is read-only. The only way to write into them without
 * stealing focus is WM_SETTEXT on the control's own native window handle.
 *
 * This runs through PowerShell + System.Windows.Automation so the shared driver
 * binary never has to be patched or rebuilt.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'settext.ps1');

const POWERSHELL_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
];

export class SetTextFallback {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'dsh-kv-computer-use');
  }

  get available() {
    return existsSync(SCRIPT_PATH) && POWERSHELL_CANDIDATES.some((p) => existsSync(p));
  }

  /**
   * @param {{windowHandle: number, runtimeId: string, value: string}} args
   * @returns {Promise<{ok: boolean, method?: string, valueSet?: boolean, readBack?: string, error?: string, message?: string}>}
   */
  async setValue({ windowHandle, runtimeId, value }) {
    if (!this.available) return { ok: false, error: 'FALLBACK_UNAVAILABLE', message: 'settext script or PowerShell missing' };
    const ps = POWERSHELL_CANDIDATES.find((p) => existsSync(p));
    mkdirSync(this.cacheDir, { recursive: true });

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const outPath = join(this.cacheDir, `settext_${stamp}.json`);

    try {
      await new Promise((resolve, reject) => {
        execFile(ps, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', SCRIPT_PATH,
          '-WindowHandle', String(windowHandle),
          '-RuntimeId', String(runtimeId),
          '-Value', String(value ?? ''),
          '-OutPath', outPath,
        ], { timeout: 60000, windowsHide: true }, (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`WM_SETTEXT fallback failed: ${String(stderr || error.message).slice(0, 300)}`));
            return;
          }
          resolve();
        });
      });

      if (!existsSync(outPath)) return { ok: false, error: 'NO_OUTPUT', message: 'fallback produced no result file' };
      const text = readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
      return JSON.parse(text);
    } finally {
      try {
        if (existsSync(outPath)) unlinkSync(outPath);
      } catch {
        // best effort
      }
    }
  }
}
