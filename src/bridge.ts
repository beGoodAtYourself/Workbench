import type { Repository, Settings, Snapshot, AutostartStatus } from './types';
export const desktop = '__TAURI_INTERNALS__' in window;
export async function repository(): Promise<Repository> {
 if(!desktop)return (await import('./demo')).demoRepository();
 const {invoke}=await import('@tauri-apps/api/core');
 return {
  settings:()=>invoke<Settings>('get_settings'),
  autostart:()=>invoke<AutostartStatus>('get_autostart_status'),
  workspace:root=>invoke<Settings>('set_workspace',{root}),
  list:parent=>invoke('list_entries',{parent}),
  folderOrder:()=>invoke('folder_order'),
  arrangeFolder:action=>invoke('arrange_folder',{action}),
  retryFolderOrder:root=>invoke('retry_folder_order',{root}),
  read:(path,allowLarge=false)=>invoke('read_note',{path,allowLarge}),
  save:(path,text,version)=>invoke('save_note',{path,text,version}),
  create:(parent,name,folder)=>invoke('create_entry',{parent,name,folder}),
  importMarkdown: parent => invoke('import_markdown', {parent}),
  rename:(path,name)=>invoke('rename_entry',{path,name}),
  recycle:path=>invoke('recycle_entry',{path}),
  image:path=>invoke('read_image',{path}),
  configure:(shortcut,floating,autostart)=>invoke('update_settings',{shortcut,floating,autostart:autostart??null}),
  snapshot:(snapshot:Snapshot)=>invoke('save_snapshot',{snapshot}),
  clipboard:()=>invoke('read_clipboard'),watchClipboard:enabled=>invoke('watch_clipboard',{enabled}),
  external:url=>invoke('open_external',{url}),hide:()=>invoke('hide_window'),exit:()=>invoke('exit_app')
 };
}
export async function pickDirectory():Promise<string|null>{
 if(!desktop)return '演示笔记';
 const {open}=await import('@tauri-apps/plugin-dialog');
 return open({directory:true,multiple:false,title:'选择本地笔记文件夹'});
}
export async function subscribe(name:string,callback:()=>void){
 if(!desktop){window.addEventListener(name,callback);return ()=>window.removeEventListener(name,callback);}
 const {listen}=await import('@tauri-apps/api/event');return listen(name,callback);
}
