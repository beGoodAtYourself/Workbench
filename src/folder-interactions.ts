import type {Entry, FolderAction} from './types';
import {folderDropIntent} from './folder-tree';
import {basename, belongs, key, parent} from './paths';
import {escape} from './markdown';

export type FolderIntent = Omit<FolderAction, 'root' | 'revision'>;

export function treeDrag(options: {
 tree: HTMLElement; workspace: HTMLElement; entryAt(target: EventTarget | null): Entry | undefined;
 root(): string | null; busy(): boolean; render(): void; expanded(path: string): boolean;
 expand(path: string, valid: () => boolean): Promise<void>; drop(intent: FolderIntent): void;
 note(path: string, x: number, y: number): void; notify(message: string): void;
}) {
 const {tree, workspace} = options;
 const ghost = document.createElement('div'); ghost.className = 'drag-ghost'; ghost.hidden = true;
 document.body.append(ghost);
 let drag: {entry: Entry; root: string | null; pointer: number; x: number; y: number; startX: number; startY: number; moved: boolean} | null = null;
 let frame = 0, hoverTimer: ReturnType<typeof setTimeout> | undefined, hoverPath = '', suppressClick = false;
 let intent: FolderIntent | null = null;
 function clearPaint() { document.querySelectorAll('[data-folder-drop]').forEach(node => node.removeAttribute('data-folder-drop')); }
 function paint() {
  clearPaint(); intent = null;
  if (!drag?.moved) return;
  const target = document.elementFromPoint(drag.x, drag.y);
  let element: HTMLElement | null = null, targetPath = '', position: 'before'|'after'|'inside' = 'inside';
  if (target && workspace.contains(target)) element = workspace;
  else if (target && tree.contains(target)) {
   const entry = options.entryAt(target);
   if (entry && (entry.kind === 'folder' || drag.entry.kind === 'note')) {
    element = target.closest<HTMLElement>('[data-row]'); targetPath = entry.path;
    if (element) {
     const rect = element.getBoundingClientRect(), ratio = (drag.y - rect.top) / rect.height;
     position = entry.kind === 'note' ? (ratio < .5 ? 'before' : 'after') : drag.entry.kind === 'note' ? 'inside' : ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside';
    }
   }
  }
  if (element) intent = folderDropIntent(drag.entry.path, targetPath, position);
  if (intent && element) {
   element.dataset.folderDrop = position;
   const moving = key(parent(drag.entry.path)) !== key(intent.parent);
   ghost.textContent = (moving ? '移动到 ' + (intent.parent || '笔记根目录') : '调整同级顺序') + (position === 'inside' ? '' : ' · ' + basename(targetPath) + (position === 'before' ? ' 之前' : ' 之后'));
  } else ghost.textContent = basename(drag.entry.path) + (drag.entry.kind === 'note' && target?.closest('.note-content') ? ' · 拖入编辑区插入链接' : ' · 此处不能放置');
  const hover = intent && position === 'inside' && targetPath && !options.expanded(targetPath) ? targetPath : '';
  if (hover !== hoverPath) {
   clearTimeout(hoverTimer); hoverPath = hover;
   if (hover) { const current = drag; hoverTimer = setTimeout(() => {
    const valid = () => drag === current && hoverPath === hover && options.root() === current.root;
    if (valid()) void options.expand(hover, valid).then(() => { if (valid()) paint(); }).catch(error => { if (valid()) options.notify(String(error?.message || error)); });
   }, 700); }
  }
 }
 function tick() {
  frame = 0; if (!drag?.moved) return;
  if (options.root() !== drag.root || options.busy()) { cancel(); return; }
  const rect = tree.getBoundingClientRect();
  if (drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom) {
   const amount = drag.y < rect.top + 32 ? -9 : drag.y > rect.bottom - 32 ? 9 : 0;
   if (amount) { const before = tree.scrollTop; tree.scrollTop += amount; if (tree.scrollTop !== before) options.render(); }
  }
  paint(); frame = requestAnimationFrame(tick);
 }
 function finish(cancelled: boolean) {
  if (!drag) return;
  if (!cancelled && drag.moved) paint();
  const current = drag, action = intent;
  drag = null; intent = null; cancelAnimationFrame(frame); frame = 0; clearTimeout(hoverTimer); hoverPath = ''; clearPaint(); ghost.hidden = true;
  if (tree.hasPointerCapture(current.pointer)) tree.releasePointerCapture(current.pointer);
  if (current.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
  if (!current.moved || cancelled || options.root() !== current.root) return;
  if (action) options.drop(action);
  else if (current.entry.kind === 'note') options.note(current.entry.path, current.x, current.y);
  else { const target = document.elementFromPoint(current.x,current.y); options.notify(target?.closest('.note-content') ? '文件夹不能插入链接，请拖动一篇 Markdown 笔记。' : '此处不能放置文件夹，请选择插入线、目标文件夹或笔记库名称。'); }
 }
 function cancel() { finish(true); }
 tree.addEventListener('pointerdown', event => {
  if (drag || event.button !== 0 || options.busy() || document.querySelector('dialog[open]')) return;
  const entry = options.entryAt(event.target); if (!entry) return;
  drag = {entry, root: options.root(), pointer: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false};
 });
 window.addEventListener('pointermove', event => {
  if (!drag || event.pointerId !== drag.pointer) return;
  drag.x = event.clientX; drag.y = event.clientY;
  if (!drag.moved && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 5) {
   drag.moved = true; tree.setPointerCapture(event.pointerId); ghost.hidden = false; frame = requestAnimationFrame(tick);
  }
  if (drag.moved) { event.preventDefault(); ghost.style.left = Math.min(event.clientX + 14, window.innerWidth - Math.min(320,ghost.offsetWidth) - 8) + 'px'; ghost.style.top = Math.min(event.clientY + 14, window.innerHeight - 50) + 'px'; paint(); }
 });
 window.addEventListener('pointerup', event => { if (drag?.pointer === event.pointerId) finish(false); });
 window.addEventListener('pointercancel', event => { if (drag?.pointer === event.pointerId) cancel(); });
 tree.addEventListener('lostpointercapture', () => { if (drag?.moved) cancel(); });
 window.addEventListener('blur', cancel);
 window.addEventListener('keydown', event => { if (event.key === 'Escape' && drag) { event.preventDefault(); cancel(); } });
 window.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }, true);
 document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
 return {cancel, paint, get active() { return !!drag?.moved; }};
}

/** A level at a time, so a destination picker never walks the entire workspace. */
export async function chooseFolderDestination(source: string, list: (path: string) => Promise<Entry[]>, kind: Entry['kind'] = 'folder'): Promise<string | null> {
 const dialog = document.createElement('dialog'); dialog.className = 'modal folder-destination';
 dialog.setAttribute('aria-labelledby','folder-destination-title');
 dialog.innerHTML = '<h2 id="folder-destination-title">移动' + (kind === 'note' ? '笔记' : '文件夹') + '</h2><p>选择“' + escape(basename(source)) + '”的新位置。</p><nav class="folder-destination-nav" aria-label="目标目录导航"><button type="button" data-root class="secondary">笔记根目录</button><button type="button" data-up class="secondary">返回上级</button></nav><p class="folder-destination-path"></p><div class="folder-destination-list" aria-label="可进入的文件夹"></div><p class="form-error" role="status"></p><div class="modal-actions"><button data-cancel class="secondary">取消</button><button data-confirm class="primary">移到此目录</button></div>';
 document.body.append(dialog); dialog.showModal();
 const host = dialog.querySelector<HTMLElement>('.folder-destination-list')!, pathLabel = dialog.querySelector<HTMLElement>('.folder-destination-path')!, error = dialog.querySelector<HTMLElement>('.form-error')!;
 const confirm = dialog.querySelector<HTMLButtonElement>('[data-confirm]')!, up = dialog.querySelector<HTMLButtonElement>('[data-up]')!;
 let current = parent(source), generation = 0, result: string | null = null;
 async function load(path: string) {
  const token = ++generation; current = path; confirm.disabled = true; up.disabled = !path; error.textContent = ''; pathLabel.textContent = path || '笔记根目录'; host.textContent = '正在读取文件夹…';
  try {
   const entries = await list(path); if (token !== generation || !dialog.open) return;
   host.replaceChildren();
   for (const entry of entries.filter(entry => entry.kind === 'folder')) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'destination-folder'; button.textContent = entry.name; button.title = entry.path;
    button.disabled = belongs(entry.path,source); button.setAttribute('aria-label','进入文件夹 ' + entry.name);
    button.onclick = () => { void load(entry.path); }; host.append(button);
   }
   if (!host.childElementCount) host.textContent = '此目录没有子文件夹。';
   confirm.disabled = key(path) === key(parent(source)) || belongs(path,source);
  } catch (e) { if (token === generation && dialog.open) { host.replaceChildren(); error.textContent = String((e as Error).message || e); const retry = document.createElement('button'); retry.textContent = '重新读取'; retry.className = 'secondary'; retry.onclick = () => { void load(path); }; host.append(retry); } }
 }
 dialog.querySelector<HTMLButtonElement>('[data-root]')!.onclick = () => { void load(''); };
 up.onclick = () => { void load(parent(current)); };
 dialog.querySelector<HTMLButtonElement>('[data-cancel]')!.onclick = () => dialog.close();
 confirm.onclick = () => { if (!confirm.disabled) { result = current; dialog.close(); } };
 void load(current);
 return new Promise(resolve => dialog.addEventListener('close', () => { generation++; dialog.remove(); resolve(result); }, {once:true}));
}
