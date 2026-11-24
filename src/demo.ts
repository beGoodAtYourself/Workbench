import type {Repository,Settings,Note,Entry,FolderOrder,FolderAction,FolderResult} from './types';
import {key,parent,basename,belongs} from './paths';
import {applyFolderOrder} from './folder-tree';
import {pickMarkdownFile} from './note-import';
let demoRevision=0n;
const initial:Record<string,string>={
 '欢迎使用拾页.md':'# 给思绪一个落脚点\n\n笔记是你自己的文件。记录一个念头，整理一段经验，然后继续手上的工作。\n\n## 从这里开始\n\n- 在左侧新建笔记和文件夹\n- 用右上角的 **编辑** 按钮开始书写\n- 把左侧笔记拖进编辑区，建立联系\n\n> 好的笔记不必完整，先把值得留下的事情写下来。\n\n## 连接你的笔记\n\n打开 [使用指南](使用指南.md)，在两个窗格中对照阅读。\n\n### 今日清单\n\n- [x] 留下第一条笔记\n- [ ] 整理一个想法\n- [ ] 记录今天学到的事\n',
 '使用指南.md':'# 让记录更顺手\n\n## 随时打开\n\n使用悬浮入口或 **Ctrl + Alt + Space** 调出桌面工作台。\n\n## 写下并连接\n\n源码编辑支持 Markdown，停止输入后自动保存。把文件树中的笔记拖到编辑区，即可插入相对链接。\n\n编辑时用 **Ctrl + 单击** 打开链接；显示模式中直接单击。\n\n看看 [灵感收集](灵感/灵感收集.md)，继续你的阅读。\n\n| 操作 | 方法 |\n| --- | --- |\n| 保存 | Ctrl + S |\n| 双分屏 | 打开笔记链接 |\n| 回到单栏 | 关闭右窗格 |\n',
 '灵感/灵感收集.md':'# 灵感收集\n\n零散的想法，也值得被看见。\n\n- 为每一次阅读留下一个问题\n- 把复杂的问题拆成一页笔记\n\n[回到起点](../欢迎使用拾页.md)\n'
};
export function demoRepository():Repository{
 let files:Record<string,string>={...initial}, folders=new Set<string>(['灵感']);
 let settings:Settings={root:'演示笔记',shortcut:'Control+Alt+Space',floating:true,floatX:40,floatY:180,session:{module:'notes',panes:[{path:'欢迎使用拾页.md',mode:'preview',cursor:0,scroll:0}],expanded:[]}};
 try {settings={...settings,...JSON.parse(localStorage.getItem('shiye-demo-settings')||'{}')};}catch{}
 if(new URLSearchParams(location.search).has('empty'))settings.root=null;
 const fail=(code:string,message:string):never=>{throw {code,message};};
 const rootId=(root:string)=>key(root).replace(/\/+$/,'');
 const currentRoot=()=>settings.root||fail('workspace','请先选择笔记文件夹。');
 const checkRoot=(root:string)=>{if(rootId(root)!==rootId(currentRoot()))fail('workspace','笔记库已切换，请重新操作。');};
 const relative=(path:string)=>{
  if(path && (/[\\:*?"<>|\u0000-\u001f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part))))fail('boundary','只能操作笔记库内的有效相对路径。');
  return path;
 };
 const syncContent=()=>{
  try{
   const rawFiles=localStorage.getItem('shiye-demo-files'),rawFolders=localStorage.getItem('shiye-demo-folders');
   const nextFiles:unknown=rawFiles===null?{...initial}:JSON.parse(rawFiles),nextFolders:unknown=rawFolders===null?['灵感']:JSON.parse(rawFolders);
   if(!nextFiles||typeof nextFiles!=='object'||Array.isArray(nextFiles)||!Object.entries(nextFiles).every(([p,v])=>typeof v==='string'&&!!relative(p)))throw new Error('files');
   if(!Array.isArray(nextFolders)||!nextFolders.every(p=>typeof p==='string'&&!!relative(p)))throw new Error('folders');
   files=nextFiles as Record<string,string>;folders=new Set(nextFolders);
   for(const path of Object.keys(files)){let p=parent(path);while(p){folders.add(p);p=parent(p);}}
  }catch{fail('io','演示笔记目录读取失败，已保留原有排序。');}
 };
 const persist=()=>{localStorage.setItem('shiye-demo-files',JSON.stringify(files));localStorage.setItem('shiye-demo-folders',JSON.stringify([...folders]));};
 const canonical=(path:string)=>Object.keys(files).find(p=>key(p)===key(path));
 const canonicalFolder=(path:string)=>[...folders].find(p=>key(p)===key(path));
 const resolveFolder=(path:string)=>{relative(path);if(!path)return '';return canonicalFolder(path)??fail('missing','目标文件夹已不存在，请刷新后重试。');};
 const resolveEntry=(path:string):Entry=>{
  relative(path);const directory=canonicalFolder(path),file=canonical(path);
  if(directory)return {path:directory,name:basename(directory),kind:'folder'};
  if(file&&file.toLowerCase().endsWith('.md'))return {path:file,name:basename(file),kind:'note'};
  return fail('missing','目标文件夹或 Markdown 笔记已不存在，请刷新后重试。');
 };
 const entries=(path:string):Entry[]=>{
  const actual=resolveFolder(path),list:Entry[]=[];
  for(const p of folders)if(key(parent(p))===key(actual))list.push({path:p,name:basename(p),kind:'folder'});
  for(const p of Object.keys(files))if(key(parent(p))===key(actual)&&p.toLowerCase().endsWith('.md'))list.push({path:p,name:basename(p),kind:'note'});
  return applyFolderOrder(list);
 };
 const orderKey=()=>`shiye-demo-folder-order:${encodeURIComponent(rootId(currentRoot()))}`;
 const maxOrderBytes=1024*1024;
 let order:FolderOrder|undefined,orderBlocked=false,pending=false,orderBaseline:string|null=null;
 const copyOrder=():FolderOrder=>({root:order!.root,revision:order!.revision,parents:Object.fromEntries(Object.entries(order!.parents).map(([p,items])=>[p,[...items]])),...(order!.warning?{warning:order!.warning}:{})});
 const loadOrder=()=>{
  if(order)return;
  const root=currentRoot();order={root,revision:String(++demoRevision),parents:{}};orderBlocked=false;pending=false;orderBaseline=null;
  try{
   const raw=localStorage.getItem(orderKey());if(raw===null)return;
   if(new TextEncoder().encode(raw).length>maxOrderBytes)throw new Error('size');
   const value=JSON.parse(raw);
   if(value?.version!==1||value.root!==rootId(root)||typeof value.revision!=='string'||!/^\d+$/.test(value.revision)||!value.parents||typeof value.parents!=='object'||Array.isArray(value.parents))throw new Error('schema');
   const seen=new Set<string>();
   for(const [p,items] of Object.entries(value.parents)){
    relative(p);if(seen.has(key(p))||!Array.isArray(items))throw new Error('parent');seen.add(key(p));
    const children=new Set<string>();
    for(const child of items){if(typeof child!=='string'||!relative(child)||key(parent(child))!==key(p)||children.has(key(child)))throw new Error('child');children.add(key(child));}
   }
   demoRevision=demoRevision>BigInt(value.revision)?demoRevision:BigInt(value.revision);
   order={root,revision:String(++demoRevision),parents:value.parents};orderBaseline=raw;
  }catch{orderBlocked=true;order.warning='列表顺序读取失败，暂用默认排序。原记录已保留，修复后可重试。';}
 };
 const orderParent=(path:string)=>Object.keys(order!.parents).find(p=>key(p)===key(path));
 const savedSequence=(path:string)=>{const saved=orderParent(path);return saved===undefined?undefined:order!.parents[saved];};
 const orderedEntries=(path:string)=>applyFolderOrder(entries(path),savedSequence(path));
 const writeOrder=(next:FolderOrder)=>{
  if(orderBlocked)fail('order',order!.warning!);
  const raw=JSON.stringify({version:1,root:rootId(next.root),revision:next.revision,parents:next.parents});
  if(new TextEncoder().encode(raw).length>maxOrderBytes)fail('order','列表顺序超过 1 MiB 上限，原记录已保留。');
  let actual:string|null=null;
  try{actual=localStorage.getItem(orderKey());}catch{fail('order','列表顺序未能读取，请重试。');}
  if(actual!==orderBaseline)fail('stale','磁盘中的列表顺序记录已改变，请重新打开笔记库后再操作。');
  try{localStorage.setItem(orderKey(),raw);}catch{fail('order','列表顺序未能保存，请重试。');}
  orderBaseline=raw;
 };
 const commitOrder=(parents:Record<string,string[]>,pure:boolean)=>{
  const next:FolderOrder={root:currentRoot(),revision:String(++demoRevision),parents};
  try{writeOrder(next);order=next;pending=false;}
  catch(error){
   if(pure)throw error;
   next.warning='文件操作已完成，但列表顺序未保存。请重试保存顺序。';order=next;pending=true;
  }
 };
 const reconcile=(path:string,list:Entry[])=>{
  const parents=copyOrder().parents,saved=orderParent(path),actual=new Set(list.filter(item=>item.kind==='folder').map(item=>key(item.path)));
  if(saved!==undefined)parents[saved]=applyFolderOrder(list,order!.parents[saved]).map(item=>item.path);
  // A successful listing also proves a missing direct child and its subtree are gone.
  for(const p of Object.keys(parents))if(key(p)!==key(path)&&(!path||belongs(p,path))){
   const child=(path?path+'/':'')+(path?p.slice(path.length+1):p).split('/')[0];
   if(!actual.has(key(child)))delete parents[p];
  }
  if(JSON.stringify(parents)!==JSON.stringify(order!.parents))commitOrder(parents,false);
 };
 const mappedOrders=(source:string,next:string):Record<string,string[]>=>{
  const map=(path:string)=>belongs(path,source)?next+path.slice(source.length):path;
  // A destination may have stale preferences after external deletion. It must not
  // steal the source rank or overwrite migrated descendants; case-only renames keep it.
  const original=key(source)===key(next)?Object.entries(order!.parents):Object.entries(order!.parents)
   .filter(([p])=>!belongs(p,next)).map(([p,items])=>[p,items.filter(item=>!belongs(item,next))] as const);
  return Object.fromEntries(original.map(([p,items])=>[map(p),items.map(map)]));
 };
 const read=async(path:string):Promise<Note>=>{
  currentRoot();relative(path);syncContent();
  const p=canonical(path);if(!p)throw {code:'missing',message:'目标笔记已不存在。'};
  return {path:p,text:files[p],version:files[p],size:new TextEncoder().encode(files[p]).length};
 };
 const validate=(name:string)=>{if(!name||/[\\/:*?"<>|\u0000-\u001f]/.test(name)||/[. ]$/.test(name))throw {code:'name',message:'请输入有效名称。'};};
 const moveContent=(source:string,next:string)=>{
  const previousFiles=files,previousFolders=folders;
  files=Object.fromEntries(Object.entries(files).map(([p,text])=>[belongs(p,source)?next+p.slice(source.length):p,text]));
  folders=new Set([...folders].map(p=>belongs(p,source)?next+p.slice(source.length):p));
  try{persist();}catch{files=previousFiles;folders=previousFolders;fail('io','文件操作未能保存，请重试。');}
 };
 const arrange=async(action:FolderAction):Promise<FolderResult>=>{
  checkRoot(action.root);loadOrder();if(action.revision!==order!.revision)fail('stale','列表顺序已变化，请刷新后重试。');
  syncContent();const destination=resolveFolder(action.parent);
  if(action.placement==='reset'){
   if(action.source||action.anchor)fail('boundary','恢复排序的参数无效。');
   const saved=orderParent(destination);
   if(saved!==undefined){const parents=copyOrder().parents;delete parents[saved];commitOrder(parents,true);}
   return {path:destination,moved:false,order:copyOrder()};
  }
  if(!action.source)fail('boundary','不能移动笔记库根目录。');
  const entry=resolveEntry(action.source),source=entry.path,sourceParent=parent(source);
  if(entry.kind==='folder'&&belongs(destination,source))fail('boundary','不能把文件夹移入自身或后代。');
  let anchor:string|undefined;
  if(action.placement==='before'||action.placement==='after'){
   if(!action.anchor)fail('missing','插入位置已失效，请重新选择。');
   const target=resolveEntry(action.anchor!);anchor=target.path;
   if(target.kind!==entry.kind)fail('order','只能在同类项目之间调整顺序。');
   if(key(parent(anchor))!==key(destination)||key(anchor)===key(source))fail('stale','插入位置已变化，请重新选择。');
  }else if(action.placement!=='inside'||action.anchor)fail('boundary','落点无效。');
  const moved=key(sourceParent)!==key(destination),next=(destination?destination+'/':'')+basename(source);
  if(!moved&&action.placement==='inside')return {path:source,moved:false,order:copyOrder()};
  if(moved&&(canonical(next)||canonicalFolder(next)))fail('exists','目标已有同名项目，无法移动。');
  const before=orderedEntries(destination),group=before.filter(item=>item.kind===entry.kind&&key(item.path)!==key(source)).map(item=>item.path);
  const index=anchor===undefined?group.length:group.findIndex(p=>key(p)===key(anchor));
  if(index<0)fail('stale','插入位置已变化，请重新选择。');
  group.splice(index+(action.placement==='after'?1:0),0,moved?next:source);
  const others=before.filter(item=>item.kind!==entry.kind).map(item=>item.path),after=entry.kind==='folder'?[...group,...others]:[...others,...group];
  if(!moved&&JSON.stringify(before.map(item=>item.path))===JSON.stringify(after))return {path:source,moved:false,order:copyOrder()};
  if(!moved){commitOrder({...copyOrder().parents,[orderParent(destination)??destination]:after},true);return {path:source,moved:false,order:copyOrder()};}
  const parents=mappedOrders(source,next),sourceKey=orderParent(sourceParent);
  if(sourceKey!==undefined)parents[sourceKey]=parents[sourceKey].filter(p=>key(p)!==key(next));
  parents[orderParent(destination)??destination]=after;
  moveContent(source,next);commitOrder(parents,false);
  return {path:next,moved:true,order:copyOrder(),...(order!.warning?{warning:order!.warning}:{})};
 };
 return {
  settings:async()=>settings,workspace:async root=>{settings={...settings,root,session:{module:'notes',panes:[],expanded:[]}};order=undefined;localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));return settings;},
  autostart:async()=>({state:'unavailable',target:null,revision:null,message:'开机自启动仅 Windows 桌面版可用，浏览器预览无法注册系统启动项。'}),
  list:async root=>{
   currentRoot();syncContent();const actual=resolveFolder(root),list=entries(actual);loadOrder();reconcile(actual,list);return applyFolderOrder(list,savedSequence(actual));
  },
  folderOrder:async()=>{loadOrder();return copyOrder();},arrangeFolder:arrange,
  retryFolderOrder:async root=>{
   checkRoot(root);loadOrder();
   if(orderBlocked){
    const previous=copyOrder(),hadPending=pending;order=undefined;loadOrder();
    if(orderBlocked){const warning=order!.warning!;order=previous;pending=hadPending;fail('order',warning);}
    if(hadPending){
     if(Object.keys(order!.parents).length&&JSON.stringify(order!.parents)!==JSON.stringify(previous.parents)){order=previous;pending=true;orderBlocked=true;fail('stale','修复后的顺序记录与待保存顺序不同，请重新打开笔记库。');}
     commitOrder(previous.parents,true);
    }
    return copyOrder();
   }
   writeOrder(order!);delete order!.warning;pending=false;return copyOrder();
  },
  read,
  save:async(path,text,version)=>{const note=await read(path);if(note.version!==version)throw {code:'conflict',message:'磁盘内容已变化，请先处理冲突。'};files[note.path]=text;persist();return text;},
  create:async(root,input,folder)=>{
   currentRoot();syncContent();validate(input);const actual=resolveFolder(root);
   const name=folder||input.toLowerCase().endsWith('.md')?input:input+'.md';const path=(actual?actual+'/':'')+name;
   if(canonical(path)||canonicalFolder(path))throw {code:'exists',message:'同名项目已存在。'};
   if(folder)folders.add(path);else files[path]='';persist();loadOrder();reconcile(actual,entries(actual));return path;
  },
  importMarkdown: async destination => {
    const workspace = currentRoot();
    const selected = await pickMarkdownFile();
    if (!selected) {
      return null;
    }
    validate(selected.name);
    if (!selected.name.toLowerCase().endsWith('.md')) {
      return fail('type', '请选择 Markdown（.md）文件。');
    }
    if (selected.name.toLowerCase().startsWith('.shiye-')) {
      return fail('name', '文件名使用了内部保留前缀，请重命名后导入。');
    }
    if (selected.size > 64 * 1024 * 1024) {
      return fail('large-limit', '笔记超过 64 MiB，无法导入。');
    }
    const bytes = await selected.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/\r\n/g, '\n');
    } catch {
      return fail('encoding', '文件不是有效 UTF-8；请先转换编码后再导入。');
    }

    checkRoot(workspace);
    syncContent();
    const directory = resolveFolder(destination);
    for (let index = 0; index < 10_000; index++) {
      const name = index === 0
        ? selected.name
        : selected.name.slice(0, -3) + ' (' + index + ')' + selected.name.slice(-3);
      validate(name);
      const path = (directory ? directory + '/' : '') + name;
      if (canonical(path) || canonicalFolder(path)) {
        continue;
      }
      files[path] = text;
      try {
        persist();
      } catch {
        delete files[path];
        return fail('io', '导入未能保存，示例存储可能已满，请释放空间后重试。');
      }
      return path;
    }
    return fail('exists', '同名文件过多，请重命名后再导入。');
  },
  rename:async(path,input)=>{
   currentRoot();syncContent();relative(path);validate(input);if(!path)fail('boundary','不能重命名笔记库根目录。');
   const isFolder=!!canonicalFolder(path),source=canonicalFolder(path)??canonical(path)??fail('missing','项目已不存在。');
   const name=isFolder||input.toLowerCase().endsWith('.md')?input:input+'.md',next=(parent(source)?parent(source)+'/':'')+name;
   if(next===source)return source;
   if(key(next)!==key(source)&&(canonical(next)||canonicalFolder(next)))throw {code:'exists',message:'同名项目已存在。'};
   loadOrder();const parents=mappedOrders(source,next);moveContent(source,next);
   if(JSON.stringify(parents)!==JSON.stringify(order!.parents))commitOrder(parents,false);return next;
  },
  recycle:async path=>{
   currentRoot();syncContent();relative(path);if(!path)fail('boundary','不能回收笔记库根目录。');
   const source=canonicalFolder(path)??canonical(path)??fail('missing','项目已不存在。');loadOrder();
   for(const p of Object.keys(files))if(belongs(p,source))delete files[p];folders=new Set([...folders].filter(p=>!belongs(p,source)));persist();
   const parents=Object.fromEntries(Object.entries(order!.parents).filter(([p])=>!belongs(p,source)).map(([p,items])=>[p,items.filter(item=>!belongs(item,source))]));
   if(JSON.stringify(parents)!==JSON.stringify(order!.parents))commitOrder(parents,false);
  },
  image:async()=>{throw {code:'image',message:'预览模式不读取本地图片。'};},
  configure:async(shortcut,floating,autostart)=>{if(autostart)fail('autostart','开机自启动仅 Windows 桌面版可用。');settings={...settings,shortcut,floating};localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));return settings;},
  snapshot:async session=>{settings.session=session;localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));},
  clipboard:async()=>({status:'text',text:'在这里查看当前复制的文字。\n\n桌面版会读取系统剪贴板；浏览器预览仅展示此示例。',truncated:false}),
  watchClipboard:async()=>{},
  external:async url=>{window.open(url,'_blank','noopener,noreferrer');},
  hide:async()=>{document.dispatchEvent(new CustomEvent('demo-hidden'));},exit:async()=>{}
 };
}
