/** 使用指针事件排序标签，兼容 Windows 原生文件拖放。 */
export function textTabDrag(host: HTMLElement, move: (id: string, target: string) => void) {
 let pending: {id: string; pointer: number; x: number; y: number; dragging: boolean} | undefined;
 let suppressClick = false;

 const cancel = () => {
  pending = undefined;
  host.classList.remove('text-tabs-dragging');
 };
 const down = (event: PointerEvent) => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>('.text-tab');
  if (event.button !== 0 || !tab || (event.target as HTMLElement).closest('.text-tab-close')) {
   return;
  }
  suppressClick = false;
  pending = {id: tab.dataset.document!, pointer: event.pointerId, x: event.clientX, y: event.clientY, dragging: false};
 };
 const motion = (event: PointerEvent) => {
  if (!pending || event.pointerId !== pending.pointer) {
   return;
  }
  if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) >= 5) {
   pending.dragging = true;
   host.classList.add('text-tabs-dragging');
  }
 };
 const up = (event: PointerEvent) => {
  if (!pending || event.pointerId !== pending.pointer) {
   return;
  }
  const source = pending;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.text-tab');
  cancel();
  if (source.dragging) {
   suppressClick = true;
   if (target && host.contains(target) && target.dataset.document !== source.id) {
    move(source.id, target.dataset.document!);
   }
  }
 };
 const click = (event: MouseEvent) => {
  if (suppressClick) {
   event.preventDefault();
   event.stopImmediatePropagation();
   suppressClick = false;
  }
 };
 host.addEventListener('pointerdown', down);
 host.addEventListener('click', click, true);
 window.addEventListener('pointermove', motion);
 window.addEventListener('pointerup', up);
 window.addEventListener('pointercancel', cancel);
 window.addEventListener('blur', cancel);
 return () => {
  cancel();
  host.removeEventListener('pointerdown', down);
  host.removeEventListener('click', click, true);
  window.removeEventListener('pointermove', motion);
  window.removeEventListener('pointerup', up);
  window.removeEventListener('pointercancel', cancel);
  window.removeEventListener('blur', cancel);
 };
}
