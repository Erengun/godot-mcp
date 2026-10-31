/**
 * Streaming parser for Godot's console error format.
 *
 * Godot prints engine/script problems as a header line followed by indented
 * detail lines, e.g.
 *
 *   SCRIPT ERROR: Invalid call. Nonexistent function 'foo' in base 'Node'.
 *             at: _ready (res://main.gd:5)
 *             GDScript backtrace (most recent call first):
 *                 [0] _ready (res://main.gd:5)
 *
 * This is log-format parsing (a stable engine output contract), not GDScript
 * parsing. Headless worker operations do not rely on it — they receive
 * structured records from a `Logger` subclass — but runtime processes
 * (games, exports, imports) only expose their console.
 */
import type { EngineDiagnostic } from '../errors.ts';

const HEADERS: Array<[RegExp, EngineDiagnostic['severity']]> = [
  [/^SCRIPT ERROR:\s*(.*)$/, 'script_error'],
  [/^SHADER ERROR:\s*(.*)$/, 'shader_error'],
  [/^USER SCRIPT ERROR:\s*(.*)$/, 'script_error'],
  [/^USER ERROR:\s*(.*)$/, 'error'],
  [/^USER WARNING:\s*(.*)$/, 'warning'],
  [/^ERROR:\s*(.*)$/, 'error'],
  [/^WARNING:\s*(.*)$/, 'warning'],
];

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** Lines Godot prints on every run that are not actionable for the agent. */
const NOISE = [
  /^WARNING: Case mismatch opening requested file '.*\/logs\/godot\.log'/,
  /^WARNING: \d+ RIDs of type ".*" were leaked\.$/,
  /^WARNING: ObjectDB instances leaked at exit/,
  /^WARNING: \d+ ObjectDB instances were leaked at exit/,
  /^ERROR: \d+ resources still in use at exit/,
];

export function isNoise(d: EngineDiagnostic): boolean {
  const header = `${d.severity === 'warning' ? 'WARNING' : 'ERROR'}: ${d.message}`;
  return NOISE.some((re) => re.test(header));
}

export class DiagnosticParser {
  private current: EngineDiagnostic | null = null;
  private inBacktrace = false;
  readonly diagnostics: EngineDiagnostic[] = [];
  private readonly limit: number;
  private overflow = 0;

  constructor(limit = 500) {
    this.limit = limit;
  }

  get overflowCount(): number {
    return this.overflow;
  }

  pushLine(rawLine: string): EngineDiagnostic | null {
    const line = stripAnsi(rawLine).replace(/\r$/, '');
    for (const [re, severity] of HEADERS) {
      const m = re.exec(line);
      if (m) {
        const finished = this.flush();
        this.current = { severity, message: (m[1] ?? '').trim() };
        this.inBacktrace = false;
        return finished;
      }
    }
    if (!this.current) return null;
    const trimmed = line.trim();
    if (trimmed === '') return null;
    if (!/^\s/.test(line)) {
      // A non-indented, non-header line ends the current block.
      return this.flush();
    }
    const at = /^at:\s*(.*?)\s*\((.*):(\d+)\)\s*$/.exec(trimmed);
    if (at && this.current.file === undefined) {
      this.current.function = at[1];
      this.current.file = at[2];
      this.current.line = Number(at[3]);
      return null;
    }
    if (/^GDScript backtrace/.test(trimmed) || /^C# backtrace/.test(trimmed)) {
      this.inBacktrace = true;
      this.current.stack = [];
      return null;
    }
    if (this.inBacktrace && /^\[\d+\]/.test(trimmed)) {
      this.current.stack?.push(trimmed);
      // Prefer the top script frame as the location for script errors.
      const frame = /^\[0\]\s*(.*?)\s*\((res:\/\/.*):(\d+)\)/.exec(trimmed);
      if (frame && (!this.current.file || !this.current.file.startsWith('res://'))) {
        this.current.function = frame[1];
        this.current.file = frame[2];
        this.current.line = Number(frame[3]);
      }
      return null;
    }
    return null;
  }

  /** Close the pending block (call at end of stream). */
  flush(): EngineDiagnostic | null {
    const d = this.current;
    this.current = null;
    this.inBacktrace = false;
    if (!d) return null;
    if (isNoise(d)) return null;
    if (this.diagnostics.length < this.limit) this.diagnostics.push(d);
    else this.overflow++;
    return d;
  }
}

export function parseDiagnostics(text: string, limit = 500): EngineDiagnostic[] {
  const p = new DiagnosticParser(limit);
  for (const line of text.split('\n')) p.pushLine(line);
  p.flush();
  return p.diagnostics;
}

export function summarizeDiagnostics(list: EngineDiagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of list) {
    if (d.severity === 'warning') warnings++;
    else if (d.severity !== 'info') errors++;
  }
  return { errors, warnings };
}
