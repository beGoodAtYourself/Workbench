import type {Repository,Settings,Note,Entry} from './types';
import {key,parent,basename,belongs} from './paths';
const initial:Record<string,string>={
 '欢迎使用拾页.md':'# 给思绪一个落脚点\n\n笔记是你自己的文件。记录一个念头，整理一段经验，然后继续手上的工作。\n\n## 从这里开始\n\n- 在左侧新建笔记和文件夹\n- 用右上角的 **编辑** 按钮开始书写\n- 把左侧笔记拖进编辑区，建立联系\n\n> 好的笔记不必完整，先把值得留下的事情写下来。\n\n## 连接你的笔记\n\n打开 [使用指南](使用指南.md)，在两个窗格中对照阅读。\n\n### 今日清单\n\n- [x] 留下第一条笔记\n- [ ] 整理一个想法\n- [ ] 记录今天学到的事\n',
 '使用指南.md':'# 让记录更顺手\n\n## 随时打开\n\n使用悬浮入口或 **Ctrl + Alt + Space** 调出桌面工作台。\n\n## 写下并连接\n\n源码编辑支持 Markdown，停止输入后自动保存。把文件树中的笔记拖到编辑区，即可插入相对链接。\n\n编辑时用 **Ctrl + 单击** 打开链接；显示模式中直接单击。\n\n看看 [灵感收集](灵感/灵感收集.md)，继续你的阅读。\n\n| 操作 | 方法 |\n| --- | --- |\n| 保存 | Ctrl + S |\n| 双分屏 | 打开笔记链接 |\n| 回到单栏 | 关闭右窗格 |\n',
 '灵感/灵感收集.md':'# 灵感收集\n\n零散的想法，也值得被看见。\n\n- 为每一次阅读留下一个问题\n- 把复杂的问题拆成一页笔记\n\n[回到起点](../欢迎使用拾页.md)\n'
};
export function demoRepository():Repository{
 let files:Record<string,string>;
 let folders=new Set<string>(['灵感']);
 try {files=JSON.parse(localStorage.getItem('shiye-demo-files')||'null')||{...initial};}catch{files={...initial};}
 let settings:Settings={root:'演示笔记',shortcut:'Control+Alt+Space',floating:true,floatX:40,floatY:180,session:{module:'notes',panes:[{path:'欢迎使用拾页.md',mode:'preview',cursor:0,scroll:0}],expanded:[]}};
 try {settings={...settings,...JSON.parse(localStorage.getItem('shiye-demo-settings')||'{}')};}catch{}
 if(new URLSearchParams(location.search).has('empty'))settings.root=null;
 const persist=()=>localStorage.setItem('shiye-demo-files',JSON.stringify(files));
 const canonical=(path:string)=>Object.keys(files).find(p=>key(p)===key(path));
 const read=async(path:string):Promise<Note>=>{
  const p=canonical(path);if(!p)throw {code:'missing',message:'目标笔记已不存在。'};
  return {path:p,text:files[p],version:files[p],size:new TextEncoder().encode(files[p]).length};
 };
 const validate=(name:string)=>{if(!name||/[\\/:*?"<>|]/.test(name)||/[. ]$/.test(name))throw {code:'name',message:'请输入有效名称。'};};
 return {
  settings:async()=>settings,workspace:async root=>{settings.root=root;return settings;},
  list:async root=>{
   const list:Entry[]=[];
   for(const path of Object.keys(files)){let current=parent(path);while(current){folders.add(current);current=parent(current);}if(parent(path)===root)list.push({path,name:basename(path),kind:'note'});}
   for(const path of folders)if(parent(path)===root)list.push({path,name:basename(path),kind:'folder'});
   return list.sort((a,b)=>a.kind.localeCompare(b.kind)||a.name.localeCompare(b.name,'zh-CN'));
  },
  read,
  save:async(path,text,version)=>{const note=await read(path);if(note.version!==version)throw {code:'conflict',message:'磁盘内容已变化，请先处理冲突。'};files[note.path]=text;persist();return text;},
  create:async(root,input,folder)=>{
   validate(input);const name=folder||input.toLowerCase().endsWith('.md')?input:input+'.md';const path=(root?root+'/':'')+name;
   if(canonical(path)||folders.has(path))throw {code:'exists',message:'同名项目已存在。'};
   if(folder)folders.add(path);else files[path]='';persist();return path;
  },
  rename:async(path,input)=>{validate(input);const isFolder=folders.has(path);const name=isFolder||input.toLowerCase().endsWith('.md')?input:input+'.md';const next=(parent(path)?parent(path)+'/':'')+name;if(canonical(next)||folders.has(next))throw {code:'exists',message:'同名项目已存在。'};
   for(const p of Object.keys(files))if(belongs(p,path)){files[next+p.slice(path.length)]=files[p];delete files[p];}
   folders=new Set([...folders].map(p=>belongs(p,path)?next+p.slice(path.length):p));persist();return next;
  },
  recycle:async path=>{for(const p of Object.keys(files))if(belongs(p,path))delete files[p];folders=new Set([...folders].filter(p=>!belongs(p,path)));persist();},
  image:async()=>{throw {code:'image',message:'预览模式不读取本地图片。'};},
  configure:async(shortcut,floating)=>{settings={...settings,shortcut,floating};localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));return settings;},
  snapshot:async session=>{settings.session=session;localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));},
  clipboard:async()=>({status:'text',text:'在这里查看当前复制的文字。\n\n桌面版会读取系统剪贴板；浏览器预览仅展示此示例。',truncated:false}),
  watchClipboard:async()=>{},
  external:async url=>{window.open(url,'_blank','noopener,noreferrer');},
  hide:async()=>{document.dispatchEvent(new CustomEvent('demo-hidden'));},exit:async()=>{}
 };
}
