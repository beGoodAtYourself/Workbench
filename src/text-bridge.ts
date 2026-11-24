import type {TextRepository} from './text-types';
export async function textRepository():Promise<TextRepository>{
 if(!('__TAURI_INTERNALS__' in window))return (await import('./text-demo')).textDemoRepository();
 const {invoke}=await import('@tauri-apps/api/core');
 return {
  openDropped: token => invoke('text_open_dropped', {token}),
  open:encoding=>invoke('text_open',encoding?{encoding}:undefined),read:(id,encoding)=>invoke('text_read',encoding?{id,encoding}:{id}),probe:(id,knownVersion)=>invoke('text_read',{id,knownVersion}),save:value=>invoke('text_save',{value}),saveAs:value=>invoke('text_save_as',{value}),
  restore:()=>invoke('text_restore'),recover:id=>invoke('text_recover',{id}),checkpoint:value=>invoke('text_checkpoint',{value}),invalidate:generation=>invoke('text_invalidate',{generation}),
  close:id=>invoke('text_close',{id}),notes:paths=>invoke('text_notes',{paths}),noteOwner:path=>invoke('text_note_owner',{path})
 };
}
