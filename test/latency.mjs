/**
 * Latency test for the resident input daemon.
 *
 * Measures foregroundHandle() because it is side-effect free — no keystrokes are
 * sent, nothing on the desktop changes. Compares the one-shot PowerShell path with
 * the daemon path so the speed-up is a measurement, not a claim.
 *
 * Run: node test/latency.mjs
 */

import { InputLayer } from '../lib/input.js';

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const layer = new InputLayer({});

console.log('input status:', JSON.stringify(layer.status));
if (!layer.available) {
  console.log('input layer unavailable; nothing to measure');
  process.exit(1);
}

// warm the helper so compilation is not part of the measurement
await layer.ensureCompiled();

// ---------- one-shot baseline ----------
const oneShot = [];
for (let i = 0; i < 3; i += 1) {
  const started = Date.now();
  await layer.run('[KvCuInput]::ForegroundHandle()');
  oneShot.push(Date.now() - started);
}
console.log(`one-shot : ${oneShot.join(', ')} ms (median ${median(oneShot)}ms)`);

// ---------- daemon ----------
const daemon = layer.daemon;
if (!daemon || !daemon.available) {
  console.log('daemon unavailable; baseline only');
  process.exit(0);
}

const started = Date.now();
await daemon.start();
const startupMs = Date.now() - started;
console.log(`daemon start: ${startupMs}ms (ready=${daemon.ready})`);

const warm = [];
for (let i = 0; i < 10; i += 1) {
  const t0 = Date.now();
  const handle = await daemon.foregroundHandle();
  warm.push(Date.now() - t0);
  if (i === 0) console.log(`first daemon call: ${warm[0]}ms -> handle ${handle}`);
}
const daemonMedian = median(warm.slice(1));
console.log(`daemon   : ${warm.slice(1).join(', ')} ms (median ${daemonMedian}ms)`);

// ---------- through the public API ----------
const api = [];
for (let i = 0; i < 5; i += 1) {
  const t0 = Date.now();
  await layer.foregroundHandle();
  api.push(Date.now() - t0);
}
console.log(`layer API: ${api.join(', ')} ms (median ${median(api)}ms)`);

const baselineMedian = median(oneShot);
const speedup = baselineMedian / Math.max(daemonMedian, 1);
console.log(`\nspeed-up: ${speedup.toFixed(1)}x (${baselineMedian}ms -> ${daemonMedian}ms)`);
console.log(speedup >= 5 ? 'PASS  daemon is at least 5x faster than the one-shot path' : 'WARN  speed-up below 5x');

await daemon.stop();
console.log('daemon stopped');
