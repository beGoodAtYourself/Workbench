import {describe,expect,it,vi} from 'vitest';
import {textEncodings,supportedTextEncodings} from '../src/text-encodings';
import {TextWorkbench,validateTextSnapshot} from '../src/text-model';
import type {TextEncoding,TextFile,TextRepository,TextSnapshot} from '../src/text-types';

function setup(){
 const file:TextFile={id:'legacy',path:'C:/legacy.txt',name:'legacy.txt',text:'Â£',version:'1',size:2,encoding:'windows-1252',eol:'lf',readonly:false};
 const repo={open:vi.fn(async(_encoding?:TextEncoding)=>({files:[file],notes:[],errors:[]})),read:vi.fn(async(_id:string,_encoding?:TextEncoding)=>({...file,text:'£',encoding:'utf8' as const})),invalidate:vi.fn(async()=>{}),checkpoint:vi.fn(async(value:TextSnapshot)=>({generation:value.generation,token:'test'}))} as unknown as TextRepository;
 return {repo,model:new TextWorkbench(repo)};
}

describe('expanded text encoding flow',()=>{
 it('accepts every output encoding in persisted drafts and rejects unknown values',()=>{
  const {model}=setup();try{
   const doc=model.create('正文');
   expect(supportedTextEncodings.size).toBe(47);
   for(const [encoding] of textEncodings){model.edit(doc,doc.text,{encoding});expect(()=>validateTextSnapshot(model.snapshot())).not.toThrow();}
   const snapshot=model.snapshot();snapshot.documents[0].encoding='unknown' as TextEncoding;expect(()=>validateTextSnapshot(snapshot)).toThrow();
  }finally{model.dispose();}
 });
 it('passes explicit read encodings without converting the current text in place',async()=>{
  const {repo,model}=setup();try{
   await model.open('windows-1252');expect(repo.open).toHaveBeenCalledWith('windows-1252');
   const doc=model.current()!;expect(doc.text).toBe('Â£');model.edit(doc,'unsaved');
   await model.reload(doc,'utf8');expect(repo.read).toHaveBeenCalledWith('legacy','utf8');expect(doc.text).toBe('£');expect(doc.encoding).toBe('utf8');expect(doc.dirty).toBe(false);
  }finally{model.dispose();}
 });
 it('failed or stale redecoding preserves newer edits',async()=>{
  const {repo,model}=setup();try{
   await model.open();const doc=model.current()!;model.edit(doc,'keep me');
   vi.mocked(repo.read).mockRejectedValueOnce({code:'encoding',message:'invalid'});
   await expect(model.reload(doc,'gbk')).rejects.toEqual({code:'encoding',message:'invalid'});expect(doc.text).toBe('keep me');expect(doc.dirty).toBe(true);
   let done!:(file:TextFile)=>void;vi.mocked(repo.read).mockImplementationOnce(()=>new Promise(resolve=>done=resolve));
   const pending=model.reload(doc,'utf8');model.edit(doc,'newer edit');done({id:doc.id,path:doc.path!,name:doc.name,text:'stale',version:'1',size:5,encoding:'utf8',eol:'lf',readonly:false});await pending;
   expect(doc.text).toBe('newer edit');expect(doc.encoding).toBe('windows-1252');
  }finally{model.dispose();}
 });
});
