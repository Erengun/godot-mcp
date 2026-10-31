import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** sha256 of a file's bytes, or null when the file does not exist. */
export function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}
