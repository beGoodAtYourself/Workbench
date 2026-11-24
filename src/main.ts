import './style.css';
import {repository,pickDirectory,subscribe,desktop} from './bridge';
import {Workbench,Document} from './model';
import {asFault,type Settings,type Entry,type FolderOrder} from './types';
import {applyFolderOrder} from './folder-tree';
import {treeDrag,chooseFolderDestination,type FolderIntent} from './folder-interactions';
import {basename,parent,key,belongs,resolveLink,slug} from './paths';
import {preview,escape} from './markdown';
import {openSettings} from './autostart-settings';
import {TextWorkbench} from './text-model';
import {textRepository} from './text-bridge';
import type {TextOpenResult} from './text-types';

const shapes:Record<string,string>={
 note:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
 folder:'M3 6h7l2 2h9v12H3z',
 import:'M12 3v12 M7 10l5 5 5-5 M4 15v6h16v-6',
 plus:'M12 5v14 M5 12h14',refresh:'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 13 2 M18 17a7 7 0 0 1-13-2',
 edit:'m4 16 11-11 4 4-11 11H4z M13 7l4 4',eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
 close:'m6 6 12 12 M18 6 6 18',clip:'M8 5H5v16h14V5h-3 M8 3h8v5H8z M8 12h8 M8 16h5',
 settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
 hide:'M5 12h14',chevron:'m9 5 7 7-7 7',more:'M5 12h1 M11 12h1 M17 12h1',check:'m5 12 4 4L19 6',link:'m9 15 6-6 M7 17l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M17 7l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
 split:'M3 4h18v16H3z M12 4v16',arrow:'M5 12h14 m-5-5 5 5-5 5'
};
function icon(name:string){return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="'+(shapes[name]||shapes.note)+'"/></svg>';}
function button(id:string,label:string,image:string,cls='icon-button'){return '<button id="'+id+'" class="'+cls+'" title="'+label+'" aria-label="'+label+'">'+icon(image)+(cls.includes('text-button')?'<span>'+label+'</span>':'')+'</button>';}
const root=document.querySelector<HTMLElement>('#app')!;
root.inert=true;
let toastTimer:ReturnType<typeof setTimeout>|undefined;
function notify(message:string){let host=document.getElementById('toast');if(!host){host=document.createElement('div');host.id='toast';host.setAttribute('role','status');document.body.append(host);}host.textContent=message;host.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>host!.classList.remove('visible'),5500);}
async function ask(title:string,message:string,value?:string,label='确定'):Promise<string|null>{
 const dialog=document.createElement('dialog');dialog.className='modal';
 dialog.innerHTML='<form method="dialog"><div class="modal-kicker">拾页 · 本地工作台</div><h2>'+escape(title)+'</h2><p>'+escape(message)+'</p>'+(value!==undefined?'<label class="field-label">名称<input name="value" autocomplete="off" value="'+escape(value)+'" required maxlength="240"></label>':'')+'<div class="modal-actions"><button value="cancel" formnovalidate class="secondary">取消</button><button value="confirm" class="primary">'+escape(label)+'</button></div></form>';
 document.body.append(dialog);dialog.showModal();const input=dialog.querySelector<HTMLInputElement>('input');input?.focus();input?.select();
 return new Promise(resolve=>dialog.addEventListener('close',()=>{const result=dialog.returnValue==='confirm'?(input?.value.trim()??'ok'):null;dialog.remove();resolve(result);},{once:true}));
}

async function main(){
 const repo=await repository();
 const textRepo=await textRepository();
 const textModel=new TextWorkbench(textRepo);
 let textUI:import('./text-workspace').TextWorkspace|undefined;
 let settings:Settings=await repo.settings();
 const model=new Workbench(repo,async message=>(await ask('打开较大的笔记',message,undefined,'继续加载'))!==null);
 let module:'notes'|'text'|'clipboard'=settings.session.module==='clipboard'?'clipboard':settings.session.module==='text'?'text':'notes';
 let selected:Entry|null=null;
 let expanded=new Set(settings.session.expanded.slice(0,300));
 const directories=new Map<string,Entry[]>();
 let rows:Array<Entry&{depth:number}>=[];
 let paneDisposers:Array<()=>void>=[];
 const editors=new Map<Document,ReturnType<typeof import('./editor').editor>>();
 let renderEpoch=0,clipEpoch=0,hidden=false,treeEpoch=0;
 let lastRender:Promise<void>=Promise.resolve();
 let snapshotTimer:ReturnType<typeof setTimeout>|undefined;
 let refreshTimer:ReturnType<typeof setTimeout>|undefined;
 let switching=false;
 let clipboardChunks:string[]=[],clipboardPage=0;
 let folderOrder:FolderOrder={root:settings.root||'',revision:'',parents:{}};
 let indexedParents:FolderOrder['parents']|undefined,orderIndex=new Map<string,string[]>();
 function orderFor(path:string){if(indexedParents!==folderOrder.parents){indexedParents=folderOrder.parents;orderIndex=new Map(Object.entries(indexedParents).map(([path,order])=>[key(path),order]));}return orderIndex.get(key(path));}
 let drag:ReturnType<typeof treeDrag>|undefined;
 let operationTail:Promise<unknown>=Promise.resolve(),snapshotWarning='';
 function task(action:()=>Promise<unknown>){void action().catch(e=>notify(asFault(e).message));}
 async function freeze<T>(action:()=>Promise<T>):Promise<T>{
  const previous=operationTail;let done!:()=>void;operationTail=new Promise<void>(resolve=>{done=resolve;});await previous;
  const inert=root.inert;root.inert=true;drag?.cancel();treeEpoch++;clearTimeout(refreshTimer);
  try{return await action();}finally{root.inert=inert;done();}
 }
 function checkpoint(){clearTimeout(snapshotTimer);snapshotTimer=setTimeout(()=>task(saveSession),350);}
 let snapshotTail:Promise<void>=Promise.resolve();
 let notesTail:Promise<void>=Promise.resolve();
 async function syncNotes(){const paths=model.records().map(record=>record.path);const write=notesTail.catch(()=>{}).then(()=>textRepo.notes(paths));notesTail=write;await write;}
 async function showText(){if(!textUI){const {TextWorkspace}=await import('./text-workspace');textUI=new TextWorkspace(document.getElementById('text-workspace')!,textModel,notify,!desktop);}textModel.resume();await textUI.show();}
 async function selectNote(path:string){const owner=await textRepo.noteOwner(path);if(owner){await switchModule('text');await textModel.activate(owner);notify('这份文件已在文本编辑中打开。');return;}if(module!=='notes')await switchModule('notes');await model.select(path);}
 textModel.onNote=path=>task(()=>selectNote(path));
 async function saveSession(){const value={module,panes:model.records(),expanded:[...expanded].slice(0,300)};const write=snapshotTail.catch(()=>{}).then(()=>repo.snapshot(value));snapshotTail=write;await write;}
 function disposePanes(){renderEpoch++;paneDisposers.forEach(dispose=>dispose());paneDisposers=[];editors.clear();}
 root.innerHTML='<header class="app-header"><div class="brand"><span class="brand-symbol">'+icon('note')+'</span><strong>拾页</strong><span class="brand-caption">个人工作台</span></div><nav class="navigation" aria-label="工作台模块"><button id="nav-notes">'+icon('note')+'笔记管理</button><button id="nav-text">'+icon('edit')+'文本编辑</button><button id="nav-clipboard">'+icon('clip')+'剪贴板</button></nav><div class="header-tools"><span class="local-badge"><i></i>'+(desktop?'只在本地':'浏览器预览 · 示例数据')+'</span>'+button('settings','设置','settings')+button('hide','隐藏工作台','hide')+'</div></header><div class="app-body"><aside class="sidebar"><div class="workspace-heading"><span class="eyebrow">我的空间</span>'+button('choose-root','选择笔记文件夹','folder')+'</div><button id="workspace-name" class="workspace-name"></button><div class="tree-toolbar">'+button('new-note','新建笔记','plus','primary text-button')+button('new-folder','新建文件夹','folder')+button('refresh','刷新文件列表','refresh')+button('more','更多文件操作','more')+'</div>'+button('import-markdown','导入 Markdown','import','secondary text-button import-markdown')+'<div class="section-label"><span>文件夹与笔记</span><span id="entry-count"></span></div><div id="tree" role="tree" aria-label="笔记文件树" tabindex="0"><div id="tree-space"></div></div><footer class="sidebar-footer"><span class="status-dot"></span><span id="root-status">选择本地文件夹</span></footer></aside><main class="main-area"><div id="workspace-bar"><span>'+icon('folder')+'<span id="breadcrumb">我的笔记</span></span><span class="reading-hint">'+icon('split')+'最多双分屏</span></div><div id="panes"></div><section id="clipboard" hidden></section><section id="text-workspace" hidden></section></main></div><footer class="app-footer"><span id="footer-message">把值得留下的事情，写在这里。</span><span><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd> <span class="muted">随时调出</span></span></footer>';
 const tree=document.getElementById('tree')!;
 const folderStatus=document.createElement('div');folderStatus.className='folder-status';folderStatus.hidden=true;folderStatus.setAttribute('role','status');
 folderStatus.innerHTML='<span></span><button type="button">重试保存</button>';tree.after(folderStatus);
 folderStatus.querySelector('button')!.onclick=()=>task(()=>freeze(async()=>{
  folderOrder=await repo.retryFolderOrder(settings.root!);snapshotWarning='';
  try{await saveSession();}catch(e){snapshotWarning='恢复记录未保存：'+asFault(e).message;}
  showFolderWarning();flatten();
 }));
 function showFolderWarning(){const message=[folderOrder.warning,snapshotWarning].filter(Boolean).join(' ');folderStatus.hidden=!message;folderStatus.querySelector('span')!.textContent=message;}
 function updateShell(){
  document.getElementById('nav-notes')!.classList.toggle('selected',module==='notes');
  document.getElementById('nav-text')!.classList.toggle('selected',module==='text');
  document.getElementById('nav-clipboard')!.classList.toggle('selected',module==='clipboard');
  document.querySelector('.sidebar')!.classList.toggle('muted-sidebar',module==='clipboard');
  (document.querySelector('.sidebar') as HTMLElement).hidden=module==='text';
  const name=document.getElementById('workspace-name')!;name.textContent=settings.root?basename(settings.root.replaceAll('\\','/')):'选择笔记文件夹';name.title=settings.root?settings.root+'\n点击返回笔记根目录':'选择一个文件夹，开始记录';name.setAttribute('aria-label',settings.root?'返回笔记根目录':'选择笔记文件夹');
  document.getElementById('root-status')!.textContent=settings.root?'本地文件夹 · 已连接':'尚未选择笔记文件夹';
  document.getElementById('breadcrumb')!.textContent=module==='notes'?'我的笔记':module==='text'?'文本编辑':'剪贴板';
  document.getElementById('workspace-bar')!.hidden=module==='text';
  document.querySelector('.reading-hint')!.classList.toggle('invisible',module!=='notes');
  document.getElementById('panes')!.hidden=module!=='notes';
  document.getElementById('clipboard')!.hidden=module!=='clipboard';
  document.getElementById('text-workspace')!.hidden=module!=='text';
  document.querySelector('.app-footer>span:last-child')!.innerHTML=settings.shortcut.split('+').map(part=>'<kbd>'+escape(part.replace('Control','Ctrl'))+'</kbd>').join(' + ')+' <span class="muted">随时调出</span>';
 }
 function flatten(){
  rows=[];const visit=(path:string,depth:number)=>{for(const entry of applyFolderOrder(directories.get(path)||[],orderFor(path))){rows.push({...entry,depth});if(entry.kind==='folder'&&expanded.has(entry.path))visit(entry.path,depth+1);}};visit('',0);
  document.getElementById('entry-count')!.textContent=String(rows.filter(e=>e.kind==='note').length);renderTree();
 }
 function renderTree(){
  const rootSelected=!!settings.root&&!selected,workspaceName=document.getElementById('workspace-name')!;
  workspaceName.classList.toggle('active',rootSelected);workspaceName.setAttribute('aria-pressed',String(rootSelected));
  const space=document.getElementById('tree-space')!;space.style.height=Math.max(rows.length*34,64)+'px';
  if(!settings.root){space.innerHTML='<p class="tree-empty">你的笔记，存放在你选择的文件夹里。</p>';return;}
  if(!rows.length){space.innerHTML='<p class="tree-empty">文件夹还是空的<br>新建一篇笔记，开始记录。</p>';return;}
  const start=Math.max(0,Math.floor(tree.scrollTop/34)-6),end=Math.min(rows.length,start+Math.ceil(tree.clientHeight/34)+14);
  space.innerHTML=rows.slice(start,end).map((entry,i)=>{
   const active=selected!==null&&key(selected.path)===key(entry.path);
   return '<div class="tree-row'+(active?' active':'')+'" role="treeitem" aria-selected="'+active+'"'+(entry.kind==='folder'?' aria-expanded="'+expanded.has(entry.path)+'"':'')+' data-path="'+escape(entry.path)+'" data-row="'+(start+i)+'" tabindex="-1" draggable="false" style="top:'+((start+i)*34)+'px;padding-left:'+(12+entry.depth*16)+'px" title="'+escape(entry.path)+'"><span class="tree-chevron '+(expanded.has(entry.path)?'expanded':'')+'">'+(entry.kind==='folder'?icon('chevron'):'')+'</span><span class="tree-file-icon '+entry.kind+'">'+icon(entry.kind==='folder'?'folder':'note')+'</span><span class="tree-label">'+escape(entry.name.replace(/\.md$/i,''))+'</span>'+(entry.kind==='note'?'<span class="file-extension">md</span>':'')+'</div>';
  }).join('');
  drag?.paint();
 }
 async function refreshTree(){
  if(!settings.root)return;
  const epoch=++treeEpoch;
  try{
   const top=await repo.list('');if(epoch!==treeEpoch)return;directories.set('',top);
   for(const path of [...expanded]){try{const entries=await repo.list(path);if(epoch!==treeEpoch)return;directories.set(path,entries);}catch(e){if(epoch!==treeEpoch)return;if(asFault(e).code==='missing'){expanded.delete(path);directories.delete(path);}else notify('无法刷新“'+path+'”：'+asFault(e).message);}}
   const order=await repo.folderOrder();if(epoch!==treeEpoch)return;folderOrder=order;showFolderWarning();
   document.getElementById('root-status')!.textContent='本地文件夹 · 已连接';flatten();
  }catch(e){if(epoch===treeEpoch){document.getElementById('root-status')!.textContent='文件夹不可访问';notify(asFault(e).message);}}
 }
 tree.addEventListener('scroll',renderTree,{passive:true});
 new ResizeObserver(renderTree).observe(tree);
 function rowAt(target:EventTarget|null){const row=(target as Element|null)?.closest<HTMLElement>('[data-row]');return row?rows[Number(row.dataset.row)]:undefined;}
 function selectRoot(){selected=null;document.querySelector('.context-menu')?.remove();renderTree();}
 tree.addEventListener('click',event=>{const entry=rowAt(event.target);if(!entry){selectRoot();return;}selected=entry;renderTree();task(async()=>{
  if(entry.kind==='folder'){
   if(expanded.has(entry.path)){expanded.delete(entry.path);for(const p of [...directories.keys()])if(belongs(p,entry.path))directories.delete(p);for(const p of [...expanded])if(belongs(p,entry.path))expanded.delete(p);}
   else{if(expanded.size>=300){notify('已展开较多文件夹，请先折叠部分目录。');return;}const epoch=treeEpoch,entries=await repo.list(entry.path);if(epoch!==treeEpoch||root.inert)return;const order=await repo.folderOrder();if(epoch!==treeEpoch||root.inert)return;folderOrder=order;showFolderWarning();expanded.add(entry.path);directories.set(entry.path,entries);}flatten();checkpoint();
  }else{await selectNote(entry.path);}
 });});
 drag=treeDrag({tree,workspace:document.getElementById('workspace-name')!,entryAt:rowAt,root:()=>settings.root,busy:()=>root.inert||hidden,render:renderTree,expanded:path=>expanded.has(path),
  expand:async(path,valid)=>{if(expanded.size>=300)return;const epoch=treeEpoch,entries=await repo.list(path);if(!valid()||epoch!==treeEpoch)return;const order=await repo.folderOrder();if(!valid()||epoch!==treeEpoch)return;folderOrder=order;showFolderWarning();expanded.add(path);directories.set(path,entries);flatten();checkpoint();},
  drop:intent=>task(()=>arrangeFolder(intent)),notify,
  note:(path,x,y)=>{const target=document.elementFromPoint(x,y),found=[...editors.values()].find(editor=>target&&editor.view.dom.contains(target));if(found)found.insertLink(path,x,y);else notify('请将笔记拖入编辑模式中的正文区域。');}
 });
 tree.addEventListener('contextmenu',event=>{event.preventDefault();selected=rowAt(event.target)??null;renderTree();showMenu(event.clientX,event.clientY);});
 tree.addEventListener('keydown',event=>{
  if(event.key==='F2'){event.preventDefault();task(rename);}if(event.key==='Delete'){event.preventDefault();task(recycle);}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();let index=rows.findIndex(entry=>selected&&key(entry.path)===key(selected.path));index=event.key==='Home'?0:event.key==='End'?rows.length-1:Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)));if(rows[index]){selected=rows[index];tree.scrollTop=Math.max(0,index*34-tree.clientHeight/2);renderTree();}}
  if(event.key==='Enter'||event.key===' '){event.preventDefault();tree.querySelector<HTMLElement>('.tree-row.active')?.click();}
  if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();const rect=tree.querySelector('.tree-row.active')?.getBoundingClientRect()||tree.getBoundingClientRect();showMenu(rect.left+15,rect.top+15);}
 });
 function active(doc:Document){model.active=model.panes.indexOf(doc);updateStatus();}
 function updateStatus(){
  model.panes.forEach((doc,index)=>{
   const pane=document.querySelector<HTMLElement>('.note-pane[data-index="'+index+'"]');if(!pane)return;
   pane.classList.toggle('active-pane',index===model.active);
   const label=doc.error?'保存需要处理':doc.saving?'正在保存…':doc.dirty?'未保存':'已保存到本地';
   const save=pane.querySelector<HTMLElement>('.save-state')!;save.textContent=label;save.classList.toggle('error',!!doc.error);save.title=doc.error?.message||'Ctrl + S 保存';
   pane.querySelector('.char-count')!.textContent=doc.text.length.toLocaleString()+' 字符';
   const error=pane.querySelector<HTMLElement>('.note-error')!;error.hidden=!doc.error;if(doc.error){error.querySelector('span')!.textContent=doc.error.message;}
  });
  renderTree();
 }
 async function renderPanes(){
  disposePanes();const epoch=renderEpoch;const container=document.getElementById('panes')!;container.replaceChildren();
  if(module!=='notes')return;
  container.classList.toggle('split',model.panes.length===2);
  if(!model.panes.length){
   container.innerHTML='<section class="empty-state"><div class="empty-illustration"><span>'+icon('note')+'</span><i>'+icon('plus')+'</i></div><p class="eyebrow">属于你的本地空间</p><h1>给思绪一个落脚点</h1><p>写下想法，连接笔记。<br>每一页，都保存在你自己的文件夹里。</p><button class="primary text-button" id="empty-action">'+icon(settings.root?'plus':'folder')+(settings.root?'新建第一篇笔记':'选择笔记文件夹')+'</button><div class="empty-details"><span>'+icon('note')+'Markdown 记录</span><span>'+icon('split')+'双分屏阅读</span></div></section>';
   document.getElementById('empty-action')!.onclick=()=>task(settings.root?()=>create(false):chooseRoot);return;
  }
  for(const [index,doc] of model.panes.entries()){
   const pane=document.createElement('section');pane.className='note-pane';pane.dataset.index=String(index);pane.setAttribute('aria-label',basename(doc.path)+' 窗格');
   pane.innerHTML='<header class="note-header"><div class="note-title">'+icon('note')+'<div><strong>'+escape(basename(doc.path).replace(/\.md$/i,''))+'</strong><small>'+escape(parent(doc.path)||'我的笔记')+' <span> / Markdown</span></small></div></div><div class="note-actions"><div class="mode-switch"><button data-mode="preview" title="显示模式" aria-label="显示模式" class="'+(doc.mode==='preview'?'selected':'')+'">'+icon('eye')+'<span>显示</span></button><button data-mode="edit" title="编辑模式" aria-label="编辑模式" class="'+(doc.mode==='edit'?'selected':'')+'">'+icon('edit')+'<span>编辑</span></button></div>'+(index===1?'<button class="icon-button close-pane" aria-label="关闭右窗格" title="关闭右窗格">'+icon('close')+'</button>':'')+'</div></header><div class="note-error" hidden><span></span><button>处理</button></div><div class="note-content '+(doc.mode==='preview'?'article':'editor-host')+'"></div><footer class="note-footer"><button class="save-state"></button><span class="char-count"></span></footer>';
   container.append(pane);pane.addEventListener('pointerdown',()=>active(doc));
   pane.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b=>b.onclick=()=>{if(doc.mode!==b.dataset.mode){doc.mode=b.dataset.mode as 'edit'|'preview';active(doc);lastRender=renderPanes();checkpoint();}});
   pane.querySelector('.close-pane')?.addEventListener('click',()=>task(()=>model.closeRight()));
   pane.querySelector('.save-state')!.addEventListener('click',()=>task(()=>doc.error?repair(doc):model.flush(doc)));
   pane.querySelector('.note-error button')!.addEventListener('click',()=>task(()=>repair(doc)));
   const content=pane.querySelector<HTMLElement>('.note-content')!;
   if(doc.mode==='edit'){
    const {editor}=await import('./editor');if(epoch!==renderEpoch)return;
    const view=editor(content,doc,text=>model.edit(doc,text),href=>task(()=>openLink(doc,href)),()=>task(()=>model.flush(doc)),()=>active(doc));editors.set(doc,view);paneDisposers.push(()=>view.destroy());
   }else{
    const cleanup=preview(content,doc.text,doc.path,repo,href=>task(()=>openLink(doc,href)));
    content.scrollTop=doc.scroll;const onScroll=()=>{doc.scroll=content.scrollTop;};content.addEventListener('scroll',onScroll,{passive:true});
    paneDisposers.push(()=>{doc.scroll=content.scrollTop;content.removeEventListener('scroll',onScroll);cleanup();});
   }
  }
  updateStatus();
 }
 async function openLink(doc:Document,href:string){
  const destination=resolveLink(doc.path,href);
  if(destination.kind==='external'){await repo.external(destination.url);return;}
  if(await textRepo.noteOwner(destination.path)){await selectNote(destination.path);return;}
  await model.follow(doc,destination.path);await lastRender;
  if(destination.fragment){
   const target=model.panes.find(d=>key(d.path)===key(destination.path));if(!target)return;
   const index=model.panes.indexOf(target),pane=document.querySelector<HTMLElement>('.note-pane[data-index="'+index+'"]');
   if(target.mode==='edit'){
    let position=-1,offset=0;const counts=new Map<string,number>();
    for(const line of target.text.split('\n')){const heading=/^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);if(heading){const id=slug(heading[1]),n=counts.get(id)||0;counts.set(id,n+1);if(id+(n?'-'+n:'')===slug(destination.fragment)){position=offset;break;}}offset+=line.length+1;}
    if(position>=0)editors.get(target)?.goTo(position);else notify('笔记已打开，但没有找到链接中的标题。');
   }
   else{const heading=pane?.querySelector<HTMLElement>('[id="'+CSS.escape(destination.fragment)+'"]')||pane?.querySelector<HTMLElement>('[id="'+CSS.escape(slug(destination.fragment))+'"]');if(heading)heading.scrollIntoView({block:'start'});else notify('笔记已打开，但没有找到链接中的标题。');}
  }
 }
 async function repair(doc:Document){
  const dialog=document.createElement('dialog');dialog.className='modal';
  dialog.innerHTML='<form method="dialog"><div class="modal-kicker">保留你的修改</div><h2>处理保存问题</h2><p>'+escape(doc.error?.message||'这篇笔记尚未保存。')+'</p><div class="repair-options"><button value="retry">重试保存</button><button value="copy">另存本地副本</button><button value="reload">从磁盘重新载入</button></div><div class="modal-actions"><button value="cancel" class="secondary">取消</button></div></form>';
  document.body.append(dialog);dialog.showModal();const action=await new Promise<string>(resolve=>dialog.addEventListener('close',()=>{const value=dialog.returnValue;dialog.remove();resolve(value);},{once:true}));
  if(action==='retry')await model.flush(doc);
  if(action==='reload'&&await ask('重新载入磁盘内容','这会丢弃当前窗格中尚未保存的修改。',undefined,'重新载入'))await freeze(()=>model.reload(doc));
  if(action==='copy'){
   const name=await ask('另存本地副本','原文件保持不变，新文件创建在同一文件夹。',basename(doc.path).replace(/\.md$/i,'')+' - 副本','保存副本');if(!name)return;
   await freeze(async()=>{const path=await repo.create(parent(doc.path),name,false),empty=await repo.read(path);
    const revision=doc.revision,text=doc.text,version=await repo.save(path,text,empty.version);doc.path=path;doc.version=version;doc.savedRevision=revision;doc.error=null;
    await model.flush(doc);await refreshTree();lastRender=renderPanes();checkpoint();notify('副本已保存到本地。');});
  }
 }
 model.onChange=layout=>{if(layout){lastRender=renderPanes();checkpoint();task(syncNotes);}else updateStatus();};
 async function arrangeFolder(intent:FolderIntent){
  const expectedRoot=settings.root;if(!expectedRoot)return;
  const source=directories.get(parent(intent.source))?.find(entry=>key(entry.path)===key(intent.source));
  if(intent.placement!=='reset'&&!source)throw new Error('项目已改变，请刷新后重试。');
  const kind=source?.kind??'folder',label=kind==='note'?'笔记':'文件夹';
  const moving=intent.placement!=='reset'&&key(parent(intent.source))!==key(intent.parent);
  const next=(intent.parent?intent.parent+'/':'')+basename(intent.source);
  if(moving&&!await ask('移动'+label,'从：'+intent.source+'\n到：'+next+'\n\n相对链接及图片引用不会自动改写，可能需要手动修复。',undefined,'移动'+label))return;
  await freeze(async()=>{
   if(settings.root!==expectedRoot)throw new Error('笔记库已切换，请重新选择项目。');
   clearTimeout(snapshotTimer);await snapshotTail.catch(()=>{});
   const release=await model.beginFileOperation();
   try{
    const order=await repo.folderOrder();
    const result=await repo.arrangeFolder({...intent,root:expectedRoot,revision:order.revision});
    folderOrder=result.order;let atExpansionLimit=false;
    if(result.moved){
     const remap=(path:string)=>belongs(path,intent.source)?result.path+path.slice(intent.source.length):path;
     expanded=new Set([...expanded].map(remap));
     selected={path:result.path,name:basename(result.path),kind};
     model.remap(intent.source,result.path);
     const chain:string[]=[];for(let path=parent(result.path);path;path=parent(path))chain.unshift(path);
     for(const path of chain)if(!expanded.has(path)){if(expanded.size>=300){atExpansionLimit=true;break;}expanded.add(path);}
    }else if(intent.source)selected={path:intent.source,name:basename(intent.source),kind};
    directories.clear();await refreshTree();
    if(result.warning&&!folderOrder.warning)folderOrder.warning=result.warning;
    clearTimeout(snapshotTimer);snapshotWarning='';
    try{await saveSession();}catch(e){snapshotWarning=(result.moved?label+'已移动，':'')+'恢复记录未保存：'+asFault(e).message;}
    showFolderWarning();
    if(atExpansionLimit){selected=null;for(let path=parent(result.path);path;path=parent(path)){const ancestor=rows.find(entry=>key(entry.path)===key(path));if(ancestor){selected=ancestor;break;}}}
    const index=rows.findIndex(entry=>selected&&key(entry.path)===key(selected.path));if(index>=0)tree.scrollTop=Math.max(0,index*34-tree.clientHeight/2);else if(atExpansionLimit)tree.scrollTop=0;renderTree();
    notify(result.moved?label+'已移动到“'+result.path+'”。'+(atExpansionLimit?'已定位可见的目标父目录；展开已达 300 个上限，请折叠部分目录后继续查看。':''):intent.placement==='reset'?'已恢复同级默认排序。':label+'顺序已保存。');
   }finally{release();}
  });
 }
 async function moveFolder(target:Entry){
  const workspace=settings.root;
  const destination=await chooseFolderDestination(target.path,async path=>{const epoch=treeEpoch,entries=await repo.list(path),order=await repo.folderOrder();if(epoch!==treeEpoch||settings.root!==workspace)throw new Error('笔记库已改变，请重新选择。');folderOrder=order;showFolderWarning();return applyFolderOrder(entries,orderFor(path));},target.kind);
  if(destination!==null&&settings.root===workspace)await arrangeFolder({source:target.path,parent:destination,placement:'inside'});
 }
 async function stepFolder(target:Entry,step:number){
  const siblings=applyFolderOrder(directories.get(parent(target.path))||[],orderFor(parent(target.path))).filter(entry=>entry.kind===target.kind);
  const index=siblings.findIndex(entry=>key(entry.path)===key(target.path)),anchor=siblings[index+step];
  if(anchor)await arrangeFolder({source:target.path,parent:parent(target.path),placement:step<0?'before':'after',anchor:anchor.path});
 }
 async function chooseRoot(){
  await freeze(async()=>{
  await model.flushAll();const path=await pickDirectory();if(!path)return;await model.flushAll();
  await textModel.checkpoint();
  clearTimeout(snapshotTimer);await snapshotTail.catch(()=>{});const next=await repo.workspace(path);await model.clear();textUI?.hide();settings=next;folderOrder={root:next.root||'',revision:'',parents:{}};snapshotWarning='';expanded.clear();directories.clear();selected=null;module='notes';updateShell();await syncNotes();await refreshTree();await renderPanes();checkpoint();
  });
 }
 function selectedParent(){return selected?.kind==='folder'?selected.path:selected?parent(selected.path):'';}
 async function importMarkdown() {
  if (!settings.root) {
   await chooseRoot();
   if (!settings.root) {
    return;
   }
  }
  if (module !== 'notes') {
   await switchModule('notes');
  }
  if (module !== 'notes') {
   return;
  }
  const destination = selectedParent();
  await freeze(async () => {
   const release = await model.beginFileOperation();
   let path: string | null;
   try {
    await syncNotes();
    path = await repo.importMarkdown(destination);
   } finally {
    release();
   }
   if (!path) {
    return;
   }

   if (destination) {
    expanded.add(destination);
   }
   selected = {path, name: basename(path), kind: 'note'};
   await refreshTree();
   const index = rows.findIndex(entry => key(entry.path) === key(path));
   if (index >= 0) {
    tree.scrollTop = Math.max(0, index * 34 - tree.clientHeight / 2);
    renderTree();
   }
   try {
    await model.select(path, 'preview');
    notify('已导入“' + basename(path) + '”');
   } catch (error) {
    notify('已导入“' + basename(path) + '”，未能打开：' + asFault(error).message);
   }
   checkpoint();
  });
 }

 async function create(folder:boolean,inFolder?:string){
  if(!settings.root){await chooseRoot();if(!settings.root)return;}
  inFolder??=selectedParent();const name=await ask(folder?'新建文件夹':'新建笔记','保存位置：'+(inFolder||'笔记根目录'),folder?'新建文件夹':'未命名笔记',folder?'创建文件夹':'创建笔记');if(!name)return;
  if(!folder&&module!=='notes')await switchModule('notes');
  await freeze(async()=>{const path=await repo.create(inFolder!,name,folder);if(inFolder)expanded.add(inFolder);
  selected={path,name:basename(path),kind:folder?'folder':'note'};await refreshTree();
  if(!folder){await model.select(path,'edit');}else{if(expanded.size<300){expanded.add(path);directories.set(path,[]);}flatten();}checkpoint();});
 }
 async function rename(){
  if(!selected){notify('请先在文件树中选择一个项目。');return;}const target=selected;
  const name=await ask('重命名','已有笔记中的相对链接不会自动改写；重命名后可能需要手动修复。',target.name,'重命名');if(!name)return;
  await freeze(async()=>{clearTimeout(snapshotTimer);await snapshotTail.catch(()=>{});const release=await model.beginFileOperation();try{const next=await repo.rename(target.path,name);model.remap(target.path,next);
  expanded=new Set([...expanded].map(p=>belongs(p,target.path)?next+p.slice(target.path.length):p));
  selected={path:next,name:basename(next),kind:target.kind};directories.clear();await refreshTree();checkpoint();}finally{release();}});
 }
 async function recycle(){
  if(!selected){notify('请先选择要移至回收站的项目。');return;}const target=selected;
  if(!await ask('移至回收站','将“'+target.name+'”'+(target.kind==='folder'?'及其所有内容':'')+'移至系统回收站？',undefined,'移至回收站'))return;
  await freeze(async()=>{clearTimeout(snapshotTimer);await snapshotTail.catch(()=>{});const release=await model.beginFileOperation();try{await repo.recycle(target.path);model.remove(target.path);for(const p of [...expanded])if(belongs(p,target.path))expanded.delete(p);selected=null;directories.clear();await refreshTree();checkpoint();}finally{release();}});
 }
 function showMenu(x:number,y:number){
  const target=selected;
  document.querySelector('.context-menu')?.remove();const menu=document.createElement('div');menu.className='context-menu';menu.innerHTML='<button data-action="note">新建笔记</button><button data-action="import">导入 Markdown</button><button data-action="folder">'+(target?.kind==='folder'?'新建子文件夹':'新建文件夹')+'</button>'+(target?.kind==='folder'?'<button data-action="sibling-folder">新建同级文件夹</button>':'')+'<hr><button data-action="rename"'+(!target?' disabled':'')+'>重命名</button><button data-action="delete" class="danger"'+(!target?' disabled':'')+'>移至回收站</button>';document.body.append(menu);
  menu.style.left=Math.max(4,Math.min(x,window.innerWidth-menu.offsetWidth-4))+'px';menu.style.top=Math.max(4,Math.min(y,window.innerHeight-menu.offsetHeight-4))+'px';
  if(target){
   const siblings=applyFolderOrder(directories.get(parent(target.path))||[],orderFor(parent(target.path))).filter(entry=>entry.kind===target.kind),index=siblings.findIndex(entry=>key(entry.path)===key(target.path));
   const section=document.createElement('div');section.innerHTML='<hr><button data-action="up"'+(index<=0?' disabled':'')+'>上移</button><button data-action="down"'+(index<0||index>=siblings.length-1?' disabled':'')+'>下移</button><button data-action="move">移动到…</button><button data-action="reset-order">恢复同级默认排序</button>';menu.append(section);
   section.onclick=event=>{const action=(event.target as HTMLElement).dataset.action;if((event.target as HTMLButtonElement).disabled)return;if(action==='up')task(()=>stepFolder(target,-1));if(action==='down')task(()=>stepFolder(target,1));if(action==='move')task(()=>moveFolder(target));if(action==='reset-order')task(()=>arrangeFolder({source:'',parent:parent(target.path),placement:'reset'}));};
  }
  menu.style.top=Math.max(4,Math.min(y,window.innerHeight-menu.offsetHeight-4))+'px';menu.setAttribute('aria-label','文件操作');
  menu.addEventListener('keydown',event=>{const buttons=[...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(event.key==='Escape'){menu.remove();tree.focus();}if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}});
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  menu.addEventListener('click', event => {
   const action = (event.target as HTMLElement).dataset.action;
   menu.remove();
   if (action === 'note') {
    task(() => create(false));
   }
   if (action === 'import') {
    task(importMarkdown);
   }
   if (action === 'folder') {
    task(() => create(true));
   }
   if (action === 'sibling-folder' && target) {
    task(() => create(true, parent(target.path)));
   }
   if (action === 'rename') {
    task(rename);
   }
   if (action === 'delete') {
    task(recycle);
   }
  });
  setTimeout(()=>document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target as Node))menu.remove();},{once:true}),0);
 }
 async function readClipboard(){
  const epoch=++clipEpoch,host=document.getElementById('clip-text');if(!host||module!=='clipboard'||hidden)return;
  host.textContent='正在读取…';document.getElementById('clip-status')!.textContent='';
  try{const clip=await repo.clipboard();if(epoch!==clipEpoch||module!=='clipboard'||hidden)return;
   clipboardChunks=[];clipboardPage=0;
   if(clip.status==='text')for(let start=0;start<clip.text.length;){let end=Math.min(start+4096,clip.text.length);if(end<clip.text.length&&/[\uD800-\uDBFF]/.test(clip.text[end-1]))end--;clipboardChunks.push(clip.text.slice(start,end));start=end;}
   host.textContent=clip.status==='empty'?'剪贴板当前为空。':clip.status==='unsupported'?'当前内容不是文本，暂不支持显示。':'';
   renderClipboardPage();
   document.getElementById('clip-status')!.textContent=clip.truncated?'内容较长，已显示前 1 MiB 文本。':clip.status==='text'?'当前文本 · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';
  }catch(e){if(epoch===clipEpoch&&module==='clipboard'){clipboardChunks=[];renderClipboardPage();host.textContent=asFault(e).message;document.getElementById('clip-status')!.textContent='读取失败 · 可点击刷新重试';}}
 }
 function renderClipboardPage(){
  const host=document.getElementById('clip-text'),navigation=document.getElementById('clip-pages');if(!host||!navigation)return;
  if(clipboardChunks.length)host.textContent=clipboardChunks[clipboardPage];host.scrollTop=0;
  navigation.hidden=clipboardChunks.length<2;
  (document.getElementById('clip-previous') as HTMLButtonElement).disabled=clipboardPage===0;
  (document.getElementById('clip-next') as HTMLButtonElement).disabled=clipboardPage>=clipboardChunks.length-1;
  document.getElementById('clip-page-label')!.textContent='长文本分段显示 · '+(clipboardPage+1)+' / '+clipboardChunks.length;
 }
 async function renderClipboard(){
  const host=document.getElementById('clipboard')!;host.innerHTML='<div class="clipboard-heading"><div><span class="eyebrow">触手可及</span><h1>当前剪贴板</h1><p>刚刚复制的文字，就在这里。</p></div><button id="clip-refresh" class="secondary text-button">'+icon('refresh')+'刷新</button></div><div class="clipboard-card"><header>'+icon('clip')+'<span>文本内容</span><span class="small-badge">只读</span></header><pre id="clip-text" tabindex="0" aria-label="当前剪贴板文本"></pre><footer id="clip-status"></footer></div><p class="clipboard-footnote"><span class="status-dot"></span>只显示当前内容，不收集复制历史。</p>';
  const pages=document.createElement('div');pages.id='clip-pages';pages.className='clipboard-pages';pages.hidden=true;pages.innerHTML='<button id="clip-previous" class="secondary">上一段</button><span id="clip-page-label"></span><button id="clip-next" class="secondary">下一段</button>';host.querySelector('.clipboard-card')!.append(pages);
  document.getElementById('clip-previous')!.onclick=()=>{clipboardPage--;renderClipboardPage();};document.getElementById('clip-next')!.onclick=()=>{clipboardPage++;renderClipboardPage();};
  document.getElementById('clip-refresh')!.onclick=()=>task(readClipboard);try{await repo.watchClipboard(true);}catch(e){notify(asFault(e).message);}await readClipboard();
 }
 async function switchModule(next:'notes'|'text'|'clipboard'){
  if (textModel.opening) {
   notify('正在打开文本文件，请完成文件选择后再切换模块。');
   return;
  }
  if(switching||root.inert||next===module)return;switching=true;root.inert=true;
  const previous=module;
  try{await model.flushAll();await syncNotes();textUI?.hide();await textModel.suspend();clipEpoch++;clipboardChunks=[];await repo.watchClipboard(false);document.getElementById('clipboard')!.replaceChildren();disposePanes();
   // Read inactive documents only when their module becomes active again.
   if(next==='notes')await model.refresh();else if(next==='text'){textModel.resume();await textModel.refresh();}
   module=next;updateShell();if(module==='notes')await renderPanes();else if(module==='text')await showText();else await renderClipboard();await saveSession();}
  catch(error){module=previous;updateShell();textModel.resume();if(module==='notes')await renderPanes();else if(module==='text')await showText();else await renderClipboard();throw error;}
  finally{textModel.resume();switching=false;root.inert=false;}
 }
 async function hide(exit=false){
  if (textModel.opening) {
   notify('正在打开文本文件，请完成文件选择后再隐藏或退出。');
   return;
  }
  if(switching||root.inert||document.querySelector('dialog[open]'))return;switching=true;root.inert=true;
  drag?.cancel();
  try{await model.flushAll();disposePanes();if(exit)textUI?.hide();else textUI?.pause();await textModel.suspend();await syncNotes();await saveSession();clipEpoch++;clipboardChunks=[];await repo.watchClipboard(false);document.getElementById('clipboard')!.replaceChildren();hidden=true;if(exit)await repo.exit();else await repo.hide();if(!desktop){hidden=false;root.inert=false;notify('桌面版会隐藏到悬浮入口。');await restored();}}
  catch(e){hidden=false;textModel.resume();if(module==='notes')await renderPanes();else if(module==='text')await showText();else await renderClipboard();throw e;}
  finally{switching=false;root.inert=false;if(!hidden&&module==='text')textUI?.focus();}
 }
 let windowActionTail = Promise.resolve();

 function queueWindowAction(action: () => Promise<void>) {
  windowActionTail = windowActionTail.then(action).catch(error => notify(asFault(error).message));
  return windowActionTail;
 }

 async function waitForFileOperation() {
  const busy = () => root.inert || textModel.opening || !!document.querySelector('dialog[open]');
  if (!busy()) {
   return;
  }

  await new Promise<void>(resolve => {
   const observer = new MutationObserver(() => {
    if (!busy()) {
     observer.disconnect();
     resolve();
    }
   });
   observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['inert', 'open', 'aria-busy']
   });
  });
 }

 async function openInTextWorkspace(open: () => Promise<TextOpenResult>) {
  await switchModule('text');
  const result = await open();
  if (result.errors.length) {
   notify(result.errors.map(error => error.message).join('；'));
  }
  textUI?.focus();
 }

 async function restored(){
  await waitForFileOperation();
  hidden=false;textModel.resume();if(module==='clipboard')await renderClipboard();else if(module==='text'){await textModel.refresh();await showText();}else{await model.refresh();await renderPanes();}await refreshTree();await ready();
 }
 async function ready() {
  if (!desktop) {
   return;
  }

  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const {invoke} = await import('@tauri-apps/api/core');
  if (await invoke<boolean>('frontend_ready')) {
   await waitForFileOperation();
   await openInTextWorkspace(() => textModel.openFiles(() => invoke('text_open_launch')));
  }
 }
 async function configure(){
  if(document.querySelector('dialog[open]'))return;
  settings=await repo.settings();
  if(document.querySelector('dialog[open]'))return;
  openSettings(repo,settings,{updated:next=>{settings=next;updateShell();},saved:notify,exit:()=>task(()=>hide(true)),folder:()=>task(chooseRoot)});
 }
 document.getElementById('nav-notes')!.onclick=()=>task(()=>switchModule('notes'));
 document.getElementById('nav-text')!.onclick=()=>task(()=>switchModule('text'));
 document.getElementById('nav-clipboard')!.onclick=()=>task(()=>switchModule('clipboard'));
 document.getElementById('choose-root')!.onclick=()=>task(chooseRoot);
 document.getElementById('workspace-name')!.onclick=()=>{if(settings.root)selectRoot();else task(chooseRoot);};
 document.getElementById('new-note')!.onclick=()=>task(()=>create(false));
 document.getElementById('import-markdown')!.onclick = () => task(importMarkdown);
 document.getElementById('new-folder')!.onclick=()=>task(()=>create(true));
 async function refreshActiveModule(){if(module==='notes')await model.refresh();else if(module==='text')await textModel.refresh();}
 document.getElementById('refresh')!.onclick=()=>task(async()=>{await refreshTree();await refreshActiveModule();});
 document.getElementById('more')!.onclick=event=>showMenu((event.currentTarget as HTMLElement).getBoundingClientRect().left,160);
 document.getElementById('settings')!.onclick=()=>task(configure);
 document.getElementById('hide')!.onclick=()=>task(()=>hide());
 window.addEventListener('keydown',event=>{if(module==='notes'&&!event.defaultPrevented&&!document.querySelector('dialog[open]')&&event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();const doc=model.current();if(doc)task(()=>model.flush(doc));}});
 const refresh=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(!hidden&&!root.inert&&!drag?.active&&!document.querySelector('dialog[open]'))task(async()=>{await refreshActiveModule();await refreshTree();});},250);};
 await subscribe('refresh-files',refresh);
 await subscribe('restored', () => { void queueWindowAction(restored); });
 await subscribe('request-hide',()=>task(()=>hide()));await subscribe('request-exit',()=>task(()=>hide(true)));
 await subscribe('text-lifecycle-error', () => { void queueWindowAction(restored); });
 await subscribe('clipboard-changed',()=>{if(module==='clipboard'&&!hidden)task(readClipboard);});
 await subscribe('settings-changed',()=>task(async()=>{settings=await repo.settings();updateShell();}));
 window.addEventListener('focus',refresh);
 document.addEventListener('visibilitychange',()=>{if(module==='clipboard')task(async()=>{if(document.hidden){clipEpoch++;clipboardChunks=[];await repo.watchClipboard(false);document.getElementById('clip-text')?.replaceChildren();}else if(!hidden){await repo.watchClipboard(true);await readClipboard();}});});
 updateShell();
 try{await textModel.restore();if(desktop&&textModel.warning)notify(textModel.warning);}catch(error){notify('文本草稿恢复需要处理：'+asFault(error).message);}
 if(settings.root){
  await refreshTree();
  for(const record of settings.session.panes.slice(0,2)){
   try{const doc=await model.load(record.path);if(!model.panes.some(d=>key(d.path)===key(doc.path))){doc.mode=record.mode==='edit'?'edit':'preview';doc.cursor=record.cursor;doc.scroll=record.scroll;model.panes.push(doc);}}catch(e){notify(asFault(e).message);}
  }
 }
 await syncNotes();
 if(module==='notes')await renderPanes();else if(module==='text')await showText();else await renderClipboard();
 if(settings.startupError)notify(settings.startupError);
 root.inert=false;
 if(module==='text')textUI?.focus();else if(module==='notes'){const doc=model.current();if(doc)editors.get(doc)?.view.focus();}
 if (desktop) {
  const {listen} = await import('@tauri-apps/api/event');
  await listen<boolean>('text-file-hover', event => {
   root.classList.toggle('text-file-hover', event.payload && !root.inert && !hidden);
  });
  await listen<import('./types').Fault>('text-drop-error', event => notify(event.payload.message));
  await listen<string>('text-files-dropped', event => {
   root.classList.remove('text-file-hover');
   void queueWindowAction(async () => {
    if (root.inert || hidden || textModel.opening || document.querySelector('dialog[open]')) {
     notify('请完成当前操作后重新拖入文件。');
     return;
    }
    await openInTextWorkspace(() => textModel.openDropped(event.payload));
   });
  });
 }
 await queueWindowAction(ready);
}
void main().catch(error=>{root.inert=false;root.innerHTML='<div class="startup-error"><h1>暂时无法打开工作台</h1><p>'+escape(asFault(error).message)+'</p><button class="primary">重新加载</button></div>';root.querySelector('button')!.onclick=()=>location.reload();});
