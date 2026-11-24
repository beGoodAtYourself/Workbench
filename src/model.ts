import type { Note, Repository, Mode, PaneRecord } from './types';
import { asFault } from './types';
import { key, belongs } from './paths';
export class Document {
  path: string; text: string; version: string;
  mode: Mode='preview'; cursor=0; scroll=0;
  revision=0; savedRevision=0; error: ReturnType<typeof asFault>|null=null;
  timer: ReturnType<typeof setTimeout>|undefined;
  saving: Promise<void>|null=null;
  constructor(note: Note){this.path=note.path;this.text=note.text;this.version=note.version;}
  get dirty(){return this.revision!==this.savedRevision;}
}
export class Workbench {
  panes: Document[]=[]; active=0;
  private request=0;
  private readEpoch=0;
  private fileOperation=false;
  onChange: (layout:boolean)=>void=()=>{};
  constructor(readonly repo:Repository, private large: (message:string)=>Promise<boolean>){}
  current(){return this.panes[this.active];}
  async load(path:string):Promise<Document>{
    const epoch=this.readEpoch;
    const doc=await this.readDocument(path,()=>!this.fileOperation&&epoch===this.readEpoch);
    if(!doc)throw {code:'cancelled',message:'文件操作期间已取消旧的笔记读取。'};
    return doc;
  }
  private async readDocument(path:string,current:()=>boolean):Promise<Document|undefined>{
    if(!current())return;
    const existing=this.panes.find(d=>key(d.path)===key(path));if(existing)return existing;
    try{
      let note:Note;
      try{note=await this.repo.read(path);}
      catch(error){
        if(!current())return;
        const e=asFault(error);if(e.code!=='large')throw error;
        const allowed=await this.large(e.message);if(!current())return;
        if(!allowed)throw error;
        note=await this.repo.read(path,true);
      }
      if(current())return new Document(note);
    }catch(error){if(current())throw error;}
  }
  async beginFileOperation():Promise<()=>void>{
    if(this.fileOperation)throw {code:'busy',message:'文件操作正在进行，请稍后重试。'};
    this.fileOperation=true;this.request++;this.readEpoch++;
    let released=false;
    const release=()=>{if(!released){released=true;this.fileOperation=false;}};
    // Repository reads cannot be aborted. Their results are invalidated immediately,
    // so a slow read never delays moving a directory after all writes have finished.
    try{await this.flushAll();return release;}
    catch(error){release();throw error;}
  }
  edit(doc:Document,text:string){
    if(doc.text===text)return;
    doc.text=text;doc.revision++;
    clearTimeout(doc.timer);
    if(!doc.error)doc.timer=setTimeout(()=>{void this.flush(doc).catch(()=>{});},500);
    this.onChange(false);
  }
  async flush(doc:Document):Promise<void>{
    clearTimeout(doc.timer);
    if(doc.saving){await doc.saving;if(doc.dirty)return this.flush(doc);return;}
    if(!doc.dirty)return;
    doc.error=null;
    doc.saving=(async()=>{
      while(doc.dirty){
        const rev=doc.revision,text=doc.text;
        const next=await this.repo.save(doc.path,text,doc.version);
        doc.version=next;doc.savedRevision=rev;
      }
    })().catch(e=>{doc.error=asFault(e);throw e;}).finally(()=>{doc.saving=null;this.onChange(false);});
    this.onChange(false);
    await doc.saving;
  }
  async flushAll(){for(const doc of this.panes)await this.flush(doc);}
  private release(doc:Document){clearTimeout(doc.timer);}
  async select(path:string, mode?:Mode){
    if(this.fileOperation)return;
    const token=++this.request;
    const existing=this.panes.findIndex(d=>key(d.path)===key(path));
    if(existing>=0){this.active=existing;if(mode)this.panes[existing].mode=mode;this.onChange(true);return;}
    const next=await this.readDocument(path,()=>token===this.request&&!this.fileOperation);if(!next||token!==this.request)return;
    const index=this.panes.length?this.active:0, previous=this.panes[index];
    if(previous)await this.flush(previous);
    if(token!==this.request)return;
    if(previous)this.release(previous);
    if(mode)next.mode=mode;
    this.panes[index]=next;this.active=index;this.onChange(true);
  }
  async follow(source:Document,path:string){
    if(this.fileOperation||!this.panes.includes(source))return;
    const token=++this.request;
    if(key(source.path)===key(path)){this.active=this.panes.indexOf(source);this.onChange(false);return;}
    const next=await this.readDocument(path,()=>token===this.request&&!this.fileOperation);if(!next||token!==this.request)return;
    const removed=this.panes.filter(d=>d!==source&&d!==next);
    for(const doc of removed)await this.flush(doc);
    if(token!==this.request||!this.panes.includes(source))return;
    removed.forEach(d=>this.release(d));
    this.panes=[source,next];this.active=1;this.onChange(true);
  }
  async closeRight(){
    if(this.fileOperation)return;
    const token=++this.request,doc=this.panes[1];if(!doc)return;
    await this.flush(doc);if(token!==this.request||this.panes[1]!==doc)return;
    this.release(doc);this.panes=[this.panes[0]];this.active=0;this.onChange(true);
  }
  async clear(){
    if(this.fileOperation)return;
    const token=++this.request;this.readEpoch++;await this.flushAll();if(token!==this.request)return;
    this.panes.forEach(d=>this.release(d));this.panes=[];this.active=0;this.onChange(true);
  }
  async reload(doc:Document){
    if(this.fileOperation||!this.panes.includes(doc))return;
    const epoch=this.readEpoch,path=doc.path,revision=doc.revision;
    const current=()=>epoch===this.readEpoch&&!this.fileOperation&&doc.path===path&&doc.revision===revision&&this.panes.includes(doc);
    clearTimeout(doc.timer);if(doc.saving)await doc.saving.catch(()=>{});
    if(!current())return;
    try{
      const note=await this.repo.read(path,true);if(!current())return;
      doc.text=note.text;doc.version=note.version;doc.revision++;doc.savedRevision=doc.revision;doc.error=null;this.onChange(true);
    }catch(error){if(current())throw error;}
  }
  async refresh(){
    if(this.fileOperation)return;
    const epoch=this.readEpoch;let changed=false;
    for(const doc of [...this.panes]){
      if(epoch!==this.readEpoch||this.fileOperation)return;
      if(doc.saving)continue;
      const revision=doc.revision,version=doc.version,path=doc.path;
      const current=()=>epoch===this.readEpoch&&!this.fileOperation&&!doc.saving&&doc.revision===revision&&doc.version===version&&doc.path===path&&this.panes.includes(doc);
      try{
        const note=await this.repo.read(path,true);
        if(!current())continue;
        if(note.version!==doc.version){
          if(doc.dirty){clearTimeout(doc.timer);doc.error={code:'conflict',message:'磁盘文件已被修改，请先处理冲突。'};}
          else {doc.text=note.text;doc.version=note.version;doc.revision++;doc.savedRevision=doc.revision;doc.error=null;changed=true;}
        }
      }catch(e){if(current()){doc.error=asFault(e);clearTimeout(doc.timer);}}
    }
    if(epoch===this.readEpoch&&!this.fileOperation)this.onChange(changed);
  }
  remap(oldPath:string,newPath:string){
    this.request++;this.readEpoch++;
    for(const doc of this.panes)if(belongs(doc.path,oldPath))doc.path=newPath+doc.path.slice(oldPath.length);
    this.onChange(true);
  }
  remove(path:string){
    this.request++;this.readEpoch++;
    this.panes.filter(d=>belongs(d.path,path)).forEach(d=>this.release(d));
    this.panes=this.panes.filter(d=>!belongs(d.path,path));this.active=Math.min(this.active,Math.max(0,this.panes.length-1));this.onChange(true);
  }
  records():PaneRecord[]{return this.panes.map(({path,mode,cursor,scroll})=>({path,mode,cursor,scroll}));}
}
