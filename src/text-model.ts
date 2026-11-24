import {MAX_SESSION_HIGHLIGHTS,sameHighlights,validHighlights,type TextHighlight} from './text-highlights';
import {asFault} from './types';
import {supportedTextEncodings} from './text-encodings';
import type {Fault} from './types';
import type {TextCommit,TextEncoding,TextEol,TextFile,TextOpenResult,TextRecord,TextRepository,TextSave,TextSnapshot} from './text-types';
import {MAX_TEXT_LENGTH,MAX_TEXT_TABS} from './text-types';
import {key} from './paths';

export type TextCloseChoice='save'|'discard'|'cancel';
export type TextClosePrompt=(doc:TextDocument)=>Promise<TextCloseChoice>;
export type TextPreferences=Partial<Pick<TextRecord,'cursor'|'anchor'|'scroll'|'language'|'tabSize'|'indentWithTabs'|'wrap'|'encoding'|'eol'>>;
const fault=(code:string,message:string):Fault=>({code,message});
const encodings=supportedTextEncodings;
const eols=new Set(['lf','crlf','cr','mixed']);
function language(path:string){
 const extension=path.toLowerCase().split('.').at(-1)??'';
 const languages:Record<string,string>={js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',jsx:'jsx',tsx:'tsx',py:'python',java:'java',c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',cs:'csharp',go:'go',rs:'rust',html:'html',htm:'html',css:'css',json:'json',sql:'sql',sh:'shell',bash:'shell',zsh:'shell',ps1:'powershell',yaml:'yaml',yml:'yaml',md:'markdown',markdown:'markdown',xml:'xml',svg:'xml'};
 return languages[extension]??'plain';
}
function identifier(){return globalThis.crypto?.randomUUID?.()??`text-${Date.now()}-${Math.random().toString(16).slice(2)}`;}

export class TextDocument {
 highlights:TextHighlight[]=[];markRevision=0;recoveryMarkRevision=0;
 id:string;path:string|null;name:string;text:string;version:string;length:number;
 encoding:TextEncoding;eol:TextEol;revision:number;savedRevision:number;
 cursor=0;anchor=0;scroll=0;language='plain';tabSize=4;indentWithTabs=false;wrap=false;readonly=false;
 loaded=true;error:Fault|null=null;saving:Promise<void>|null=null;recoveryRevision=-1;
 constructor(record:TextRecord){
  this.highlights=record.highlights??[];
  this.id=record.id;this.path=record.path;this.name=record.name;this.text=record.text??'';this.length=record.length;
  this.version=record.version;this.encoding=record.encoding;this.eol=record.eol;this.revision=record.revision;this.savedRevision=record.savedRevision;
  this.cursor=record.cursor;this.anchor=record.anchor;this.scroll=record.scroll;this.language=record.language;this.tabSize=record.tabSize;
  this.indentWithTabs=record.indentWithTabs;this.wrap=record.wrap;this.readonly=record.readonly??false;this.error=record.error??null;this.loaded=record.text!==undefined;
 }
 get dirty(){return this.revision!==this.savedRevision;}
 record():TextRecord{
  return {...(this.highlights.length?{highlights:this.highlights}:{}),id:this.id,path:this.path,name:this.name,...(this.loaded?{text:this.text}:{}),length:this.loaded?this.text.length:this.length,version:this.version,encoding:this.encoding,eol:this.eol,revision:this.revision,savedRevision:this.savedRevision,cursor:this.cursor,anchor:this.anchor,scroll:this.scroll,language:this.language,tabSize:this.tabSize,indentWithTabs:this.indentWithTabs,wrap:this.wrap,readonly:this.readonly,error:this.error};
 }
}

/** Validate metadata before adopting a recovery session; paths never grant access. */
export function validateTextSnapshot(value:TextSnapshot){
 if(!value||value.schema!==1||!Number.isSafeInteger(value.generation)||value.generation<0||!Array.isArray(value.documents)||value.documents.length>MAX_TEXT_TABS||!Array.isArray(value.views)||value.views.length>2)throw fault('recovery','文本恢复清单格式无效，原记录已保留。');
 const ids=new Set<string>(),paths=new Set<string>();let length=0,marks=0;
 for(const d of value.documents){
  if(!d||typeof d.id!=='string'||!d.id||ids.has(d.id)||!(d.path===null||typeof d.path==='string')||typeof d.name!=='string'||typeof d.version!=='string'||!Number.isSafeInteger(d.length)||d.length<0||d.length>MAX_TEXT_LENGTH||!(d.text===undefined||typeof d.text==='string')||(d.text!==undefined&&d.text.length!==d.length)||!encodings.has(d.encoding)||!eols.has(d.eol)||!Number.isSafeInteger(d.revision)||d.revision<0||!Number.isSafeInteger(d.savedRevision)||d.savedRevision<0||d.savedRevision>d.revision||![d.cursor,d.anchor,d.scroll].every(n=>Number.isFinite(n)&&n>=0)||typeof d.language!=='string'||![2,4,8].includes(d.tabSize)||typeof d.wrap!=='boolean'||typeof d.indentWithTabs!=='boolean')throw fault('recovery','文本恢复记录无效，原记录已保留。');
  if(!validHighlights(d.highlights??[],d.length)||(marks+=(d.highlights?.length??0))>MAX_SESSION_HIGHLIGHTS)throw fault('recovery','文本标注范围无效或数量超限，原记录已保留。');
  ids.add(d.id);if(d.path!==null){const path=key(d.path);if(paths.has(path))throw fault('recovery','恢复记录含重复文件，原记录已保留。');paths.add(path);}length+=d.length;
 }
 if(length>MAX_TEXT_LENGTH||new Set(value.views).size!==value.views.length||value.views.some(id=>!ids.has(id))||!Number.isInteger(value.active)||value.active<0||value.active>=Math.max(1,value.views.length)||(ids.size>0&&value.views.length===0))throw fault('recovery','恢复标签、视图或正文超过限制，原记录已保留。');
}

export class TextWorkbench {
 documents:TextDocument[]=[];views:string[]=[];active=0;generation=0;commit:TextCommit|null=null;
 recoveryError:Fault|null=null;warning='';frozen=false;
 opening = false;
 onChange:(layout:boolean)=>void=()=>{};
 onNote:(path:string)=>void|Promise<void>=()=>{};
 private timer:ReturnType<typeof setTimeout>|undefined;
 private invalidationTail:Promise<void>=Promise.resolve();
 private persistenceTail:Promise<unknown>=Promise.resolve();
 private saves=new Map<TextDocument,Promise<boolean>>();
 private loads=new Map<TextDocument,Promise<void>>();
 private failedRecoveries=new Set<TextDocument>();
 private acknowledgedBodies=new WeakMap<TextDocument,{id:string;revision:number;length:number}>();
 private restoring=false;
 private closing=new Set<TextDocument>();
 private closingCommit=new Set<TextDocument>();
 private epoch=0;private selection=0;private restoreBlocked=false;private modifiedSinceRestore=false;
 constructor(readonly repo:TextRepository,private askClose:TextClosePrompt=async()=> 'cancel'){}
 current(){return this.documents.find(doc=>doc.id===this.views[this.active]);}
 canEdit(doc:TextDocument){return !this.frozen&&!this.restoreBlocked&&doc.loaded&&this.contains(doc)&&!this.closingCommit.has(doc);}
 get recoveryBlocked(){return this.restoreBlocked;}
 private contains(doc:TextDocument){return this.documents.includes(doc);}
 private available(){if(this.frozen)throw fault('suspended','文本会话已暂停，请重新打开窗口后操作。');}
 private editable(){this.available();if(this.restoreBlocked)throw this.recoveryError??fault('recovery','请先修复文本恢复记录；原记录已保留。');}
 private checkLength(text:string,doc?:TextDocument){
  const length=this.documents.reduce((sum,item)=>sum+(item===doc?0:item.loaded?item.text.length:item.length),0)+text.length;
  if(length>MAX_TEXT_LENGTH)throw fault('quota','全部文本正文合计不能超过 16 Mi 个 UTF-16 代码单元；本次操作未修改内容。');
 }
 private changed(layout:boolean,schedule=true){
  this.modifiedSinceRestore=true;this.generation++;this.commit=null;const generation=this.generation;
  this.invalidationTail=this.invalidationTail.catch(()=>{}).then(()=>this.repo.invalidate(generation));
  void this.invalidationTail.catch(error=>{this.recoveryError=asFault(error);this.onChange(false);});
  if(schedule&&!this.frozen){clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.checkpoint().catch(()=>{});},1000);}
  this.onChange(layout);
 }
 private enqueue<T>(action:()=>Promise<T>):Promise<T>{
  const result=this.persistenceTail.catch(()=>{}).then(action);this.persistenceTail=result;return result;
 }
 create(text=''){
  this.editable();if(this.documents.length>=MAX_TEXT_TABS)throw fault('tabs','最多打开 12 个文本标签，请先关闭一个标签。');this.checkLength(text);
  let number=1;while(this.documents.some(doc=>doc.name===`未命名 ${number}`))number++;
  const doc=new TextDocument({id:identifier(),path:null,name:`未命名 ${number}`,text,length:text.length,version:'',encoding:'utf8',eol:'crlf',revision:text?1:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'plain',tabSize:4,indentWithTabs:false,wrap:false});
  this.documents.push(doc);if(!this.views.length)this.views=[doc.id];else this.views[this.active]=doc.id;this.changed(true);return doc;
 }
 edit(doc:TextDocument,text:string,format?:Pick<TextPreferences,'encoding'|'eol'>,highlights?:readonly TextHighlight[]){
  this.editable();if(!this.contains(doc)||!doc.loaded)return false;
  if(this.closingCommit.has(doc))throw fault('busy','此标签正在关闭，请稍后操作。');
  const encoding=format?.encoding??doc.encoding,eol=format?.eol??doc.eol;
  if(doc.text===text&&doc.encoding===encoding&&doc.eol===eol)return false;
  if(!encodings.has(encoding)||!eols.has(eol))throw fault('format','不支持该文本输出格式。');this.checkLength(text,doc);
  const marks=highlights??(text===doc.text?doc.highlights:[]);this.checkHighlights(doc,marks,text.length);
  if(!sameHighlights(doc.highlights,marks)){doc.highlights=marks.map(mark=>({...mark}));doc.markRevision++;}
  doc.text=text;doc.length=text.length;doc.encoding=encoding;doc.eol=eol;doc.revision++;this.changed(false);return true;
 }
 checkHighlights(doc:TextDocument,marks:readonly TextHighlight[],length=doc.length){
  if(!validHighlights(marks,length)||this.documents.reduce((sum,item)=>sum+(item===doc?marks.length:item.highlights.length),0)>MAX_SESSION_HIGHLIGHTS)throw fault('highlight-limit','标注数量超过限制（每份 256 处、全部 1024 处），请先清除部分标注。');
 }
 mark(doc:TextDocument,marks:readonly TextHighlight[]){
  this.editable();if(!this.canEdit(doc))return;this.checkHighlights(doc,marks);
  if(sameHighlights(doc.highlights,marks))return;
  doc.highlights=marks.map(mark=>({...mark}));doc.markRevision++;this.changed(false);
 }
 configure(doc:TextDocument,patch:TextPreferences){
  this.editable();if(!this.contains(doc))return;
  if(this.closingCommit.has(doc))throw fault('busy','此标签正在关闭，请稍后操作。');
  const {encoding,eol,...preferences}=patch;
  if(preferences.tabSize!==undefined&&![2,4,8].includes(preferences.tabSize))throw fault('format','缩进宽度仅支持 2、4、8。');
  const formatChanged=(encoding!==undefined&&encoding!==doc.encoding)||(eol!==undefined&&eol!==doc.eol);
  if(formatChanged&&!doc.loaded)throw fault('loading','请先载入文本再转换格式。');
  if(encoding!==undefined&&!encodings.has(encoding)||eol!==undefined&&!eols.has(eol))throw fault('format','不支持该文本输出格式。');
  const settingsChanged=Object.entries(preferences).some(([name,value])=>doc[name as keyof TextDocument]!==value);
  if(!formatChanged&&!settingsChanged)return;
  Object.assign(doc,preferences);if(encoding!==undefined)doc.encoding=encoding;if(eol!==undefined)doc.eol=eol;
  if(formatChanged)doc.revision++;this.changed(false);
 }
 touch(doc:TextDocument){this.available();if(!this.restoreBlocked&&this.contains(doc))this.changed(false);}
 open(encoding?: TextEncoding): Promise<TextOpenResult> {
  return this.openFiles(() => this.repo.open(encoding));
 }
 openDropped(token: string): Promise<TextOpenResult> {
  return this.openFiles(() => {
   if (!this.repo.openDropped) {
    throw fault('desktop', '请在桌面版中拖入文本文件。');
   }
   return this.repo.openDropped(token);
  });
 }
 async openFiles(select: () => Promise<TextOpenResult>): Promise<TextOpenResult> {
  this.editable();
  if (this.opening) {
   throw fault('busy', '正在打开文本文件，请稍候。');
  }
  const epoch = this.epoch;
  let result: TextOpenResult;
  this.opening = true;
  this.onChange(false);
  try {
   result = await select();
  } finally {
   this.opening = false;
   this.onChange(false);
  }
  if(this.frozen||epoch!==this.epoch){for(const file of result.files)if(!this.documents.some(doc=>doc.id===file.id))await this.repo.close(file.id);return {files:[],notes:[],errors:[]};}
  const accepted:TextFile[]=[],errors=[...result.errors];let limited=false;
  for(const file of result.files){
   if(this.frozen||epoch!==this.epoch){if(!this.documents.some(doc=>doc.id===file.id))try{await this.repo.close(file.id);}catch(error){errors.push(asFault(error));}continue;}
   const existing=this.documents.find(doc=>doc.id===file.id||doc.path!==null&&key(doc.path)===key(file.path));
   if(existing){if(existing.loaded)await this.refreshDocument(existing,epoch);await this.activate(existing.id);accepted.push(file);continue;}
   try{
    if(limited||this.documents.length>=MAX_TEXT_TABS)throw fault('tabs','最多打开 12 个文本标签，请先关闭一个标签。');this.checkLength(file.text);
    const doc=new TextDocument({id:file.id,path:file.path,name:file.name,text:file.text,length:file.text.length,version:file.version,encoding:file.encoding,eol:file.eol,revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:language(file.path),tabSize:4,indentWithTabs:false,wrap:false,readonly:file.readonly,highlights:file.highlights});
    this.checkHighlights(doc,doc.highlights);this.documents.push(doc);if(!this.views.length)this.views=[doc.id];else this.views[this.active]=doc.id;this.changed(true);accepted.push(file);
   }catch(error){errors.push(asFault(error));limited=true;try{await this.repo.close(file.id);}catch(closeError){errors.push(asFault(closeError));}}
  }
  for(const path of result.notes)if(!this.frozen&&epoch===this.epoch)await this.onNote(path);
  return {files:accepted,errors,notes:result.notes};
 }
 private async ensureLoaded(doc:TextDocument){
  if(doc.loaded)return;const existing=this.loads.get(doc);if(existing)return existing;
  const epoch=this.epoch;
  const loading=(async()=>{try{
   const text=await this.repo.recover(doc.id);if(epoch!==this.epoch||!this.contains(doc))return;
   if(text.length!==doc.length)throw fault('recovery','恢复正文长度校验失败，原记录已保留。');this.checkLength(text,doc);
   doc.text=text;doc.loaded=true;doc.recoveryRevision=doc.revision;doc.recoveryMarkRevision=doc.markRevision;this.acknowledgeBody(doc);
   if(this.failedRecoveries.delete(doc))doc.error=null;
   // A blob is a draft, not evidence that the original still has its old bytes.
   await this.refreshDocument(doc,epoch);
  }catch(error){if(epoch===this.epoch&&this.contains(doc)){this.failedRecoveries.add(doc);doc.error=asFault(error);this.recoveryError=asFault(error);this.restoreBlocked=true;}throw error;}
  finally{this.loads.delete(doc);}})();this.loads.set(doc,loading);return loading;
 }
 async activate(id:string,view=this.active){
  this.editable();const doc=this.documents.find(item=>item.id===id);if(!doc)return;const token=++this.selection;
  await this.ensureLoaded(doc);if(this.frozen||token!==this.selection||!this.contains(doc))return;
  const existing=this.views.indexOf(id);if(existing>=0)this.active=existing;
  else{this.active=Math.min(Math.max(0,view),Math.max(0,this.views.length-1));this.views[this.active]=id;}
  this.changed(true);
 }
 async split(id?:string){
  this.editable();if(!this.documents.length)return;
  const target=this.documents.find(doc=>doc.id===id)??this.documents.find(doc=>!this.views.includes(doc.id));if(!target)return;
  if(this.views.length===2){await this.activate(target.id,1);return;}if(this.views[0]===target.id)return;
  const token=++this.selection;await this.ensureLoaded(target);if(this.frozen||token!==this.selection||!this.contains(target))return;
  this.views.push(target.id);this.active=1;this.changed(true);
 }
 merge(){this.editable();if(this.views.length<2)return;this.views=[this.views[this.active]];this.active=0;this.selection++;this.changed(true);}
 move(id:string,index:number){
  this.editable();const from=this.documents.findIndex(doc=>doc.id===id);if(from<0)return;
  const to=Math.max(0,Math.min(this.documents.length-1,Math.trunc(index)));if(to===from)return;
  const [doc]=this.documents.splice(from,1);this.documents.splice(to,0,doc);this.changed(true);
 }
 async save(doc=this.current(),as=false):Promise<boolean>{
  this.editable();if(!doc||!this.contains(doc))return false;if(!doc.loaded)await this.ensureLoaded(doc);if(!doc.loaded||!this.contains(doc))return false;
  const captured={text:doc.text,encoding:doc.encoding,eol:doc.eol,revision:doc.revision};
  if(!as&&doc.path&&!doc.dirty){if(doc.markRevision!==doc.recoveryMarkRevision)await this.checkpoint();return true;}
  if(captured.eol==='mixed'||captured.eol==='cr')throw fault('eol','请明确选择统一为 LF 或 CRLF 后保存。');
  const previous=this.saves.get(doc)??Promise.resolve(true);
  const saving=previous.catch(()=>false).then(async()=>{
   if(!this.contains(doc))return false;
   if(!as&&doc.path&&doc.savedRevision>=captured.revision)return true;
   if(!as&&doc.path&&doc.error&&['conflict','missing','identity','unauthorized','authorization'].includes(doc.error.code))throw doc.error;
   const value:TextSave={id:doc.id,text:captured.text,encoding:captured.encoding,eol:captured.eol,version:doc.version};
   const result=as||!doc.path?await this.repo.saveAs(value):await this.repo.save(value);if(!result)return false;
   if(!this.contains(doc))return false;
   const oldId=doc.id;doc.id=result.id;this.views=this.views.map(id=>id===oldId?doc.id:id);doc.path=result.path;doc.name=result.name;doc.version=result.version;doc.readonly=result.readonly;doc.savedRevision=captured.revision;doc.error=null;
   if(oldId!==doc.id){this.acknowledgedBodies.delete(doc);doc.recoveryRevision=-1;}
   this.changed(true);
   try{await this.checkpoint();}catch(error){this.recoveryError=fault('recovery',`原文件已保存，恢复状态未更新：${asFault(error).message}`);this.onChange(false);}
   return true;
  }).catch(error=>{if(this.contains(doc)){doc.error=asFault(error);this.onChange(false);}throw error;});
  this.saves.set(doc,saving);const visible=saving.then(()=>{});doc.saving=visible;void visible.catch(()=>{});
  this.onChange(false);
  try{return await saving;}finally{if(this.saves.get(doc)===saving){this.saves.delete(doc);doc.saving=null;this.onChange(false);}}
 }
 async saveAll(){for(const doc of [...this.documents])if((doc.dirty||!doc.path||doc.markRevision!==doc.recoveryMarkRevision)&&!await this.save(doc))return false;return true;}
 async close(value:TextDocument|string=this.current()?.id??'',ask=this.askClose):Promise<boolean>{
  this.editable();const doc=typeof value==='string'?this.documents.find(item=>item.id===value):value;
  if(!doc||!this.contains(doc))return true;if(this.closing.has(doc))return false;this.closing.add(doc);
  try{
   const revision=doc.revision,markRevision=doc.markRevision;
   if(doc.dirty){const choice=await ask(doc);if(this.frozen||!this.contains(doc)||(doc.revision!==revision||doc.markRevision!==markRevision)||choice==='cancel')return false;if(choice==='save'&&(!await this.save(doc)||doc.dirty))return false;}
   const saving=this.saves.get(doc);if(saving)await saving;
   if(this.frozen||(doc.revision!==revision||doc.markRevision!==markRevision))return false;
   if(doc.highlights.length||doc.markRevision!==doc.recoveryMarkRevision)await this.checkpoint();
   return await this.enqueue(async()=>{
    if(this.frozen||!this.contains(doc)||(doc.revision!==revision||doc.markRevision!==markRevision))return false;
    const next=this.views.filter(id=>id!==doc.id).length?undefined:this.documents.find(item=>item!==doc);
    if(next)await this.ensureLoaded(next);
    if(this.frozen||(doc.revision!==revision||doc.markRevision!==markRevision))return false;
    this.closingCommit.add(doc);
    try{
     await this.invalidationTail;await this.repo.close(doc.id);
     this.documents=this.documents.filter(item=>item!==doc);this.views=this.views.filter(id=>id!==doc.id);
     if(!this.views.length&&next)this.views=[next.id];
     this.active=Math.min(this.active,Math.max(0,this.views.length-1));this.selection++;this.changed(true);return true;
    }finally{this.closingCommit.delete(doc);}
   });
  }catch(error){if(this.contains(doc)){doc.error=asFault(error);this.onChange(false);}throw error;}finally{this.closing.delete(doc);}
 }
 async closeOthers(id:string,ask=this.askClose){for(const doc of [...this.documents])if(doc.id!==id&&!await this.close(doc,ask))return false;return true;}
 async reload(doc=this.current(),encoding?:TextEncoding){
  this.editable();if(!doc||!doc.path||!this.contains(doc))return;const epoch=this.epoch,revision=doc.revision,version=doc.version,markRevision=doc.markRevision;
  if(doc.markRevision!==doc.recoveryMarkRevision)await this.checkpoint();
  if(this.frozen||epoch!==this.epoch||!this.contains(doc)||doc.revision!==revision||doc.version!==version||doc.markRevision!==markRevision)return;
  const file=await (encoding?this.repo.read(doc.id,encoding):this.repo.read(doc.id));if(this.frozen||epoch!==this.epoch||!this.contains(doc)||doc.revision!==revision||doc.version!==version||doc.markRevision!==markRevision)return;
  this.checkLength(file.text,doc);this.checkHighlights(doc,file.highlights??[],file.text.length);doc.highlights=file.highlights??[];doc.markRevision++;doc.text=file.text;doc.length=file.text.length;doc.loaded=true;doc.version=file.version;doc.encoding=file.encoding;doc.eol=file.eol;doc.readonly=file.readonly;doc.revision++;doc.savedRevision=doc.revision;doc.error=null;this.changed(true);
 }
 async refresh(){
  if(this.frozen||this.restoreBlocked)return;const epoch=this.epoch;
  for(const doc of [...this.documents]){
   if(this.frozen||epoch!==this.epoch)return;await this.refreshDocument(doc,epoch);
  }
 }
 private async refreshDocument(doc:TextDocument,epoch:number){
  if(!doc.path||doc.saving||!doc.loaded)return;
  const revision=doc.revision,version=doc.version,markRevision=doc.markRevision,current=()=>!this.frozen&&epoch===this.epoch&&this.contains(doc)&&!doc.saving&&doc.revision===revision&&doc.version===version&&doc.markRevision===markRevision;
  try{
   const result=await this.repo.probe(doc.id,version);if(!current())return;
   if(result.kind==='changed'){const file=result.file;if(doc.dirty){doc.readonly=file.readonly;doc.error=fault('conflict','磁盘文件已修改，本地内容已保留。请另存或确认重载。');this.changed(false);}
   else{this.checkLength(file.text,doc);this.checkHighlights(doc,file.highlights??[],file.text.length);doc.highlights=file.highlights??[];doc.markRevision++;doc.text=file.text;doc.length=file.text.length;doc.version=file.version;doc.encoding=file.encoding;doc.eol=file.eol;doc.readonly=file.readonly;doc.revision++;doc.savedRevision=doc.revision;doc.error=null;this.changed(true);}}
   else{
    const clear=doc.error&&['identity','authorization','unauthorized','missing','permission'].includes(doc.error.code)&&(doc.error.code!=='permission'||!result.readonly);
    if(doc.readonly!==result.readonly||clear){doc.readonly=result.readonly;if(clear)doc.error=null;this.changed(false);}
   }
  }catch(error){if(current()){doc.error=asFault(error);this.changed(false);}}
 }
 snapshot():TextSnapshot{return {schema:1,generation:this.generation,documents:this.documents.map(doc=>doc.record()),views:[...this.views],active:this.active};}
 private acknowledgeBody(doc:TextDocument){this.acknowledgedBodies.set(doc,{id:doc.id,revision:doc.revision,length:doc.loaded?doc.text.length:doc.length});}
 private checkpointSnapshot():TextSnapshot{
  const snapshot=this.snapshot();
  for(let index=0;index<snapshot.documents.length;index++){
   const record=snapshot.documents[index],known=this.acknowledgedBodies.get(this.documents[index]);
   // Only a matching host-confirmed body may be reused. Public snapshot()
   // remains complete for loaded documents and is never mutated here.
   if(known?.id===record.id&&known.revision===record.revision&&known.length===record.length)delete record.text;
  }
  return snapshot;
 }
 checkpoint():Promise<TextCommit>{
  clearTimeout(this.timer);return this.enqueue(async()=>{
   if(this.restoreBlocked)throw this.recoveryError??fault('recovery','恢复记录未完整读取，请修复后重试。');
   try{
    for(;;){const tail=this.invalidationTail;await tail;if(tail!==this.invalidationTail)continue;
     const snapshot=this.checkpointSnapshot();let commit:TextCommit;
     try{commit=await this.repo.checkpoint(snapshot);}catch(error){if(this.generation!==snapshot.generation)continue;throw error;}
     if(commit.generation!==snapshot.generation)throw fault('stale','宿主未确认当前恢复代次，请重试。');
     if(this.generation!==snapshot.generation)continue;
     this.commit=commit;this.warning=commit.warning??'';this.recoveryError=null;for(const doc of this.documents){doc.recoveryRevision=doc.revision;doc.recoveryMarkRevision=doc.markRevision;this.acknowledgeBody(doc);}
     this.onChange(false);return commit;
    }
   }catch(error){this.recoveryError=asFault(error);this.commit=null;this.onChange(false);throw error;}
  });
 }
 async restore(){
  this.available();if(this.restoring)throw fault('busy','文本草稿正在恢复，请稍后重试。');
  if(this.documents.length&&this.modifiedSinceRestore&&!this.restoreBlocked)throw fault('recovery','当前文本会话已有修改，不能用旧恢复清单替换；内存内容已保留。');
  this.restoring=true;const epoch=++this.epoch;this.selection++;clearTimeout(this.timer);
  try{
   // A failed lazy load must never make retry discard healthy documents' newer
   // input. Keep the current objects/revisions and retry only unloaded bodies.
   if(this.restoreBlocked&&this.documents.length){
    for(const doc of this.documents){if(!doc.loaded)await this.ensureLoaded(doc);if(epoch!==this.epoch||this.frozen)return;}
    this.restoreBlocked=false;this.recoveryError=null;this.changed(true);await this.checkpoint();return;
   }
   const snapshot=await this.repo.restore();if(epoch!==this.epoch||this.frozen)return;
   validateTextSnapshot(snapshot);const documents=snapshot.documents.map(record=>{const doc=new TextDocument(record);doc.recoveryRevision=record.revision;return doc;});
   this.failedRecoveries.clear();this.acknowledgedBodies=new WeakMap();for(const doc of documents)this.acknowledgeBody(doc);
   this.documents=documents;this.views=[...snapshot.views];this.active=snapshot.active;this.generation=snapshot.generation;this.commit=null;this.warning=snapshot.warning??'';this.restoreBlocked=false;this.recoveryError=null;this.modifiedSinceRestore=false;
   for(const id of this.views){const doc=this.documents.find(item=>item.id===id)!,wasLoaded=doc.loaded;await this.ensureLoaded(doc);if(wasLoaded)await this.refreshDocument(doc,epoch);if(epoch!==this.epoch||this.frozen)return;}
   this.onChange(true);
  }catch(error){if(epoch===this.epoch){this.recoveryError=asFault(error);this.restoreBlocked=true;this.onChange(true);}throw error;}finally{this.restoring=false;}
 }
 async suspend(){
  this.frozen=true;this.selection++;this.epoch++;clearTimeout(this.timer);
  // Untouched damaged recovery data stays on disk. Other modules can still hide
  // or exit; the host separately decides whether this inactive session is safe.
  if(this.restoreBlocked&&!this.modifiedSinceRestore){this.commit=null;return null;}
  try{for(const saving of this.saves.values())await saving;return await this.checkpoint();}catch(error){this.frozen=false;throw error;}
 }
 resume(){this.frozen=false;}
 dispose(){this.frozen=true;this.epoch++;this.selection++;clearTimeout(this.timer);this.onChange=()=>{};}
}
