/**
 * Pre-action guard: dangerous targets, password fields, application scope.
 *
 * Adapted from two market implementations, but expressed as facts the action
 * contract can act on rather than as a silent rejection:
 *   - @bhzhangsun/dsh-computer-use lib/guard.js: zh/en dangerous-word patterns,
 *     secure-field detection, allowedApps scope.
 *   - dsh-click: approval subject = window title + executable path.
 *
 * Every verdict carries a reason string so the receipt can explain itself.
 */

/** Targets whose label implies an irreversible or consequential effect. */
const DANGEROUS_PATTERNS = [
  /删除|移除|清空|清倒|格式化|卸载|永久|重置|初始化/,
  /支付|付款|购买|下单|结账|转账|汇款|提交订单|确认交易|确认支付/,
  /退出登录|注销|登出|解绑|取消订阅/,
  /\b(delete|remove|erase|format|uninstall|reset|wipe)\b/i,
  /\b(pay|purchase|checkout|transfer|confirm order|subscribe)\b/i,
  /\b(sign out|log out|logout|unlink)\b/i,
];

/** Field shapes that must never receive automated text. */
const SECURE_FIELD_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[-_ ]?key/i,
  /密码|口令|密钥|验证码/,
];

/**
 * @param {string} label
 * @returns {boolean}
 */
export function isDangerousLabel(label) {
  const text = String(label ?? '');
  if (text === '') return false;
  return DANGEROUS_PATTERNS.some((re) => re.test(text));
}

/**
 * A field is secure when its role/automation id/name says so, or when the UIA
 * driver marked it as a password control.
 * @param {{controlType?: string, name?: string, automationId?: string, isPassword?: boolean}} element
 * @returns {boolean}
 */
export function isSecureField(element) {
  if (!element || typeof element !== 'object') return false;
  if (element.isPassword === true) return true;
  const haystack = `${element.name ?? ''} ${element.automationId ?? ''}`;
  if (haystack.trim() === '') return false;
  return SECURE_FIELD_PATTERNS.some((re) => re.test(haystack));
}

/**
 * Application scope. An empty allowlist means "no scope restriction".
 * Entries match the window title, class name, or pid.
 * @param {string[]} allowedApps
 * @param {{title?: string, className?: string, processId?: number}} window
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkAppScope(allowedApps, window) {
  if (!Array.isArray(allowedApps) || allowedApps.length === 0) return { allowed: true };
  if (!window) return { allowed: false, reason: 'no target window to check against allowedApps' };
  const haystack = [window.name, window.title, window.className, String(window.processId ?? '')]
    .filter((v) => v !== undefined && v !== '')
    .join(' ');
  const hit = allowedApps.some((entry) => {
    const needle = String(entry).toLowerCase();
    return needle !== '' && haystack.toLowerCase().includes(needle);
  });
  return hit
    ? { allowed: true }
    : { allowed: false, reason: `window "${window.name ?? window.title ?? '?'}" is outside allowedApps [${allowedApps.join(', ')}]` };
}

/**
 * Full pre-action verdict for one action.
 *
 * @param {object} input
 * @param {{type: string, targetRef?: string}} input.action
 * @param {{ref: string, name?: string, automationId?: string, isPassword?: boolean}|undefined} input.element
 * @param {{name?: string, className?: string, processId?: number}|undefined} input.window
 * @param {string[]} [input.allowedApps]
 * @returns {{verdict: 'allow'|'needs-approval'|'deny', reason?: string, approvalSubject?: string}}
 */
export function evaluateGuard({ action, element, window, allowedApps }) {
  const scope = checkAppScope(allowedApps ?? [], window);
  if (!scope.allowed) return { verdict: 'deny', reason: scope.reason };

  // Password fields never receive automated text or set_value.
  if ((action.type === 'type_text' || action.type === 'set_value_ref') && isSecureField(element)) {
    return {
      verdict: 'deny',
      reason: `target "${element?.name ?? element?.automationId ?? action.targetRef}" looks like a credential field; refusing to type into it`,
    };
  }

  // Dangerous labels require explicit approval, not a silent block.
  const label = element?.name ?? '';
  if (isDangerousLabel(label)) {
    return {
      verdict: 'needs-approval',
      reason: `target label "${label}" matches a destructive or consequential pattern`,
      approvalSubject: label,
    };
  }

  return { verdict: 'allow' };
}
