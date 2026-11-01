/**
 * Policy check for unsaved GDScript source passed to godot_script_validate.
 *
 * The worker only analyses that source (it is never compiled, so none of its
 * code runs), but Godot's analyzer still loads two kinds of caller-chosen
 * paths while analysing: `preload("...")` (a scene or resource loaded this way
 * runs its built-in scripts and `_init()`) and `extends "..."`. Without a
 * check, those paths could point anywhere on the machine, including a
 * Windows network share, and the error text would reveal whether a file
 * exists. Unsaved source may therefore only preload/extend literal res://
 * paths, which the caller then confines to the project like any other path.
 *
 * The scan works on raw text rather than a tokenizer so it can only
 * over-approximate: every `preload`/`extends` keyword Godot can see is also a
 * whole word in the raw text. Occurrences inside comments or strings are
 * checked too; anything that is not a plain literal res:// path is refused.
 */

export interface SourcePathFinding {
  line: number;
  keyword: 'preload' | 'extends';
  /** The res:// path when the argument is an acceptable literal. */
  path?: string;
  /** Set when the occurrence is refused outright. */
  problem?: string;
}

const IDENT_CHAR = /[\p{L}\p{N}_]/u;
// Whitespace as Godot sees it between tokens, including `\` line continuations.
const WS = '(?:\\s|\\\\\\r?\\n)*';
// A plain single- or double-quoted literal (not triple-quoted, raw, StringName
// or NodePath), with no escapes, quotes or line breaks inside.
const LITERAL = /^(["'])(?!\1)([^"'\\\r\n]*)\1/;

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function isWordAt(source: string, index: number, word: string): boolean {
  if (!source.startsWith(word, index)) return false;
  const before = index > 0 ? source[index - 1]! : '';
  const after = source[index + word.length] ?? '';
  return !IDENT_CHAR.test(before) && !IDENT_CHAR.test(after);
}

function literalResPath(text: string): { path?: string; problem?: string } {
  const m = LITERAL.exec(text);
  if (!m) return { problem: 'the path must be a plain quoted string literal' };
  const path = m[2]!;
  if (!path.startsWith('res://')) return { problem: `only res:// paths are allowed, got "${path}"` };
  return { path };
}

export function scanSourcePaths(source: string): SourcePathFinding[] {
  const out: SourcePathFinding[] = [];
  for (const keyword of ['preload', 'extends'] as const) {
    let from = 0;
    for (;;) {
      const i = source.indexOf(keyword, from);
      if (i < 0) break;
      from = i + keyword.length;
      if (!isWordAt(source, i, keyword)) continue;
      const rest = source.slice(from);
      const line = lineAt(source, i);
      if (keyword === 'preload') {
        const call = new RegExp(`^${WS}\\(${WS}`).exec(rest);
        if (!call) {
          out.push({ line, keyword, problem: 'preload must be called with a single literal res:// path' });
          continue;
        }
        const arg = rest.slice(call[0].length);
        const lit = literalResPath(arg);
        const lenMatch = LITERAL.exec(arg);
        if (lit.problem || !lenMatch || !new RegExp(`^${WS}\\)`).test(arg.slice(lenMatch[0].length))) {
          out.push({ line, keyword, problem: lit.problem ?? 'preload must be called with a single literal res:// path' });
          continue;
        }
        out.push({ line, keyword, path: lit.path });
      } else {
        // Fail closed: `extends` must be followed by a class name or a literal
        // res:// path. Anything else (a comment after a `\` continuation, which
        // Godot skips, an unusual string prefix, ...) is refused.
        const lead = new RegExp(`^${WS}`).exec(rest)![0];
        const next = rest.slice(lead.length);
        const quoted = /^(r|&|\^)?["']/.test(next);
        if (!quoted && /^[\p{L}_]/u.test(next)) continue;
        const lit = quoted ? literalResPath(next) : { problem: 'extends must be followed by a class name or a literal res:// path' };
        if (lit.problem) {
          out.push({ line, keyword, problem: lit.problem });
          continue;
        }
        out.push({ line, keyword, path: lit.path });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
