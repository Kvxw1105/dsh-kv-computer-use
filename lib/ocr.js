/**
 * WinRT OCR over a captured window image.
 *
 * Text-only models cannot read a screenshot; OCR turns pixels into positioned
 * words that a text model can reason about and click on. Windows' own OCR engine
 * is used through PowerShell so there is no extra binary and no model call.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, 'ocr.ps1');

const POWERSHELL_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
];

export class OcrReader {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'dsh-kv-computer-use');
  }

  get available() {
    return existsSync(SCRIPT_PATH) && POWERSHELL_CANDIDATES.some((p) => existsSync(p));
  }

  /**
   * @param {string} base64Png
   * @param {{language?: string}} [options]
   * @returns {Promise<{available: boolean, engineLanguage?: string, lineCount?: number, lines?: object[], reason?: string}>}
   */
  async recognizeBase64(base64Png, options = {}) {
    if (!this.available) return { available: false, reason: 'OCR script or PowerShell missing' };
    const ps = POWERSHELL_CANDIDATES.find((p) => existsSync(p));
    mkdirSync(this.cacheDir, { recursive: true });

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const imagePath = join(this.cacheDir, `ocr_${stamp}.png`);
    const outPath = join(this.cacheDir, `ocr_${stamp}.json`);

    writeFileSync(imagePath, Buffer.from(base64Png, 'base64'));
    try {
      await new Promise((resolve, reject) => {
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, '-ImagePath', imagePath, '-OutPath', outPath];
        if (options.language) args.push('-Language', options.language);
        execFile(ps, args, { timeout: 60000, windowsHide: true }, (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`OCR failed: ${String(stderr || error.message).slice(0, 400)}`));
            return;
          }
          resolve();
        });
      });

      if (!existsSync(outPath)) return { available: false, reason: 'OCR produced no output file' };
      // Windows PowerShell 5.1 writes a UTF-8 BOM with Out-File -Encoding UTF8.
      const text = readFileSync(outPath, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(text);
      return parsed;
    } finally {
      for (const path of [imagePath, outPath]) {
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          // best effort cleanup
        }
      }
    }
  }
}
