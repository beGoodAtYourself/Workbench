import {validHighlights,type TextHighlight} from './text-highlights';
import type {TextFile,TextRecord,TextRepository,TextSnapshot} from './text-types';
import {MAX_TEXT_LENGTH} from './text-types';
import {validateTextSnapshot} from './text-model';
import {key} from './paths';

/** Browser mode uses separate example storage; it never reads or writes local files. */
export const TEXT_DEMO_WARNING='浏览器示例：打开固定示例文件；保存与暂存只写此浏览器，不会操作磁盘文件。';
const annotationKey='shiye-demo-text-annotations-v1';
const manifestKey='shiye-demo-text-session-v1',filesKey='shiye-demo-text-files-v1',bodyPrefix='shiye-demo-text-body-v1:';
type StoredRecord=TextRecord&{blob:string;checksum:string};
type StoredSnapshot=Omit<TextSnapshot,'documents'>&{documents:StoredRecord[]};
const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
function fail(code:string,message:string):never{throw {code,message};}
const empty=():TextSnapshot=>({schema:1,generation:0,documents:[],views:[],active:0,warning:TEXT_DEMO_WARNING});
function checksum(text:string){let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);return (hash>>>0).toString(16);}
function file(id:string,path:string,text:string,version='1'):TextFile{return {id,path,name:path.split('/').at(-1)!,text,version,size:new TextEncoder().encode(text).length,encoding:'utf8',eol:'crlf',readonly:false};}
const examples=[file('demo-config','示例/config.json','{\n  "name": "拾页文本示例",\n  "manualSave": true\n}\n'),file('demo-readme','示例/readme.txt','浏览器文本编辑示例\n\n在这里试用多标签、双视图和查找替换。\n保存只保存在此浏览器，不会写入真实磁盘文件。\n')];

export function textDemoRepository():TextRepository{
 let generation=0,metadataBlocked=false;let notePaths:string[]=[];
 const bodyBlocked=new Set<string>();
 const grants=new Map<string,TextFile>();
 const stored=():StoredSnapshot|null=>{
  let raw:string|null=null;try{raw=localStorage.getItem(manifestKey);}catch{fail('recovery','无法读取浏览器草稿，原记录已保留。');}
  if(raw===null)return null;
  try{
   const value=JSON.parse(raw) as StoredSnapshot;validateTextSnapshot(value);
   if(value.documents.some(doc=>typeof doc.blob!=='string'||!doc.blob.startsWith(bodyPrefix)||typeof doc.checksum!=='string'))throw new Error('blob');
   return value;
  }catch{metadataBlocked=true;return fail('recovery','浏览器文本恢复记录损坏，原记录已保留。');}
 };
 const readBody=(record:StoredRecord)=>{
  let text:string|null=null;try{text=localStorage.getItem(record.blob);}catch{bodyBlocked.add(record.id);fail('recovery','无法读取浏览器正文，原记录已保留。');}
  if(text===null||text.length!==record.length||checksum(text)!==record.checksum){bodyBlocked.add(record.id);fail('recovery','浏览器恢复正文缺失或损坏，原记录已保留。');}
  bodyBlocked.delete(record.id);return text;
 };
 const savedFiles=()=>{
  try{
   const raw=localStorage.getItem(filesKey);if(raw===null)return clone(examples);
   const values=JSON.parse(raw) as TextFile[];
   if(!Array.isArray(values)||values.some(value=>typeof value?.id!=='string'||typeof value.path!=='string'||typeof value.text!=='string'||typeof value.version!=='string'))throw new Error('files');
   return values;
  }catch{return fail('io','浏览器示例文件读取失败，原记录已保留。');}
 };
 const annotations=()=>{
  try{
   const value=JSON.parse(localStorage.getItem(annotationKey)??'{}') as Record<string,{body:string;length:number;highlights:TextHighlight[]}>;
   if(!value||Array.isArray(value)||typeof value!=='object'||Object.entries(value).some(([path,item])=>!path||!item||typeof item.body!=='string'||!Number.isSafeInteger(item.length)||item.length<0||!validHighlights(item.highlights,item.length)))throw new Error('annotations');
   return value;
  }catch{return fail('text-annotations','浏览器标注索引损坏，原记录已保留。');}
 };
 const annotated=(file:TextFile)=>{
  const entry=annotations()[key(file.path)];
  return {...file,highlights:entry?.body===checksum(file.text)&&entry.length===file.text.length?clone(entry.highlights):[]};
 };
 const persistAnnotations=(value:StoredSnapshot)=>{
  const index=annotations();
  for(const doc of value.documents){
   if(!doc.path||doc.revision!==doc.savedRevision||!grants.has(doc.id))continue;
   if(doc.highlights?.length)index[key(doc.path)]={body:doc.checksum,length:doc.length,highlights:clone(doc.highlights)};
   else delete index[key(doc.path)];
  }
  const output=JSON.stringify(index);if(output.length>4*1024*1024)fail('text-annotations','浏览器标注索引已达上限。');
  if(output!==JSON.stringify(annotations()))localStorage.setItem(annotationKey,output);
 };
 const cleanup=(value:StoredSnapshot)=>{
  const keep=new Set(value.documents.map(doc=>doc.blob));const remove:string[]=[];
  for(let i=0;i<localStorage.length;i++){const name=localStorage.key(i);if(name?.startsWith(bodyPrefix)&&!keep.has(name))remove.push(name);}
  for(const name of remove)localStorage.removeItem(name);
 };
 const checkpoint=(value:TextSnapshot)=>{
  if(metadataBlocked||bodyBlocked.size)fail('recovery','恢复记录未完整读取；原记录已保留，请修复后重试。');
  validateTextSnapshot(value);if(value.generation!==generation)fail('stale','浏览器文本代次已过期，请重试。');
  const previous=stored();const nonce=globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random()}`;
  const next:StoredSnapshot={schema:1,generation:value.generation,views:[...value.views],active:value.active,warning:TEXT_DEMO_WARNING,documents:[]};
  let bytes=0;
  try{
   for(const record of value.documents){
    const old=previous?.documents.find(doc=>doc.id===record.id);
    const text=record.text??(old?readBody(old):fail('recovery','未载入标签缺少恢复正文，原记录已保留。'));
    bytes+=new TextEncoder().encode(text).length;if(bytes>64*1024*1024)fail('quota','恢复正文超过 64 MiB 上限。');
    const blob=bodyPrefix+nonce+':'+record.id;localStorage.setItem(blob,text);
    const {text:_text,...metadata}=record;next.documents.push({...metadata,blob,checksum:checksum(text)});
   }
   if(new TextEncoder().encode(JSON.stringify(next)).length>128*1024)fail('quota','恢复元数据超过 128 KiB 上限。');
   // The manifest is the commit point. Failures before this keep the last session.
   localStorage.setItem(manifestKey,JSON.stringify(next));
   persistAnnotations(next);
  }catch(error){if(error&&typeof error==='object'&&'code' in error)throw error;fail('recovery','浏览器草稿暂存失败（可能空间不足），最后有效记录及当前正文已保留。');}
  let warning=TEXT_DEMO_WARNING;try{cleanup(next);}catch{warning+=' 旧草稿清理失败，可再次暂存重试。';}
  return {generation:value.generation,token:`demo:${value.generation}:${nonce}`,warning};
 };
 const repo:TextRepository={
  async open(encoding){if(encoding)fail('encoding-preview','指定编码读取需要桌面版原始文件；浏览器示例仅演示文本编辑。');const files=savedFiles().filter(value=>examples.some(example=>example.id===value.id));for(const value of files)grants.set(value.id,clone(value));return {files:files.map(annotated),notes:[],errors:[]};},
  async read(id,encoding){if(encoding)fail('encoding-preview','以其他编码重新打开需要桌面版原始文件。');const granted=grants.get(id);if(!granted)fail('unauthorized','此示例文件未获授权，请通过打开重新选择。');const current=savedFiles().find(value=>value.id===id);if(!current)fail('missing','示例文件已不存在，缓冲内容已保留。');return annotated(current);},
  async probe(id,knownVersion){const file=await repo.read(id);return file.version===knownVersion?{kind:'unchanged',id:file.id,version:file.version,size:file.size,readonly:file.readonly}:{kind:'changed',file};},
  async save(value){
   const granted=grants.get(value.id);if(!granted)fail('unauthorized','此示例没有原文件授权，请另存。');
   const files=savedFiles(),index=files.findIndex(item=>item.id===value.id);if(index<0)fail('missing','示例文件已不存在。');
   if(files[index].version!==value.version)fail('conflict','示例文件已修改，请重载或另存。');
   if(value.text.length>MAX_TEXT_LENGTH)fail('quota','示例正文超出上限。');
   const next={...files[index],text:value.text,encoding:value.encoding,eol:value.eol,version:String(Number(files[index].version)+1),size:new TextEncoder().encode(value.text).length};
   try{files[index]=next;localStorage.setItem(filesKey,JSON.stringify(files));}catch{fail('io','浏览器示例保存失败，正文已保留。');}
   grants.set(next.id,clone(next));return clone(next);
  },
  async saveAs(value){
   const files=savedFiles();let number=1;while(files.some(item=>item.path===`示例/另存文本 ${number}.txt`))number++;
   const next={...file(value.id,`示例/另存文本 ${number}.txt`,value.text),encoding:value.encoding,eol:value.eol};
   const owned=files.find(item=>item.id===value.id);if(owned)next.id='demo-copy-'+(globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random()}`);
   try{files.push(next);localStorage.setItem(filesKey,JSON.stringify(files));}catch{fail('io','浏览器示例另存失败，正文已保留。');}
   grants.delete(value.id);grants.set(next.id,clone(next));return clone(next);
  },
  async restore(){
   const value=stored();metadataBlocked=false;if(!value){generation=0;return empty();}generation=value.generation;
   const files=savedFiles();for(const record of value.documents){const original=files.find(item=>item.id===record.id);if(original)grants.set(record.id,clone(original));}
   return {...clone(value),warning:TEXT_DEMO_WARNING,documents:value.documents.map(({blob:_blob,checksum:_checksum,...record})=>clone(record))};
  },
  async recover(id){const value=stored(),record=value?.documents.find(doc=>doc.id===id);if(!record)fail('recovery','没有此标签的可用恢复正文。');return readBody(record);},
  async checkpoint(value){return checkpoint(value);},
  async invalidate(next){if(!Number.isSafeInteger(next)||next<generation)fail('stale','示例会话代次已过期。');generation=next;},
  async close(id){
   const value=stored();if(value?.documents.some(doc=>doc.id===id)){
    const next={...value,documents:value.documents.filter(doc=>doc.id!==id),views:value.views.filter(view=>view!==id)};
    if(!next.views.length&&next.documents.length)next.views=[next.documents[0].id];next.active=Math.min(next.active,Math.max(0,next.views.length-1));
    try{localStorage.setItem(manifestKey,JSON.stringify(next));}catch{fail('recovery','关闭标签未能删除恢复引用，请重试。');}
    try{cleanup(next);}catch{/* Committed deletion remains valid even when obsolete blob cleanup fails. */}
   }
   grants.delete(id);
  },
  async notes(paths){notePaths=[...paths];},async noteOwner(path){return notePaths.find(value=>key(value)===key(path))??null;}
 };
 return repo;
}
