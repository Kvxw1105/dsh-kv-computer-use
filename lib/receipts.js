/**
 * Durable action receipts.
 *
 * Every executed action and sequence is appended as one JSON line, so a later
 * turn (or a different agent) can reconstruct exactly what was done, what was
 * expected, and whether it was verified.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_SCAN_LINES = 5000;

export class ReceiptStore {
  constructor(options = {}) {
    this.dir = options.dir ?? join(homedir(), '.cache', 'dsh-kv-computer-use');
    this.file = join(this.dir, 'receipts.jsonl');
  }

  path() {
    return this.file;
  }

  append(record) {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  readAll() {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const slice = lines.slice(-MAX_SCAN_LINES);
    const out = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip a torn line
      }
    }
    return out;
  }

  recent(limit = 20) {
    const all = this.readAll();
    return all.slice(-limit).reverse();
  }

  find(actionId) {
    const all = this.readAll();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const record = all[i];
      if (record?.actionId === actionId || record?.sequenceId === actionId) return record;
    }
    return undefined;
  }
}
