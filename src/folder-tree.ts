import {key, parent, belongs} from './paths';
import type {Entry, FolderAction} from './types';

// Rust compares lowercase UTF-8 strings by Unicode scalar value, independent of locale.
function compareNames(a: string, b: string): number {
  const left = Array.from(a.toLowerCase(), c => c.codePointAt(0)!);
  const right = Array.from(b.toLowerCase(), c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

/** Merge saved item order while preserving separate folder and Markdown-note groups. */
export function applyFolderOrder(entries: readonly Entry[], order?: readonly string[]): Entry[] {
  const ranks = new Map<string, number>();
  for (const path of order ?? []) if (!ranks.has(key(path))) ranks.set(key(path), ranks.size);
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    const left = ranks.get(key(a.path)), right = ranks.get(key(b.path));
    if (left !== undefined || right !== undefined) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      if (left !== right) return left - right;
    }
    return compareNames(a.name, b.name);
  });
}

function validRelative(path: string): boolean {
  return path === '' || (!/[\\:*?"<>|\u0000-\u001f]/.test(path) &&
    path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part)));
}

export type FolderDropIntent = Omit<FolderAction, 'root' | 'revision'>;

/** UI intent only: the caller filters entry kinds; the repository revalidates them and all paths. */
export function folderDropIntent(source: string, target: string, position: 'before' | 'after' | 'inside'): FolderDropIntent | null {
  if (!source || !validRelative(source) || !validRelative(target)) return null;
  if (key(source) === key(target) || belongs(target, source)) return null;
  if (!target && position !== 'inside') return null;
  const destination = position === 'inside' ? target : parent(target);
  if (key(destination) === key(source) || belongs(destination, source)) return null;
  if (position === 'inside' && key(parent(source)) === key(destination)) return null;
  return {source, parent: destination, placement: position, ...(position === 'inside' ? {} : {anchor: target})};
}
