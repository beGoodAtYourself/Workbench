import './style.css';
import {repository,pickDirectory,subscribe,desktop} from './bridge';
import {Workbench,Document} from './model';
import {asFault,type Settings,type Entry} from './types';
import {basename,parent,key,belongs,resolveLink,slug} from './paths';
import {preview,escape} from './markdown';

const shapes:Record<string,string>={
 note:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
 folder:'M3 6h7l2 2h9v12H3z',
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
 let settings:Settings=await repo.settings();
 const model=new Workbench(repo,async message=>(await ask('打开较大的笔记',message,undefined,'继续加载'))!==null);
 let module:'notes'|'clipboard'=settings.session.module==='clipboard'?'clipboard':'notes';
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
 let dragging:{path:string;kind:Entry['kind'];x:number;y:number;pointer:number;moved:boolean}|null=null;
 let suppressTreeClick=false;
 const ghost=document.createElement('div');ghost.className='drag-ghost';ghost.hidden=true;document.body.append(ghost);
 function task(action:()=>Promise<unknown>){void action().catch(e=>notify(asFault(e).message));}
 async function freeze<T>(action:()=>Promise<T>):Promise<T>{const previous=root.inert;root.inert=true;try{return await action();}finally{root.inert=previous;}}
 function checkpoint(){clearTimeout(snapshotTimer);snapshotTimer=setTimeout(()=>task(saveSession),350);}
 async function saveSession(){await repo.snapshot({module,panes:model.records(),expanded:[...expanded].slice(0,300)});}
 function disposePanes(){renderEpoch++;paneDisposers.forEach(dispose=>dispose());paneDisposers=[];editors.clear();}
 root.innerHTML='<header class="app-header"><div class="brand"><span class="brand-symbol">'+icon('note')+'</span><strong>拾页</strong><span class="brand-caption">个人工作台</span></div><nav class="navigation" aria-label="工作台模块"><button id="nav-notes">'+icon('note')+'笔记管理</button><button id="nav-clipboard">'+icon('clip')+'剪贴板</button></nav><div class="header-tools"><span class="local-badge"><i></i>'+(desktop?'只在本地':'浏览器预览 · 示例数据')+'</span>'+button('settings','设置','settings')+button('hide','隐藏工作台','hide')+'</div></header><div class="app-body"><aside class="sidebar"><div class="workspace-heading"><span class="eyebrow">我的空间</span>'+button('choose-root','选择笔记文件夹','folder')+'</div><button id="workspace-name" class="workspace-name"></button><div class="tree-toolbar">'+button('new-note','新建笔记','plus','primary text-button')+button('new-folder','新建文件夹','folder')+button('refresh','刷新文件列表','refresh')+button('more','更多文件操作','more')+'</div><div class="section-label"><span>文件夹与笔记</span><span id="entry-count"></span></div><div id="tree" role="tree" aria-label="笔记文件树" tabindex="0"><div id="tree-space"></div></div><footer class="sidebar-footer"><span class="status-dot"></span><span id="root-status">选择本地文件夹</span></footer></aside><main class="main-area"><div id="workspace-bar"><span>'+icon('folder')+'<span id="breadcrumb">我的笔记</span></span><span class="reading-hint">'+icon('split')+'最多双分屏</span></div><div id="panes"></div><section id="clipboard" hidden></section></main></div><footer class="app-footer"><span id="footer-message">把值得留下的事情，写在这里。</span><span><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd> <span class="muted">随时调出</span></span></footer>';
 const tree=document.getElementById('tree')!;
 function updateShell(){
  document.getElementById('nav-notes')!.classList.toggle('selected',module==='notes');
  document.getElementById('nav-clipboard')!.classList.toggle('selected',module==='clipboard');
  document.querySelector('.sidebar')!.classList.toggle('muted-sidebar',module==='clipboard');
  const name=document.getElementById('workspace-name')!;name.textContent=settings.root?basename(settings.root.replaceAll('\\','/')):'选择笔记文件夹';name.title=settings.root||'选择一个文件夹，开始记录';
  document.getElementById('root-status')!.textContent=settings.root?'本地文件夹 · 已连接':'尚未选择笔记文件夹';
  document.getElementById('breadcrumb')!.textContent=module==='notes'?'我的笔记':'剪贴板';
  document.querySelector('.reading-hint')!.classList.toggle('invisible',module!=='notes');
  document.getElementById('panes')!.hidden=module!=='notes';
  document.getElementById('clipboard')!.hidden=module!=='clipboard';
  document.querySelector('.app-footer>span:last-child')!.innerHTML=settings.shortcut.split('+').map(part=>'<kbd>'+escape(part.replace('Control','Ctrl'))+'</kbd>').join(' + ')+' <span class="muted">随时调出</span>';
 }
 function flatten(){
  rows=[];const visit=(path:string,depth:number)=>{for(const entry of directories.get(path)||[]){rows.push({...entry,depth});if(entry.kind==='folder'&&expanded.has(entry.path))visit(entry.path,depth+1);}};visit('',0);
  document.getElementById('entry-count')!.textContent=String(rows.filter(e=>e.kind==='note').length);renderTree();
 }
 function renderTree(){
  if(dragging)return;
  const space=document.getElementById('tree-space')!;space.style.height=Math.max(rows.length*34,64)+'px';
  if(!settings.root){space.innerHTML='<p class="tree-empty">你的笔记，存放在你选择的文件夹里。</p>';return;}
  if(!rows.length){space.innerHTML='<p class="tree-empty">文件夹还是空的<br>新建一篇笔记，开始记录。</p>';return;}
  const start=Math.max(0,Math.floor(tree.scrollTop/34)-6),end=Math.min(rows.length,start+Math.ceil(tree.clientHeight/34)+14);
  space.innerHTML=rows.slice(start,end).map((entry,i)=>{
   const active=selected?key(selected.path)===key(entry.path):model.panes.some(d=>key(d.path)===key(entry.path));
   return '<div class="tree-row'+(active?' active':'')+'" role="treeitem" aria-selected="'+active+'"'+(entry.kind==='folder'?' aria-expanded="'+expanded.has(entry.path)+'"':'')+' data-row="'+(start+i)+'" tabindex="-1" draggable="false" style="top:'+((start+i)*34)+'px;padding-left:'+(12+entry.depth*16)+'px" title="'+escape(entry.path)+'"><span class="tree-chevron '+(expanded.has(entry.path)?'expanded':'')+'">'+(entry.kind==='folder'?icon('chevron'):'')+'</span><span class="tree-file-icon '+entry.kind+'">'+icon(entry.kind==='folder'?'folder':'note')+'</span><span class="tree-label">'+escape(entry.name.replace(/\.md$/i,''))+'</span>'+(entry.kind==='note'?'<span class="file-extension">md</span>':'')+'</div>';
  }).join('');
 }
 async function refreshTree(){
  if(!settings.root)return;
  const epoch=++treeEpoch;
  try{
   const top=await repo.list('');if(epoch!==treeEpoch)return;directories.set('',top);
   for(const path of [...expanded]){try{const entries=await repo.list(path);if(epoch!==treeEpoch)return;directories.set(path,entries);}catch{expanded.delete(path);directories.delete(path);}}
   document.getElementById('root-status')!.textContent='本地文件夹 · 已连接';flatten();
  }catch(e){if(epoch===treeEpoch){document.getElementById('root-status')!.textContent='文件夹不可访问';notify(asFault(e).message);}}
 }
 tree.addEventListener('scroll',renderTree,{passive:true});
 new ResizeObserver(renderTree).observe(tree);
 function rowAt(target:EventTarget|null){const row=(target as Element|null)?.closest<HTMLElement>('[data-row]');return row?rows[Number(row.dataset.row)]:undefined;}
 tree.addEventListener('click',event=>{if(suppressTreeClick){suppressTreeClick=false;event.preventDefault();return;}const entry=rowAt(event.target);if(!entry)return;selected=entry;renderTree();task(async()=>{
  if(entry.kind==='folder'){
   if(expanded.has(entry.path)){expanded.delete(entry.path);for(const p of [...directories.keys()])if(belongs(p,entry.path))directories.delete(p);for(const p of [...expanded])if(belongs(p,entry.path))expanded.delete(p);}
   else{if(expanded.size>=300){notify('已展开较多文件夹，请先折叠部分目录。');return;}const entries=await repo.list(entry.path);expanded.add(entry.path);directories.set(entry.path,entries);}flatten();checkpoint();
  }else{if(module!=='notes')await switchModule('notes');await model.select(entry.path);}
 });});
 tree.addEventListener('pointerdown',event=>{const entry=rowAt(event.target);if(event.button===0&&entry){dragging={path:entry.path,kind:entry.kind,x:event.clientX,y:event.clientY,pointer:event.pointerId,moved:false};}});
 window.addEventListener('pointermove',event=>{if(!dragging||event.pointerId!==dragging.pointer)return;
  if(!dragging.moved&&Math.hypot(event.clientX-dragging.x,event.clientY-dragging.y)>5){dragging.moved=true;tree.setPointerCapture(event.pointerId);ghost.textContent=basename(dragging.path)+(dragging.kind==='note'?' · 插入链接':' · 文件夹不能插入链接');ghost.hidden=false;}
  if(dragging.moved){ghost.style.left=(event.clientX+14)+'px';ghost.style.top=(event.clientY+14)+'px';}
 });
 function finishDrag(event:PointerEvent,cancel=false){if(!dragging||dragging.pointer!==event.pointerId)return;const current=dragging;
  if(current.moved&&!cancel){suppressTreeClick=true;const target=document.elementFromPoint(event.clientX,event.clientY);const found=[...editors.values()].find(editor=>target&&editor.view.dom.contains(target));if(current.kind==='folder')notify('文件夹不能插入链接，请拖动一篇 Markdown 笔记。');else if(found)found.insertLink(current.path,event.clientX,event.clientY);else notify('请将笔记拖入编辑模式中的正文区域。');}
  dragging=null;ghost.hidden=true;if(tree.hasPointerCapture(event.pointerId))tree.releasePointerCapture(event.pointerId);if(current.moved){renderTree();setTimeout(()=>{suppressTreeClick=false;},0);}
 }
 window.addEventListener('pointerup',event=>finishDrag(event));window.addEventListener('pointercancel',event=>finishDrag(event,true));
 tree.addEventListener('contextmenu',event=>{event.preventDefault();const entry=rowAt(event.target);if(entry){selected=entry;renderTree();showMenu(event.clientX,event.clientY);}});
 tree.addEventListener('keydown',event=>{if(event.key==='F2'){event.preventDefault();task(rename);}if(event.key==='Delete'){event.preventDefault();task(recycle);}});
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
 model.onChange=layout=>{if(layout){lastRender=renderPanes();checkpoint();}else updateStatus();};
 async function chooseRoot(){
  await freeze(async()=>{
  await model.flushAll();const path=await pickDirectory();if(!path)return;await model.flushAll();
  clearTimeout(snapshotTimer);const next=await repo.workspace(path);await model.clear();settings=next;expanded.clear();directories.clear();selected=null;module='notes';updateShell();await refreshTree();await renderPanes();checkpoint();
  });
 }
 function selectedParent(){return selected?.kind==='folder'?selected.path:selected?parent(selected.path):'';}
 async function create(folder:boolean){
  if(!settings.root){await chooseRoot();if(!settings.root)return;}
  const inFolder=selectedParent();const name=await ask(folder?'新建文件夹':'新建笔记','保存位置：'+(inFolder||'笔记根目录'),folder?'新建文件夹':'未命名笔记',folder?'创建文件夹':'创建笔记');if(!name)return;
  const path=await repo.create(inFolder,name,folder);if(inFolder)expanded.add(inFolder);
  selected={path,name:basename(path),kind:folder?'folder':'note'};await refreshTree();
  if(!folder){if(module!=='notes')await switchModule('notes');await model.select(path,'edit');}else{expanded.add(path);directories.set(path,[]);flatten();}
 }
 async function rename(){
  if(!selected){notify('请先在文件树中选择一个项目。');return;}const target=selected;
  const name=await ask('重命名','已有笔记中的相对链接不会自动改写；重命名后可能需要手动修复。',target.name,'重命名');if(!name)return;
  await freeze(async()=>{await model.flushAll();const next=await repo.rename(target.path,name);model.remap(target.path,next);
  expanded=new Set([...expanded].map(p=>belongs(p,target.path)?next+p.slice(target.path.length):p));
  selected={path:next,name:basename(next),kind:target.kind};directories.clear();await refreshTree();checkpoint();});
 }
 async function recycle(){
  if(!selected){notify('请先选择要移至回收站的项目。');return;}const target=selected;
  if(!await ask('移至回收站','将“'+target.name+'”'+(target.kind==='folder'?'及其所有内容':'')+'移至系统回收站？',undefined,'移至回收站'))return;
  await freeze(async()=>{await model.flushAll();await repo.recycle(target.path);model.remove(target.path);for(const p of [...expanded])if(belongs(p,target.path))expanded.delete(p);selected=null;directories.clear();await refreshTree();checkpoint();});
 }
 function showMenu(x:number,y:number){
  document.querySelector('.context-menu')?.remove();const menu=document.createElement('div');menu.className='context-menu';menu.style.left=Math.min(x,window.innerWidth-190)+'px';menu.style.top=Math.min(y,window.innerHeight-180)+'px';menu.innerHTML='<button data-action="note">新建笔记</button><button data-action="folder">新建文件夹</button><hr><button data-action="rename">重命名</button><button data-action="delete" class="danger">移至回收站</button>';document.body.append(menu);
  menu.addEventListener('click',event=>{const action=(event.target as HTMLElement).dataset.action;menu.remove();if(action==='note')task(()=>create(false));if(action==='folder')task(()=>create(true));if(action==='rename')task(rename);if(action==='delete')task(recycle);});
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
 async function switchModule(next:'notes'|'clipboard'){
  if(switching||root.inert||next===module)return;switching=true;root.inert=true;
  try{await model.flushAll();clipEpoch++;clipboardChunks=[];await repo.watchClipboard(false);document.getElementById('clipboard')!.replaceChildren();disposePanes();module=next;updateShell();if(module==='notes')await renderPanes();else await renderClipboard();await saveSession();}
  finally{switching=false;root.inert=false;}
 }
 async function hide(exit=false){
  if(switching||root.inert||document.querySelector('dialog[open]'))return;switching=true;root.inert=true;
  try{await model.flushAll();disposePanes();await saveSession();clipEpoch++;clipboardChunks=[];await repo.watchClipboard(false);document.getElementById('clipboard')!.replaceChildren();hidden=true;if(exit)await repo.exit();else await repo.hide();if(!desktop){hidden=false;notify('桌面版会隐藏到悬浮入口。');await restored();}}
  catch(e){hidden=false;if(module==='notes')await renderPanes();else await renderClipboard();throw e;}
  finally{switching=false;root.inert=false;}
 }
 async function restored(){
  hidden=false;if(module==='clipboard')await renderClipboard();else{await model.refresh();await renderPanes();}await refreshTree();await ready();
 }
 async function ready(){if(desktop){await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));const {invoke}=await import('@tauri-apps/api/core');await invoke('frontend_ready');}}
 async function configure(){
  settings=await repo.settings();
  const dialog=document.createElement('dialog');dialog.className='modal';
  dialog.innerHTML='<form><div class="modal-kicker">按你的习惯来</div><h2>工作台设置</h2><label class="field-label">全局快捷键<input name="shortcut" value="'+escape(settings.shortcut)+'" required placeholder="Control+Alt+Space"></label><p class="input-help">例如 Control+Alt+Space。若组合键被占用，会保留原有设置。</p><label class="check-row"><input name="floating" type="checkbox" '+(settings.floating?'checked':'')+'>显示桌面悬浮入口</label><div class="settings-folder"><small>笔记存放位置</small><p>'+escape(settings.root||'尚未选择')+'</p><button type="button" id="settings-folder" class="secondary">更换文件夹</button></div><p class="form-error" role="alert"></p><div class="modal-actions"><button type="button" class="secondary" id="settings-exit">退出拾页</button><span></span><button type="button" class="secondary" id="settings-cancel">取消</button><button class="primary" type="submit">保存设置</button></div></form>';
  document.body.append(dialog);dialog.showModal();
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.querySelector('#settings-cancel')!.addEventListener('click',()=>dialog.close());
  dialog.querySelector('#settings-exit')!.addEventListener('click',()=>{dialog.close();task(()=>hide(true));});
  dialog.querySelector('#settings-folder')!.addEventListener('click',()=>{dialog.close();task(chooseRoot);});
  dialog.querySelector('form')!.onsubmit=async event=>{event.preventDefault();const shortcut=dialog.querySelector<HTMLInputElement>('[name="shortcut"]')!.value.trim(),floating=dialog.querySelector<HTMLInputElement>('[name="floating"]')!.checked;
   try{settings=await repo.configure(shortcut,floating);dialog.close();updateShell();notify('设置已保存。');}catch(e){dialog.querySelector('.form-error')!.textContent=asFault(e).message;}
  };
 }
 document.getElementById('nav-notes')!.onclick=()=>task(()=>switchModule('notes'));
 document.getElementById('nav-clipboard')!.onclick=()=>task(()=>switchModule('clipboard'));
 for(const id of ['choose-root','workspace-name'])document.getElementById(id)!.onclick=()=>task(chooseRoot);
 document.getElementById('new-note')!.onclick=()=>task(()=>create(false));
 document.getElementById('new-folder')!.onclick=()=>task(()=>create(true));
 document.getElementById('refresh')!.onclick=()=>task(async()=>{await refreshTree();await model.refresh();});
 document.getElementById('more')!.onclick=event=>showMenu((event.currentTarget as HTMLElement).getBoundingClientRect().left,160);
 document.getElementById('settings')!.onclick=()=>task(configure);
 document.getElementById('hide')!.onclick=()=>task(()=>hide());
 window.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();const doc=model.current();if(doc)task(()=>model.flush(doc));}});
 const refresh=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>{if(!hidden&&!document.querySelector('dialog[open]'))task(async()=>{await model.refresh();await refreshTree();});},250);};
 await subscribe('refresh-files',refresh);await subscribe('restored',()=>task(restored));
 await subscribe('request-hide',()=>task(()=>hide()));await subscribe('request-exit',()=>task(()=>hide(true)));
 await subscribe('clipboard-changed',()=>{if(module==='clipboard'&&!hidden)task(readClipboard);});
 await subscribe('settings-changed',()=>task(async()=>{settings=await repo.settings();updateShell();}));
 window.addEventListener('focus',refresh);
 document.addEventListener('visibilitychange',()=>{if(module==='clipboard')task(async()=>{if(document.hidden){clipEpoch++;clipboardChunks=[];await repo.watchClipboard(false);document.getElementById('clip-text')?.replaceChildren();}else if(!hidden){await repo.watchClipboard(true);await readClipboard();}});});
 updateShell();
 if(settings.root){
  await refreshTree();
  for(const record of settings.session.panes.slice(0,2)){
   try{const doc=await model.load(record.path);if(!model.panes.some(d=>key(d.path)===key(doc.path))){doc.mode=record.mode==='edit'?'edit':'preview';doc.cursor=record.cursor;doc.scroll=record.scroll;model.panes.push(doc);}}catch(e){notify(asFault(e).message);}
  }
 }
 if(module==='notes')await renderPanes();else await renderClipboard();
 if(settings.startupError)notify(settings.startupError);
 await ready();
}
void main().catch(error=>{root.innerHTML='<div class="startup-error"><h1>暂时无法打开工作台</h1><p>'+escape(asFault(error).message)+'</p><button class="primary">重新加载</button></div>';root.querySelector('button')!.onclick=()=>location.reload();});
