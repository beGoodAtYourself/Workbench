export interface Fault { code: string; message: string }
export interface Note { path: string; text: string; version: string; size: number }
export interface Entry { path: string; name: string; kind: 'folder' | 'note' }
export type Mode = 'edit' | 'preview';
export interface PaneRecord { path: string; mode: Mode; cursor: number; scroll: number }
export interface Snapshot { module: 'notes' | 'clipboard'; panes: PaneRecord[]; expanded: string[] }
export interface Settings { root: string | null; shortcut: string; floating: boolean; floatX: number; floatY: number; session: Snapshot; startupError?: string }
export interface Clipboard { status: 'text' | 'empty' | 'unsupported'; text: string; truncated: boolean }
export interface Repository {
  settings(): Promise<Settings>;
  workspace(root: string): Promise<Settings>;
  list(parent: string): Promise<Entry[]>;
  read(path: string, allowLarge?: boolean): Promise<Note>;
  save(path: string, text: string, version: string): Promise<string>;
  create(parent: string, name: string, folder: boolean): Promise<string>;
  rename(path: string, name: string): Promise<string>;
  recycle(path: string): Promise<void>;
  image(path: string): Promise<string>;
  configure(shortcut: string, floating: boolean): Promise<Settings>;
  snapshot(value: Snapshot): Promise<void>;
  clipboard(): Promise<Clipboard>;
  watchClipboard(enabled: boolean): Promise<void>;
  external(url: string): Promise<void>;
  hide(): Promise<void>;
  exit(): Promise<void>;
}
export function asFault(error: unknown): Fault {
  if (error && typeof error === 'object' && 'message' in error)
    return { code: 'code' in error ? String(error.code) : 'error', message: String(error.message) };
  return {code:'error',message:String(error)};
}
