import { apply } from './lib/index.js';
const tools = new Map();
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name); } },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined; },
  get: () => undefined,
};
apply(ctx, { toolset: 'core', autoSettle: false, glow: false });
const call = async (n, a) => (tools.get(n).execute ?? tools.get(n).handler)(a);
const obs = await call('cu_observe', { maxWindows: 6, maxElements: 8, maxDepth: 3, autoOcr: 'off' });
const target = (obs.windows ?? []).find(w => (w.bounds?.width ?? 0) > 300);
console.log('target window', target?.handle, JSON.stringify(target?.name)?.slice(0, 30));
const first = await call('cu_act', { action: 'focus', reason: 'throttle test 1', windowHandle: target.handle, observationId: obs.observationId });
console.log('1st :', first.status, first.outcome, first.result?.skipped ? 'skipped' : 'executed', first.error?.code ?? '');
const second = await call('cu_act', { action: 'focus', reason: 'throttle test 2', windowHandle: target.handle, observationId: obs.observationId });
console.log('2nd :', second.status, second.outcome, second.result?.skipped ? 'skipped (throttled)' : 'executed', second.error?.code ?? '');
console.log('2nd note:', String(second.result?.note ?? '').slice(0, 90));
