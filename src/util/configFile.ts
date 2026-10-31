/**
 * Minimal reader for Godot's ConfigFile text format (project.godot,
 * *.import, export_presets.cfg). Values are returned as raw Godot literal
 * strings, except plain quoted strings, booleans and numbers which are
 * unwrapped. Multi-line values ({...}, [...], (...)) are joined. This reader
 * never writes — all writes go through Godot itself.
 */
export type ConfigSections = Map<string, Map<string, string | number | boolean>>;

function unwrap(raw: string): string | number | boolean {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v)) return Number(v);
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

function depth(s: string): number {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[' || ch === '(') d++;
    else if (ch === '}' || ch === ']' || ch === ')') d--;
  }
  return d;
}

export function parseConfig(text: string): ConfigSections {
  const sections: ConfigSections = new Map();
  let current = '';
  sections.set(current, new Map());
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sec) {
      current = sec[1]!;
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    let d = depth(value);
    while (d > 0 && i + 1 < lines.length) {
      i++;
      value += '\n' + lines[i];
      d = depth(value);
    }
    sections.get(current)!.set(key, unwrap(value));
  }
  return sections;
}

export function getValue(cfg: ConfigSections, section: string, key: string): string | number | boolean | undefined {
  return cfg.get(section)?.get(key);
}
