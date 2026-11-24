export interface Fault { code: string; message: string }
export interface Note { path: string; text: string; version: string; size: number }
export interface Entry { path: string; name: string; kind: 'folder' | 'note' }
export type Mode = 'edit' | 'preview';
export interface PaneRecord { path: string; mode: Mode; cursor: number; scroll: number }
export interface Snapshot { module: 'notes' | 'text' | 'clipboard'; panes: PaneRecord[]; expanded: string[] }
export interface Settings { root: string | null; shortcut: string; floating: boolean; floatX: number; floatY: number; session: Snapshot; startupError?: string }
export interface AutostartStatus { state: 'enabled' | 'disabled' | 'other' | 'error' | 'unavailable'; target: string | null; revision: string | null; message: string | null }
export interface AutostartChange { enabled: boolean; revision: string }
export interface Clipboard { status: 'text' | 'empty' | 'unsupported'; text: string; truncated: boolean }
export interface FolderOrder { root: string; revision: string; parents: Record<string, string[]>; warning?: string }
export interface FolderAction { root: string; revision: string; source: string; parent: string; anchor?: string; placement: 'before' | 'after' | 'inside' | 'reset' }
export interface FolderResult { path: string; moved: boolean; order: FolderOrder; warning?: string }
export interface Repository {
  settings(): Promise<Settings>;
  autostart(): Promise<AutostartStatus>;
  workspace(root: string): Promise<Settings>;
  list(parent: string): Promise<Entry[]>;
  folderOrder(): Promise<FolderOrder>;
  arrangeFolder(action: FolderAction): Promise<FolderResult>;
  retryFolderOrder(root: string): Promise<FolderOrder>;
  read(path: string, allowLarge?: boolean): Promise<Note>;
  save(path: string, text: string, version: string): Promise<string>;
  create(parent: string, name: string, folder: boolean): Promise<string>;
  importMarkdown(parent: string): Promise<string | null>;
  rename(path: string, name: string): Promise<string>;
  recycle(path: string): Promise<void>;
  image(path: string): Promise<string>;
  configure(shortcut: string, floating: boolean, autostart?: AutostartChange): Promise<Settings>;
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
