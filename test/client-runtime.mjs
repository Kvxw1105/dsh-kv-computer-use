/**
 * Client-half runtime test.
 *
 * client.js is not a module — it is a script that calls
 * `window.__ModuleLoader__.load({ id, factory })`. This test reproduces that
 * contract with a minimal fake runtime so structural mistakes (wrong id, wrong
 * factory shape, wrong slot registration) fail here instead of after a restart.
 *
 * What is proven: the module registers under the package id, the factory returns
 * { inject, apply }, apply targets the live slot with a valid registration, and
 * every registered component is a function. What is NOT proven: React rendering.
 *
 * Run: node test/client-runtime.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const source = readFileSync(join(process.cwd(), 'client.js'), 'utf8');

// ---------- fake browser runtime ----------
const loads = [];
globalThis.window = {
  __ModuleLoader__: {
    load(options) {
      loads.push(options);
    },
  },
};
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

// Minimal React that can create elements and hold hooks without rendering.
function makeFakeReact() {
  const calls = { useState: 0, useEffect: 0 };
  const createElement = (type, props, ...children) => ({ type, props, children });
  return {
    calls,
    createElement,
    useState(initial) {
      calls.useState += 1;
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {
      calls.useEffect += 1;
    },
  };
}

try {
  // Execute the script the way the browser would: as global-scope code.
  const fn = new Function('window', source);
  fn(globalThis.window);
} catch (error) {
  check('client.js executes without throwing', false, String(error?.message ?? error));
}

check('client.js called __ModuleLoader__.load once', loads.length === 1, `${loads.length} calls`);
const load = loads[0];
check('module id equals the package name', load?.id === pkg.name, `${load?.id} vs ${pkg.name}`);
check('factory is a function', typeof load?.factory === 'function');

// ---------- factory ----------
const fakeReact = makeFakeReact();
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require: ${name}`);
};

let exported;
try {
  exported = load.factory(fakeRequire);
} catch (error) {
  check('factory returns without throwing', false, String(error?.message ?? error));
}
check('factory returns an object', exported !== undefined && typeof exported === 'object');
check('exports inject: [slots]', Array.isArray(exported?.inject) && exported.inject.includes('slots'),
  JSON.stringify(exported?.inject));
check('exports apply', typeof exported?.apply === 'function');

// ---------- apply: slot registration ----------
const registrations = [];
const injections = [];
const fakeCtx = {
  slots: {
    inject(slotName, cb) {
      injections.push(slotName);
      cb();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

try {
  exported.apply(fakeCtx);
} catch (error) {
  check('apply runs without throwing', false, String(error?.message ?? error));
}

check('apply injects into conversation.composer.dock',
  injections.includes('conversation.composer.dock'), JSON.stringify(injections));
check('registers exactly one occupant', registrations.length === 1, `${registrations.length}`);

const reg = registrations[0];
check('registration carries the slot name', reg?.options?.name === 'conversation.composer.dock', reg?.options?.name);
check('registration has its own id (does not replace a shipped cell)',
  typeof reg?.options?.id === 'string' && reg.options.id !== 'activity' && reg.options.id !== 'usage',
  reg?.options?.id);
check('registration sets a numeric order', Number.isFinite(reg?.options?.order), String(reg?.options?.order));
check('occupant is a component function', typeof reg?.component === 'function',
  typeof reg?.component);

// ---------- component is callable with fake hooks ----------
try {
  const tree = reg.component({});
  check('component returns a tree (null when idle)', tree === null || typeof tree === 'object',
    tree === null ? 'null (idle, expected)' : typeof tree.type);
} catch (error) {
  check('component renders without throwing', false, String(error?.message ?? error));
}
check('component used hooks (useState/useEffect)', fakeReact.calls.useState >= 1 && fakeReact.calls.useEffect >= 1,
  JSON.stringify(fakeReact.calls));

// ---------- package manifest agreement ----------
check('package declares dsh.client.platform = web', pkg.dsh?.client?.platform === 'web', pkg.dsh?.client?.platform);
check('package declares immediately', pkg.dsh?.client?.immediately === true);
check('package exports ./client', pkg.exports?.['./client'] === './client.js', JSON.stringify(pkg.exports?.['./client']));
check('client file is listed in files[]', (pkg.files ?? []).some((f) => String(f).includes('client.js')));

// ---------- no forbidden patterns ----------
check('client does not append to document.body', !/document\.body/.test(source));
check('client does not touch the app root', !/replaceChild|removeChild\(.*root/i.test(source));
check('client styles are scoped (inline or injected style element)', /style:/.test(source) || /createElement\('style'/.test(source));

console.log(`\n${failures === 0 ? 'CLIENT RUNTIME PASSED' : `${failures} CLIENT RUNTIME CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
