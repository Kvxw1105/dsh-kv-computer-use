/**
 * dsh-kv-computer-use — Web UI half.
 *
 * Shows what the agent is doing to the desktop right now, and gives the human a
 * stop that works even while the model is mid-action:
 *
 *   - a dock row above the composer while an action is running
 *   - Esc stops the next mutating action (the host refuses it before it happens)
 *   - when stopped, the row turns into a "stopped / resume" affordance
 *
 * State comes from the host route /kv-computer-use/state; the stop is
 * POST /kv-computer-use/abort. No DOM outside the registered slot is touched and
 * no timers survive unmount.
 */

window.__ModuleLoader__.load({
  id: 'dsh-kv-computer-use',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const POLL_MS = 1200;

    const LABELS = {
      invoke_ref: '点击控件',
      set_value_ref: '写入文本',
      type_text: '键盘输入',
      hotkey: '组合键',
      click_point: '鼠标点击',
      scroll: '滚动',
      focus_window: '切换窗口',
      wait: '等待',
    };

    function useActivity() {
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const res = await fetch('/kv-computer-use/state', { headers: { accept: 'application/json' } });
            if (!res.ok) return;
            const body = await res.json();
            if (alive) setState(body);
          } catch {
            // host may be restarting; keep the last known state instead of flicker
          }
        };
        void tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      return [state, setState];
    }

    async function post(route) {
      try {
        await fetch(`/kv-computer-use/${route}`, { method: 'POST' });
      } catch {
        // best effort: the host will refuse actions anyway once it sees the flag
      }
    }

    function StatusDock() {
      const [state, setState] = useActivity();

      const active = state?.activity?.active === true;
      const aborted = state?.aborted === true;

      React.useEffect(() => {
        if (!active && !aborted) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          if (aborted) {
            void post('resume').then(() => setState((prev) => (prev ? { ...prev, aborted: false } : prev)));
            return;
          }
          if (!active) return;
          // Only intercept while an action is actually running, so Esc keeps its
          // normal meaning everywhere else in the app.
          event.preventDefault();
          event.stopPropagation();
          void post('abort').then(() => setState((prev) => (prev ? { ...prev, aborted: true } : prev)));
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
      }, [active, aborted, setState]);

      if (!state) return null;
      if (!active && !aborted) return null;

      const actionType = state.activity?.action;
      const label = LABELS[actionType] ?? actionType ?? '操作';
      const seconds = active && state.activity?.startedAt
        ? Math.max(0, Math.round((Date.now() - state.activity.startedAt) / 100) / 10)
        : undefined;

      const container = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '0 auto 6px',
        padding: '4px 10px',
        borderRadius: 999,
        border: '1px solid currentColor',
        opacity: aborted ? 0.95 : 0.8,
        fontSize: 12,
        lineHeight: 1.4,
        maxWidth: 720,
        background: aborted
          ? 'color-mix(in srgb, currentColor 12%, transparent)'
          : 'color-mix(in srgb, currentColor 6%, transparent)',
      };

      const dot = {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: 'currentColor',
        opacity: active ? 1 : 0.4,
        animation: active ? 'kvcu-pulse 1.1s ease-in-out infinite' : 'none',
        flex: '0 0 auto',
      };

      const button = {
        marginLeft: 'auto',
        padding: '2px 8px',
        borderRadius: 6,
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      };

      return h(
        'div',
        { role: 'status', 'aria-live': 'polite', style: container },
        h('style', null, '@keyframes kvcu-pulse{0%,100%{opacity:.35}50%{opacity:1}}'),
        h('span', { style: dot }),
        h('span', null, aborted
          ? '电脑操作已停止'
          : `正在操作电脑 · ${label}${seconds !== undefined ? ` · ${seconds}s` : ''} · 按 Esc 停止`),
        h('button', {
          type: 'button',
          style: button,
          onClick: () => {
            const route = aborted ? 'resume' : 'abort';
            void post(route).then(() => setState((prev) => (prev ? { ...prev, aborted: !aborted } : prev)));
          },
        }, aborted ? '继续' : '停止'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'kv-computer-use-status',
          order: 60,
        }, StatusDock));
      },
    };
  },
});
