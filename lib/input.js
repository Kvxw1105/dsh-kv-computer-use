/**
 * Foreground input layer: unicode text, hotkeys, coordinate click, wheel.
 *
 * The UIA driver only exposes semantic patterns (invoke/set_value), which is the
 * safe path but cannot reach custom-drawn controls. This module adds the missing
 * input primitives. Everything here is classified as `focus` or `coordinate`
 * input, so `requireBackground: true` refuses it before it can touch the shared
 * cursor.
 *
 * Implementation: a small C# helper compiled once with the in-box .NET Framework
 * csc.exe and cached as a DLL; each call runs one short PowerShell that loads the
 * cached assembly. No node-gyp, no native ABI coupling to Electron.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { InputDaemon } from './input-daemon.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const POWERSHELL_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
];

const HELPER_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class KvCuInput
{
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(4)] public MOUSEINPUT mi;
        [FieldOffset(4)] public KEYBDINPUT ki;
    }

    private const uint INPUT_KEYBOARD = 1;
    private const uint INPUT_MOUSE = 0;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint WHEEL_DELTA = 120;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    public static long ForegroundHandle()
    {
        return GetForegroundWindow().ToInt64();
    }

    public static int TypeText(string text)
    {
        int sent = 0;
        foreach (char ch in text)
        {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.ki.wVk = 0;
            down.ki.wScan = ch;
            down.ki.dwFlags = KEYEVENTF_UNICODE;

            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.ki.wVk = 0;
            up.ki.wScan = ch;
            up.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

            INPUT[] batch = new INPUT[] { down, up };
            if (SendInput(2, batch, Marshal.SizeOf(typeof(INPUT))) == 2) sent++;
            Thread.Sleep(2);
        }
        return sent;
    }

    public static int PressVirtualKey(int virtualKey)
    {
        INPUT down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.ki.wVk = (ushort)virtualKey;
        down.ki.dwFlags = 0;

        INPUT up = new INPUT();
        up.type = INPUT_KEYBOARD;
        up.ki.wVk = (ushort)virtualKey;
        up.ki.dwFlags = KEYEVENTF_KEYUP;

        INPUT[] batch = new INPUT[] { down, up };
        return (int)SendInput(2, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    // Separate down/up so a real chord can be built: hold ctrl, tap s, release
    // ctrl. PressVirtualKey alone sends two independent taps and chords do nothing.
    public static int KeyDown(int virtualKey)
    {
        INPUT down = new INPUT();
        down.type = INPUT_KEYBOARD;
        down.ki.wVk = (ushort)virtualKey;
        down.ki.dwFlags = 0;
        INPUT[] batch = new INPUT[] { down };
        return (int)SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int KeyUp(int virtualKey)
    {
        INPUT up = new INPUT();
        up.type = INPUT_KEYBOARD;
        up.ki.wVk = (ushort)virtualKey;
        up.ki.dwFlags = KEYEVENTF_KEYUP;
        INPUT[] batch = new INPUT[] { up };
        return (int)SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    public static bool ClickPoint(int x, int y, string button)
    {
        if (!SetCursorPos(x, y)) return false;
        Thread.Sleep(30);
        uint down = MOUSEEVENTF_LEFTDOWN;
        uint up = MOUSEEVENTF_LEFTUP;
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }

        INPUT d = new INPUT();
        d.type = INPUT_MOUSE;
        d.mi.dwFlags = down;
        INPUT u = new INPUT();
        u.type = INPUT_MOUSE;
        u.mi.dwFlags = up;
        INPUT[] batch = new INPUT[] { d, u };
        return SendInput(2, batch, Marshal.SizeOf(typeof(INPUT))) == 2;
    }

    public static int Scroll(int notches, bool horizontal)
    {
        INPUT wheel = new INPUT();
        wheel.type = INPUT_MOUSE;
        wheel.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
        wheel.mi.mouseData = unchecked((uint)(notches * WHEEL_DELTA));
        INPUT[] batch = new INPUT[] { wheel };
        return (int)SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
    }
}
`;

/** Virtual-key codes for named hotkey parts. */
const VIRTUAL_KEYS = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, printscreen: 0x2c,
};

export class InputLayer {
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.cacheDir = options.cacheDir ?? join(homedir(), '.cache', 'dsh-kv-computer-use');
    this.dllPath = join(this.cacheDir, 'KvCuInput.dll');
    this.sourcePath = join(this.cacheDir, 'KvCuInput.cs');
    this.compiled = existsSync(this.dllPath);
    this.compileFailure = undefined;
    this.daemon = options.daemon === false ? undefined : new InputDaemon({ log: this.log, dllPath: this.dllPath });
  }

  get available() {
    const csc = CSC_CANDIDATES.find((p) => existsSync(p));
    const ps = POWERSHELL_CANDIDATES.find((p) => existsSync(p));
    return Boolean(csc && ps);
  }

  get status() {
    return {
      available: this.available,
      compiled: this.compiled,
      dllPath: this.dllPath,
      compileFailure: this.compileFailure,
      daemon: this.daemon?.status,
    };
  }

  async ensureCompiled() {
    if (this.compiled) return;
    if (this.compileFailure) throw new Error(`input helper compilation previously failed: ${this.compileFailure}`);
    const csc = CSC_CANDIDATES.find((p) => existsSync(p));
    if (!csc) throw new Error('csc.exe (.NET Framework) not found; text input is unavailable');

    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.sourcePath, HELPER_SOURCE, 'utf8');
    await new Promise((resolve, reject) => {
      execFile(csc, ['/nologo', '/target:library', `/out:${this.dllPath}`, this.sourcePath], { timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          // csc writes compiler diagnostics to stdout, not stderr.
          const diagnostic = [String(stdout ?? '').trim(), String(stderr ?? '').trim()].filter((s) => s !== '').join(' | ').slice(0, 600);
          this.compileFailure = diagnostic || error.message;
          reject(new Error(`csc failed: ${this.compileFailure}`));
          return;
        }
        this.compiled = true;
        this.log('input_helper_compiled', { dllPath: this.dllPath });
        resolve();
      });
    });
  }

  async run(script) {
    await this.ensureCompiled();
    const ps = POWERSHELL_CANDIDATES.find((p) => existsSync(p));
    if (!ps) throw new Error('PowerShell not found');
    const command = `Add-Type -Path '${this.dllPath}'; ${script}`;
    return await new Promise((resolve, reject) => {
      execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`input helper failed: ${String(stderr || error.message).slice(0, 400)}`));
          return;
        }
        resolve(String(stdout).trim());
      });
    });
  }

  /**
   * Prefer the resident daemon. Fall back to a one-shot process only when the
   * daemon cannot be started at all: a mid-flight timeout must NOT be retried,
   * otherwise a keystroke batch could be delivered twice.
   */
  async daemonReady() {
    if (!this.daemon) return false;
    // The helper DLL is compiled lazily; without this the very first call would
    // report the daemon unavailable and pay the one-shot cost.
    try {
      await this.ensureCompiled();
    } catch {
      return false;
    }
    if (!this.daemon.available) return false;
    try {
      await this.daemon.start();
      return this.daemon.ready === true;
    } catch (error) {
      this.log('input_daemon_unavailable', { message: String(error?.message ?? error) });
      return false;
    }
  }

  async foregroundHandle() {
    if (await this.daemonReady()) {
      try {
        return await this.daemon.foregroundHandle();
      } catch {
        // fall through to the one-shot read; it is side-effect free
      }
    }
    const out = await this.run('[KvCuInput]::ForegroundHandle()');
    const value = Number.parseInt(out, 10);
    return Number.isFinite(value) ? value : undefined;
  }

  /** @param {string} text */
  async typeText(text) {
    if (await this.daemonReady()) {
      return await this.daemon.typeText(text);
    }
    const encoded = Buffer.from(text, 'utf16le').toString('base64');
    const script = `$bytes=[Convert]::FromBase64String('${encoded}'); $text=[Text.Encoding]::Unicode.GetString($bytes); [KvCuInput]::TypeText($text)`;
    const out = await this.run(script);
    return { charactersSent: Number.parseInt(out, 10) || 0, via: 'one-shot' };
  }

  /** @param {string[]} keys e.g. ["ctrl","shift","s"] */
  async pressHotkey(keys) {
    const codes = [];
    for (const raw of keys) {
      const key = String(raw).toLowerCase();
      if (VIRTUAL_KEYS[key] !== undefined) {
        codes.push(VIRTUAL_KEYS[key]);
      } else if (key.length === 1) {
        codes.push(key.toUpperCase().charCodeAt(0));
      } else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) {
        codes.push(0x6f + Number.parseInt(key.slice(1), 10));
      } else {
        throw new Error(`unsupported key: ${raw}`);
      }
    }
    if (codes.length === 0) throw new Error('hotkey requires at least one key');

    if (await this.daemonReady()) {
      const result = await this.daemon.pressChord(codes);
      return { keys, ...result };
    }

    // One-shot fallback still has to build a real chord: hold modifiers, tap the
    // final key, release in reverse order.
    const modifiers = codes.slice(0, -1);
    const last = codes[codes.length - 1];
    const statements = [];
    for (const code of modifiers) statements.push(`[void][KvCuInput]::KeyDown(${code})`);
    statements.push(`[void][KvCuInput]::KeyDown(${last})`, `[void][KvCuInput]::KeyUp(${last})`);
    for (const code of [...modifiers].reverse()) statements.push(`[void][KvCuInput]::KeyUp(${code})`);
    await this.run(statements.join('; '));
    return { keys, virtualKeys: codes, via: 'one-shot' };
  }

  /** @param {number} x @param {number} y @param {'left'|'right'|'middle'} [button] */
  async clickPoint(x, y, button = 'left') {
    if (await this.daemonReady()) {
      return await this.daemon.clickPoint(x, y, button);
    }
    const out = await this.run(`[KvCuInput]::ClickPoint(${Math.round(x)}, ${Math.round(y)}, '${button}')`);
    return { clicked: out.toLowerCase() === 'true', x, y, button, via: 'one-shot' };
  }

  /** @param {number} notches positive = up/right */
  async scroll(notches, horizontal = false) {
    if (await this.daemonReady()) {
      return await this.daemon.scroll(notches, horizontal);
    }
    await this.run(`[KvCuInput]::Scroll(${Math.round(notches)}, $${horizontal ? 'true' : 'false'})`);
    return { notches, horizontal, via: 'one-shot' };
  }
}
