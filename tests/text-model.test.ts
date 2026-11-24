import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {TextDocument,TextWorkbench,validateTextSnapshot} from '../src/text-model';
import type {TextFile,TextOpenResult,TextProbeResult,TextRecord,TextRepository,TextSnapshot} from '../src/text-types';
import {MAX_TEXT_LENGTH,MAX_TEXT_TABS} from '../src/text-types';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const file=(id:string,text=id):TextFile=>({id,path:`C:/测试/${id}.txt`,name:`${id}.txt`,text,version:'1',size:text.length,encoding:'utf8',eol:'crlf',readonly:false});
const record=(id:string,text?:string):TextRecord=>({id,path:`C:/测试/${id}.txt`,name:`${id}.txt`,...(text===undefined?{}:{text}),length:text?.length??1,version:'1',encoding:'utf8',eol:'crlf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'plain',tabSize:4,indentWithTabs:false,wrap:false});
function setup(){
 const files=new Map(['A','B','C'].map(id=>[id,file(id)]));let snapshot:TextSnapshot={schema:1,generation:0,documents:[],views:[],active:0};
 const open=vi.fn(async():Promise<TextOpenResult>=>({files:[copy(files.get('A')!)],errors:[],notes:[]}));
 const read=vi.fn(async(id:string)=>{const value=files.get(id);if(!value)throw {code:'missing',message:'文件已删除'};return copy(value);});
 const probe=vi.fn(async(id:string,knownVersion:string):Promise<TextProbeResult>=>{const file=await read(id);return file.version===knownVersion?{kind:'unchanged',id:file.id,version:file.version,size:file.size,readonly:file.readonly}:{kind:'changed',file};});
 const save=vi.fn(async(value:Parameters<TextRepository['save']>[0])=>{const old=files.get(value.id);if(!old)throw {code:'missing',message:'文件已删除'};if(old.version!==value.version)throw {code:'conflict',message:'外部修改'};const next={...old,...value,version:String(Number(old.version)+1)};files.set(value.id,next);return copy(next);});
 const saveAs=vi.fn(async(value:Parameters<TextRepository['saveAs']>[0])=>{const next={...file(value.id,value.text),...value,path:`C:/另存/${value.id}.txt`,name:'另存.txt',version:'1'};files.set(value.id,next);return next;});
 const checkpoint=vi.fn(async(value:TextSnapshot)=>{snapshot=copy(value);return {generation:value.generation,token:`commit:${value.generation}`};});
 const restore=vi.fn(async()=>copy(snapshot));const recover=vi.fn(async(id:string)=>files.get(id)?.text??'');
 const invalidate=vi.fn(async(_generation:number)=>{}),close=vi.fn(async(id:string)=>{snapshot.documents=snapshot.documents.filter(doc=>doc.id!==id);});
 const repo:TextRepository={open,read,probe,save,saveAs,checkpoint,restore,recover,invalidate,close,notes:vi.fn(async()=>{}),noteOwner:vi.fn(async()=>null)};
 const ask=vi.fn(async()=>'cancel' as const),model=new TextWorkbench(repo,ask);
 return {model,repo,files,open,read,probe,save,saveAs,checkpoint,restore,recover,invalidate,close,ask,get snapshot(){return snapshot;}};
}
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});

describe('text tabs and views',()=>{
 it('creates clean empty untitled documents and dirty prefilled documents using the default format',()=>{
  const {model}=setup();const empty=model.create(),filled=model.create('中文😀');
  expect(empty.dirty).toBe(false);expect(empty.encoding).toBe('utf8');expect(empty.eol).toBe('crlf');expect(filled.dirty).toBe(true);expect(filled.name).not.toBe(empty.name);expect(model.current()).toBe(filled);
 });
 it('keeps twelve documents without silently evicting content',()=>{
  const {model}=setup();for(let i=0;i<MAX_TEXT_TABS;i++)model.create(`document ${i}`);const before=[...model.documents];
  expect(()=>model.create('extra')).toThrowError(expect.objectContaining({code:'tabs'}));expect(model.documents).toEqual(before);
 });
 it('keeps unique visible documents while switching, splitting, sorting and merging',async()=>{
  const {model}=setup();const a=model.create('A'),b=model.create('B'),c=model.create('C');a.cursor=1;
  await model.activate(a.id);await model.split(b.id);expect(model.views).toEqual([a.id,b.id]);await model.activate(a.id,1);expect(model.active).toBe(0);
  await model.activate(c.id,1);expect(model.views).toEqual([a.id,c.id]);model.move(c.id,0);expect(model.documents).toEqual([c,a,b]);
  model.merge();expect(model.views).toEqual([c.id]);expect(model.documents).toHaveLength(3);expect(a.cursor).toBe(1);
 });
 it('reuses an open file by case insensitive path even at the tab limit',async()=>{
  const {model,open}=setup();await model.open();const a=model.current()!;model.edit(a,'local');for(let i=1;i<MAX_TEXT_TABS;i++)model.create();
  open.mockResolvedValueOnce({files:[{...file('alias'),path:a.path!.toUpperCase()}],errors:[],notes:[]});await model.open();
  expect(model.documents).toHaveLength(MAX_TEXT_TABS);expect(model.current()).toBe(a);expect(a.text).toBe('local');
 });
 it('keeps successful multi-open entries and releases later entries after the first quota failure',async()=>{
  const {model,open,close}=setup();for(let i=0;i<11;i++)model.create();open.mockResolvedValueOnce({files:[file('A'),file('B'),file('C')],errors:[],notes:[]});
  const result=await model.open();expect(result.files.map(value=>value.id)).toEqual(['A']);expect(result.errors).toHaveLength(2);expect(close.mock.calls.map(call=>call[0])).toEqual(['B','C']);expect(model.documents).toHaveLength(12);
 });
 it('switches to notes for files the host reports as owned by the notes module',async()=>{
  const {model,open}=setup();model.onNote=vi.fn();open.mockResolvedValueOnce({files:[],errors:[],notes:['same.md']});await model.open();expect(model.onNote).toHaveBeenCalledWith('same.md');expect(model.documents).toHaveLength(0);
 });
 it('rejects total UTF16 text over quota as a whole, including lazy documents',async()=>{
  const {model,restore}=setup();restore.mockResolvedValueOnce({schema:1,generation:1,documents:[{...record('A','a'),length:1}, {...record('B'),length:MAX_TEXT_LENGTH-1}],views:['A'],active:0});await model.restore();
  const a=model.current()!;expect(()=>model.edit(a,'ab')).toThrowError(expect.objectContaining({code:'quota'}));expect(a.text).toBe('a');expect(a.revision).toBe(0);expect(()=>model.create('b')).toThrowError(expect.objectContaining({code:'quota'}));
 });
 it('does not make a document dirty for view settings, but format conversion is dirty',()=>{
  const {model}=setup();const doc=model.create();model.configure(doc,{language:'json',tabSize:2,wrap:true,cursor:0});expect(doc.dirty).toBe(false);
  const generation=model.generation;model.configure(doc,{encoding:'utf16be',eol:'lf'});expect(doc.dirty).toBe(true);expect(model.generation).toBe(generation+1);
  model.edit(doc,doc.text,{encoding:'utf8',eol:'crlf'});expect(doc.encoding).toBe('utf8');expect(doc.revision).toBe(2);
 });
});

describe('explicit text saves',()=>{
 it('never writes an original file on the one second recovery debounce',async()=>{
  const {model,save,checkpoint}=setup();await model.open();const doc=model.current()!;model.edit(doc,'local');await vi.advanceTimersByTimeAsync(999);expect(checkpoint).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);
  expect(checkpoint).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();expect(doc.dirty).toBe(true);expect(doc.recoveryRevision).toBe(doc.revision);
 });
 it('does not write an unchanged named document',async()=>{
  const {model,save}=setup();await model.open();expect(await model.save()).toBe(true);expect(save).not.toHaveBeenCalled();
 });
 it('only acknowledges the captured revision when input continues during a save',async()=>{
  const {model,save}=setup();await model.open();const doc=model.current()!,pending=deferred<TextFile>();model.edit(doc,'first');save.mockImplementationOnce(()=>pending.promise);
  const saving=model.save(doc);model.edit(doc,'second');await vi.waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({text:'first'})));pending.resolve({...file('A','first'),version:'2'});await saving;
  expect(doc.text).toBe('second');expect(doc.savedRevision).toBe(1);expect(doc.revision).toBe(2);expect(doc.dirty).toBe(true);expect(save).toHaveBeenCalledOnce();
 });
 it('serializes simultaneous saves using the latest disk version without coalescing new edits',async()=>{
  const {model,save,files}=setup();await model.open();const doc=model.current()!,pending=deferred<TextFile>();model.edit(doc,'first');save.mockImplementationOnce(()=>pending.promise);
  const first=model.save();model.edit(doc,'second');const second=model.save();await vi.waitFor(()=>expect(save).toHaveBeenCalledOnce());files.set('A',{...file('A','first'),version:'2'});pending.resolve(files.get('A')!);await first;await second;
  expect(save.mock.calls[1][0]).toMatchObject({text:'second',version:'2'});expect(doc.dirty).toBe(false);
 });
 it('preserves original dirty state, path and text on save-as cancellation',async()=>{
  const {model,saveAs}=setup();await model.open();const doc=model.current()!;model.edit(doc,'local');const path=doc.path;saveAs.mockResolvedValueOnce(null as never);
  expect(await model.save(doc,true)).toBe(false);expect(doc.path).toBe(path);expect(doc.text).toBe('local');expect(doc.dirty).toBe(true);
 });
 it('updates the visible identity when save-as returns a new grant id',async()=>{
  const {model,saveAs}=setup();const doc=model.create('local');saveAs.mockResolvedValueOnce(file('new-id','local'));await model.save(doc,true);expect(model.views).toEqual(['new-id']);expect(model.current()).toBe(doc);expect(doc.dirty).toBe(false);
 });
 it('blocks mixed or CR output until an explicit conversion',async()=>{
  const {model,save}=setup();await model.open();const doc=model.current()!;model.edit(doc,'changed',{eol:'mixed'});await expect(model.save()).rejects.toMatchObject({code:'eol'});expect(save).not.toHaveBeenCalled();
  model.configure(doc,{eol:'lf'});await model.save();expect(save).toHaveBeenCalledWith(expect.objectContaining({eol:'lf'}));
 });
 it('distinguishes disk success from recovery failure',async()=>{
  const {model,checkpoint}=setup();await model.open();const doc=model.current()!;model.edit(doc,'saved');checkpoint.mockRejectedValueOnce({code:'quota',message:'空间不足'});
  expect(await model.save()).toBe(true);expect(doc.dirty).toBe(false);expect(doc.error).toBeNull();expect(model.recoveryError?.message).toContain('原文件已保存，恢复状态未更新');
 });
 it('stops save-all at a cancelled untitled document and leaves subsequent documents dirty',async()=>{
  const {model,saveAs}=setup();const a=model.create('A'),b=model.create('B');saveAs.mockResolvedValueOnce(null as never);expect(await model.saveAll()).toBe(false);expect(saveAs).toHaveBeenCalledOnce();expect(a.dirty&&b.dirty).toBe(true);
 });
});

describe('text recovery generations and lifecycle',()=>{
 it('waits for all host invalidations before taking the newest recovery snapshot',async()=>{
  const {model,invalidate,checkpoint}=setup();const invalidation=deferred<void>();invalidate.mockImplementationOnce(()=>invalidation.promise);const doc=model.create('first');const saving=model.checkpoint();model.edit(doc,'latest');
  await Promise.resolve();expect(checkpoint).not.toHaveBeenCalled();invalidation.resolve();const result=await saving;expect(checkpoint.mock.calls[0][0].documents[0].text).toBe('latest');expect(result.generation).toBe(model.generation);
 });
 it('retries an outdated recovery after editing invalidates the in-flight generation',async()=>{
  const {model,checkpoint}=setup();const doc=model.create('first'),pending=deferred<{generation:number;token:string}>();checkpoint.mockImplementationOnce(()=>pending.promise);
  const saving=model.checkpoint();await vi.waitFor(()=>expect(checkpoint).toHaveBeenCalledOnce());const old=model.generation;model.edit(doc,'second');pending.resolve({generation:old,token:'old'});const result=await saving;
  expect(checkpoint).toHaveBeenCalledTimes(2);expect(result.generation).toBe(model.generation);expect(model.commit?.token).not.toBe('old');
 });
 it('retries a host stale rejection when a newer edit superseded the checkpoint',async()=>{
  const {model,checkpoint}=setup();const doc=model.create('first'),pending=deferred<{generation:number;token:string}>();checkpoint.mockImplementationOnce(()=>pending.promise);
  const saving=model.checkpoint();await vi.waitFor(()=>expect(checkpoint).toHaveBeenCalledOnce());model.edit(doc,'second');pending.reject({code:'stale',message:'old'});expect((await saving).generation).toBe(model.generation);
 });
 it('retains dirty state and invalidates lifecycle credentials on recovery failure or new editing',async()=>{
  const {model,checkpoint}=setup();const doc=model.create('draft');await model.checkpoint();expect(model.commit).not.toBeNull();model.edit(doc,'more');expect(model.commit).toBeNull();checkpoint.mockRejectedValueOnce({code:'io',message:'failed'});
  await expect(model.checkpoint()).rejects.toMatchObject({code:'io'});expect(doc.text).toBe('more');expect(doc.dirty).toBe(true);expect(model.commit).toBeNull();
 });
 it('does not checkpoint after a failed host invalidation and allows a later edit to retry',async()=>{
  const {model,invalidate,checkpoint}=setup();invalidate.mockRejectedValueOnce({code:'io',message:'host unavailable'});const doc=model.create('draft');await expect(model.checkpoint()).rejects.toMatchObject({code:'io'});expect(checkpoint).not.toHaveBeenCalled();model.edit(doc,'retry');await model.checkpoint();expect(model.recoveryError).toBeNull();
 });
 it('restores only visible bodies then lazy loads a background document on activation',async()=>{
  const {model,restore,recover}=setup();restore.mockResolvedValueOnce({schema:1,generation:7,documents:[record('A'),record('B'),record('C')],views:['A','B'],active:1});await model.restore();
  expect(recover.mock.calls.map(call=>call[0])).toEqual(['A','B']);expect(model.documents[2].loaded).toBe(false);expect(model.documents[2].text).toBe('');await model.activate('C');expect(recover).toHaveBeenLastCalledWith('C');expect(model.current()?.text).toBe('C');
 });
 it('does not let a delayed activation replace a newer selection',async()=>{
  const {model,restore,recover}=setup();restore.mockResolvedValueOnce({schema:1,generation:1,documents:[record('A','A'),record('B'),record('C','C')],views:['A'],active:0});await model.restore();const pending=deferred<string>();recover.mockImplementationOnce(()=>pending.promise);
  const activating=model.activate('B');await model.activate('C');pending.resolve('B');await activating;expect(model.current()?.id).toBe('C');
 });
 it('rechecks restored visible originals, keeping a dirty draft and reloading a clean changed file',async()=>{
  const {model,restore,recover,files}=setup();restore.mockResolvedValueOnce({schema:1,generation:4,documents:[{...record('A'),length:1,revision:1,savedRevision:0},record('B')],views:['A','B'],active:0});recover.mockResolvedValueOnce('A').mockResolvedValueOnce('B');
  files.set('A',{...file('A','disk A'),version:'2'});files.set('B',{...file('B','disk B'),version:'2'});await model.restore();
  expect(model.documents[0].text).toBe('A');expect(model.documents[0].error?.code).toBe('conflict');expect(model.documents[1].text).toBe('disk B');expect(model.documents[1].dirty).toBe(false);
 });
 it('keeps dirty restored blob text when the original version changed',async()=>{
  const {model,restore,recover,files}=setup();restore.mockResolvedValueOnce({schema:1,generation:4,documents:[{...record('A'),length:5,revision:1,savedRevision:0}],views:['A'],active:0});recover.mockResolvedValueOnce('local');files.set('A',{...file('A','external'),version:'2'});await model.restore();
  expect(model.current()?.text).toBe('local');expect(model.current()?.error?.code).toBe('conflict');expect(model.current()?.dirty).toBe(true);
 });
 it('does not mark freshly reloaded disk content as already recovered',async()=>{
  const {model,restore,recover,files}=setup();restore.mockResolvedValueOnce({schema:1,generation:4,documents:[record('A')],views:['A'],active:0});recover.mockResolvedValueOnce('A');files.set('A',{...file('A','external'),version:'2'});await model.restore();
  const doc=model.current()!;expect(doc.text).toBe('external');expect(doc.dirty).toBe(false);expect(doc.recoveryRevision).toBeLessThan(doc.revision);await model.checkpoint();expect(doc.recoveryRevision).toBe(doc.revision);
 });
 it('preserves newer healthy text across failed lazy-recovery retries and commits it after repair',async()=>{
  const {model,restore,recover,checkpoint}=setup();restore.mockResolvedValueOnce({schema:1,generation:4,documents:[record('A','A'),record('B')],views:['A'],active:0});await model.restore();
  const a=model.current()!,b=model.documents[1];model.edit(a,'latest in-memory input');const revision=a.revision;
  recover.mockRejectedValueOnce({code:'text-recovery',message:'broken blob'});await expect(model.activate('B')).rejects.toMatchObject({code:'text-recovery'});expect(model.recoveryBlocked).toBe(true);
  recover.mockRejectedValueOnce({code:'text-recovery',message:'still broken'});await expect(model.restore()).rejects.toMatchObject({code:'text-recovery'});
  expect(model.documents).toEqual([a,b]);expect(a.text).toBe('latest in-memory input');expect(a.revision).toBe(revision);expect(restore).toHaveBeenCalledOnce();expect(checkpoint).not.toHaveBeenCalled();
  recover.mockResolvedValueOnce('B');await model.restore();expect(model.documents).toEqual([a,b]);expect(a.text).toBe('latest in-memory input');expect(a.revision).toBe(revision);expect(a.dirty).toBe(true);expect(b.loaded).toBe(true);expect(b.error).toBeNull();expect(model.recoveryBlocked).toBe(false);
  expect(checkpoint.mock.calls.at(-1)![0].documents[0]).toMatchObject({text:'latest in-memory input',revision});expect(model.commit?.generation).toBe(model.generation);expect(restore).toHaveBeenCalledOnce();
 });
 it('does not replace a live modified session with an older persisted snapshot',async()=>{
  const {model,restore}=setup();const doc=model.create('new input');await expect(model.restore()).rejects.toMatchObject({code:'recovery'});expect(model.current()).toBe(doc);expect(doc.text).toBe('new input');expect(restore).not.toHaveBeenCalled();
 });
 it('preserves corrupt metadata and refuses to replace it with an empty checkpoint',async()=>{
  const {model,restore,checkpoint,open}=setup();restore.mockResolvedValueOnce({schema:2,documents:[]} as never);await expect(model.restore()).rejects.toMatchObject({code:'recovery'});expect(model.recoveryBlocked).toBe(true);expect(()=>model.create('new draft')).toThrow();await expect(model.open()).rejects.toMatchObject({code:'recovery'});expect(open).not.toHaveBeenCalled();await expect(model.checkpoint()).rejects.toMatchObject({code:'recovery'});expect(checkpoint).not.toHaveBeenCalled();expect(await model.suspend()).toBeNull();
 });
 it('rejects a corrupt body length while preserving its metadata and the underlying recovery',async()=>{
  const {model,restore,recover,checkpoint}=setup();restore.mockResolvedValueOnce({schema:1,generation:1,documents:[record('A')],views:['A'],active:0});recover.mockResolvedValueOnce('wrong length');await expect(model.restore()).rejects.toMatchObject({code:'recovery'});expect(model.documents[0].loaded).toBe(false);await expect(model.checkpoint()).rejects.toMatchObject({code:'recovery'});expect(checkpoint).not.toHaveBeenCalled();expect(await model.suspend()).toBeNull();
 });
 it('freezes inputs while committing a suspend and resumes explicitly',async()=>{
  const {model}=setup();const doc=model.create('draft');const suspending=model.suspend();expect(()=>model.edit(doc,'late')).toThrowError(expect.objectContaining({code:'suspended'}));const commit=await suspending;expect(commit?.generation).toBe(model.generation);expect(model.frozen).toBe(true);model.resume();model.edit(doc,'awake');expect(doc.text).toBe('awake');
 });
 it('unfreezes after recovery failure during suspension',async()=>{
  const {model,checkpoint}=setup();const doc=model.create('draft');checkpoint.mockRejectedValueOnce({code:'io',message:'failed'});await expect(model.suspend()).rejects.toMatchObject({code:'io'});expect(model.frozen).toBe(false);model.edit(doc,'retry');expect(doc.text).toBe('retry');
 });
 it('still blocks destructive lifecycle when valid restored memory changed before another blob failed',async()=>{
  const {model,restore,recover,files}=setup();restore.mockResolvedValueOnce({schema:1,generation:4,documents:[record('A'),record('B')],views:['A','B'],active:0});recover.mockResolvedValueOnce('A').mockResolvedValueOnce('corrupt');files.set('A',{...file('A','new disk'),version:'2'});
  await expect(model.restore()).rejects.toMatchObject({code:'recovery'});expect(model.documents[0].text).toBe('new disk');await expect(model.suspend()).rejects.toMatchObject({code:'recovery'});expect(model.frozen).toBe(false);
 });
 it('discards a late native-open result after suspend and releases the new grants',async()=>{
  const {model,open,close}=setup();const pending=deferred<Awaited<ReturnType<TextRepository['open']>>>();open.mockImplementationOnce(()=>pending.promise);const opening=model.open();await model.suspend();pending.resolve({files:[file('A')],notes:[],errors:[]});await opening;expect(model.documents).toHaveLength(0);expect(close).toHaveBeenCalledWith('A');
 });
 it('validates duplicate views, duplicate canonical paths and aggregate UTF16 limits',()=>{
  const base:TextSnapshot={schema:1,generation:0,documents:[record('A','A'),record('B','B')],views:['A'],active:0};
  expect(()=>validateTextSnapshot({...base,views:['A','A']})).toThrow();expect(()=>validateTextSnapshot({...base,documents:[record('A','A'),{...record('B','B'),path:base.documents[0].path!.toUpperCase()}]})).toThrow();
  expect(()=>validateTextSnapshot({...base,documents:[{...record('A'),length:MAX_TEXT_LENGTH},{...record('B'),length:1}]})).toThrow();
 });
});

describe('closing and external changes',()=>{
 it('keeps a dirty tab on cancel or failed deletion, then closes only after deletion succeeds',async()=>{
  const {model,close}=setup();const doc=model.create('draft');expect(await model.close(doc,async()=>'cancel')).toBe(false);expect(close).not.toHaveBeenCalled();close.mockRejectedValueOnce({code:'io',message:'delete failed'});await expect(model.close(doc,async()=>'discard')).rejects.toMatchObject({code:'io'});expect(model.documents).toContain(doc);expect(doc.text).toBe('draft');expect(await model.close(doc,async()=>'discard')).toBe(true);expect(model.documents).not.toContain(doc);
 });
 it('does not discard text entered while a close confirmation is open',async()=>{
  const {model,close}=setup();const doc=model.create('draft'),pending=deferred<'discard'>();const closing=model.close(doc,()=>pending.promise);model.edit(doc,'newer');pending.resolve('discard');expect(await closing).toBe(false);expect(close).not.toHaveBeenCalled();expect(doc.text).toBe('newer');
 });
 it('does not close when the selected save fails or save-as is cancelled',async()=>{
  const {model,saveAs,close}=setup();const doc=model.create('draft');saveAs.mockResolvedValueOnce(null as never);expect(await model.close(doc,async()=>'save')).toBe(false);expect(close).not.toHaveBeenCalled();expect(model.documents).toContain(doc);
 });
 it('serializes pending checkpoints before deletion so a discarded draft cannot resurrect',async()=>{
  const {model,checkpoint,close}=setup();const doc=model.create('draft'),pending=deferred<{generation:number;token:string}>();checkpoint.mockImplementationOnce(()=>pending.promise);const saving=model.checkpoint();await vi.waitFor(()=>expect(checkpoint).toHaveBeenCalledOnce());const closing=model.close(doc,async()=>'discard');await Promise.resolve();expect(close).not.toHaveBeenCalled();pending.resolve({generation:model.generation,token:'saved'});await saving;await closing;await model.checkpoint();expect(checkpoint.mock.calls.at(-1)![0].documents).toHaveLength(0);
 });
 it('stops close-others on cancellation without rolling back an already discarded tab',async()=>{
  const {model}=setup();const a=model.create('A'),b=model.create('B'),c=model.create('C');const choice=vi.fn().mockResolvedValueOnce('discard').mockResolvedValueOnce('cancel');expect(await model.closeOthers(c.id,choice)).toBe(false);expect(model.documents).toEqual([b,c]);expect(model.documents).not.toContain(a);
 });
 it('refreshes clean files but keeps dirty local text and blocks in-place save on conflict',async()=>{
  const {model,files,save}=setup();await model.open();const doc=model.current()!;files.set('A',{...file('A','external'),version:'2'});await model.refresh();expect(doc.text).toBe('external');expect(doc.dirty).toBe(false);model.edit(doc,'local');files.set('A',{...file('A','other external'),version:'3'});await model.refresh();expect(doc.text).toBe('local');expect(doc.error?.code).toBe('conflict');await expect(model.save()).rejects.toMatchObject({code:'conflict'});expect(save).not.toHaveBeenCalled();
 });
 it('preserves both clean and dirty buffers on identity errors or file deletion',async()=>{
  const {model,read,files}=setup();await model.open();const doc=model.current()!;read.mockRejectedValueOnce({code:'identity',message:'重新选择'});await model.refresh();expect(doc.text).toBe('A');expect(doc.error?.code).toBe('identity');model.edit(doc,'local');files.delete('A');await model.refresh();expect(doc.text).toBe('local');expect(doc.error?.code).toBe('missing');
 });
 it.each(['identity','authorization','unauthorized','missing','permission'])('clears a resolved %s error on an unchanged disk version without replacing dirty text',async(code)=>{
  const {model,read}=setup();await model.open();const doc=model.current()!;model.edit(doc,'local draft');const revision=doc.revision;
  read.mockRejectedValueOnce({code,message:'temporarily unavailable'});await model.refresh();expect(doc.error?.code).toBe(code);
  await model.refresh();expect(doc.error).toBeNull();expect(doc.text).toBe('local draft');expect(doc.revision).toBe(revision);expect(doc.dirty).toBe(true);await expect(model.save(doc)).resolves.toBe(true);
 });
 it('revalidates a duplicate open after explicit reauthorization and restores ordinary save',async()=>{
  const {model,read,save}=setup();await model.open();const doc=model.current()!;model.edit(doc,'retained local edits');read.mockRejectedValueOnce({code:'identity',message:'reselect file'});await model.refresh();
  await model.open();expect(model.documents).toEqual([doc]);expect(doc.error).toBeNull();expect(doc.text).toBe('retained local edits');await model.save(doc);expect(save).toHaveBeenCalledOnce();
 });
 it('refreshes read-only attributes independently from bytes and retains unresolved errors',async()=>{
  const {model,files}=setup();await model.open();const doc=model.current()!;model.edit(doc,'local');files.set('A',{...file('A'),readonly:true});await model.refresh();expect(doc.readonly).toBe(true);
  doc.error={code:'permission',message:'read-only'};await model.refresh();expect(doc.error?.code).toBe('permission');files.set('A',file('A'));await model.refresh();expect(doc.readonly).toBe(false);expect(doc.error).toBeNull();
  for(const code of ['conflict','encoding','io','quota']){doc.error={code,message:'still unresolved'};await model.refresh();expect(doc.error?.code).toBe(code);}expect(doc.text).toBe('local');
 });
 it('ignores delayed external reads after the document has changed',async()=>{
  const {model,read}=setup();await model.open();const doc=model.current()!,pending=deferred<TextFile>();read.mockImplementationOnce(()=>pending.promise);const refreshing=model.refresh();model.edit(doc,'new local');pending.resolve({...file('A','stale external'),version:'2'});await refreshing;expect(doc.text).toBe('new local');expect(doc.error).toBeNull();
 });
});

it('keeps recovery serialization independent from the existing settings schema',()=>{
 const doc=new TextDocument(record('A','正文'));expect(doc.record().text).toBe('正文');expect(doc.record()).not.toHaveProperty('history');
});

describe('conditional original-file refresh',()=>{
 it('uses a body-free unchanged reply to update permissions without replacing local text or history',async()=>{
  const {model,probe,read}=setup();await model.open();const doc=model.current()!;model.edit(doc,'unsaved local input');const revision=doc.revision;doc.error={code:'identity',message:'reselect'};
  probe.mockResolvedValueOnce({kind:'unchanged',id:doc.id,version:doc.version,size:1,readonly:true});await model.refresh();
  expect(probe).toHaveBeenCalledWith(doc.id,'1');expect(read).not.toHaveBeenCalled();expect(doc.readonly).toBe(true);expect(doc.error).toBeNull();expect(doc.text).toBe('unsaved local input');expect(doc.revision).toBe(revision);expect(doc.dirty).toBe(true);
  probe.mockResolvedValueOnce({kind:'unchanged',id:doc.id,version:doc.version,size:1,readonly:false});await model.refresh();expect(doc.readonly).toBe(false);expect(doc.text).toBe('unsaved local input');
 });
 it('consumes changed clean bodies but keeps dirty text and its original baseline on conflict',async()=>{
  const {model,probe}=setup();await model.open();const doc=model.current()!;
  probe.mockResolvedValueOnce({kind:'changed',file:{...file('A','new original'),version:'2'}});await model.refresh();expect(doc.text).toBe('new original');expect(doc.version).toBe('2');expect(doc.dirty).toBe(false);
  model.edit(doc,'dirty draft');const revision=doc.revision;probe.mockResolvedValueOnce({kind:'changed',file:{...file('A','another original'),version:'3',readonly:true}});await model.refresh();
  expect(probe).toHaveBeenLastCalledWith(doc.id,'2');expect(doc.text).toBe('dirty draft');expect(doc.version).toBe('2');expect(doc.revision).toBe(revision);expect(doc.readonly).toBe(true);expect(doc.error?.code).toBe('conflict');expect(doc.dirty).toBe(true);
 });
 it.each(['unchanged','changed','error'] as const)('ignores a delayed %s probe across suspend and resume',async(kind)=>{
  const {model,probe}=setup();await model.open();const doc=model.current()!,pending=deferred<TextProbeResult>();probe.mockImplementationOnce(()=>pending.promise);const refreshing=model.refresh();
  await model.suspend();model.resume();
  if(kind==='error')pending.reject({code:'identity',message:'stale identity'});else pending.resolve(kind==='unchanged'?{kind,id:doc.id,version:doc.version,size:1,readonly:true}:{kind,file:{...file('A','stale body'),version:'2',readonly:true}});
  await refreshing;expect(doc.text).toBe('A');expect(doc.version).toBe('1');expect(doc.readonly).toBe(false);expect(doc.error).toBeNull();expect(doc.dirty).toBe(false);
 });
 it('does not apply a delayed pre-save probe to the newly saved version and keeps explicit reload complete',async()=>{
  const {model,probe,read,files}=setup();await model.open();const doc=model.current()!;model.edit(doc,'saved input');const pending=deferred<TextProbeResult>();probe.mockImplementationOnce(()=>pending.promise);const refreshing=model.refresh();await model.save(doc);
  pending.resolve({kind:'changed',file:{...file('A','obsolete original'),version:'0',readonly:true}});await refreshing;expect(doc.text).toBe('saved input');expect(doc.version).toBe('2');expect(doc.error).toBeNull();expect(doc.readonly).toBe(false);expect(doc.dirty).toBe(false);
  files.set('A',{...file('A','explicit reload'),version:'3'});read.mockClear();await model.reload(doc);expect(read).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledWith(doc.id);expect(doc.text).toBe('explicit reload');expect(doc.version).toBe('3');
 });
});

describe('checkpoint body reuse after host confirmation',()=>{
 it('persists first bodies, omits only confirmed metadata-only payloads, and keeps public snapshots complete',async()=>{
  const {model,checkpoint}=setup(),doc=model.create('durable draft');await model.checkpoint();
  expect(checkpoint.mock.calls[0][0].documents[0].text).toBe('durable draft');
  model.configure(doc,{language:'json',cursor:2,anchor:2});await model.checkpoint();
  expect(checkpoint.mock.calls[1][0].documents[0]).toMatchObject({id:doc.id,language:'json',cursor:2,length:13});expect(checkpoint.mock.calls[1][0].documents[0]).not.toHaveProperty('text');
  expect(model.snapshot().documents[0].text).toBe('durable draft');expect(doc.dirty).toBe(true);
 });
 it('resends changed bodies after a failed checkpoint instead of confirming uncommitted input',async()=>{
  const {model,checkpoint}=setup(),doc=model.create('first');await model.checkpoint();const acknowledged=doc.recoveryRevision;
  model.edit(doc,'other');checkpoint.mockRejectedValueOnce({code:'io',message:'manifest write failed'});await expect(model.checkpoint()).rejects.toMatchObject({code:'io'});
  expect(doc.recoveryRevision).toBe(acknowledged);expect(checkpoint.mock.calls[1][0].documents[0].text).toBe('other');await model.checkpoint();expect(checkpoint.mock.calls[2][0].documents[0].text).toBe('other');
  model.configure(doc,{wrap:true});await model.checkpoint();expect(checkpoint.mock.calls[3][0].documents[0]).not.toHaveProperty('text');expect(doc.text).toBe('other');
 });
 it('never treats an obsolete acknowledgement as confirmation of newer same-length text',async()=>{
  const {model,checkpoint}=setup(),doc=model.create('first'),pending=deferred<{generation:number;token:string}>();checkpoint.mockImplementationOnce(()=>pending.promise);
  const committing=model.checkpoint();await vi.waitFor(()=>expect(checkpoint).toHaveBeenCalledOnce());const generation=model.generation;model.edit(doc,'other');pending.resolve({generation,token:'old'});await committing;
  expect(checkpoint.mock.calls.map(call=>call[0].documents[0].text)).toEqual(['first','other']);expect(doc.recoveryRevision).toBe(doc.revision);expect(model.commit?.generation).toBe(model.generation);
 });
 it('sends a new document body while retaining the older confirmed document by reference',async()=>{
  const {model,checkpoint}=setup(),a=model.create('A');await model.checkpoint();const b=model.create('B');await model.checkpoint();
  const sent=checkpoint.mock.calls[1][0];expect(sent.documents.find(doc=>doc.id===a.id)).not.toHaveProperty('text');expect(sent.documents.find(doc=>doc.id===b.id)?.text).toBe('B');expect(model.snapshot().documents.map(doc=>doc.text)).toEqual(['A','B']);
 });
 it('does not reuse an old document grant acknowledgement after save-as changes its ID',async()=>{
  const {model,checkpoint,saveAs}=setup(),doc=model.create('same content');await model.checkpoint();saveAs.mockResolvedValueOnce(file('new-grant','same content'));await model.save(doc,true);
  expect(checkpoint.mock.calls[1][0].documents[0]).toMatchObject({id:'new-grant',text:'same content'});expect(model.current()).toBe(doc);expect(doc.dirty).toBe(false);
  model.configure(doc,{language:'json'});await model.checkpoint();expect(checkpoint.mock.calls[2][0].documents[0]).not.toHaveProperty('text');
 });
});


describe('native text drops and opening state', () => {
 it('reports pending selection and restores controls after cancellation or failure', async () => {
  const {model, open} = setup();
  const pending = deferred<TextOpenResult>();
  open.mockReturnValueOnce(pending.promise);
  const result = model.open();
  expect(model.opening).toBe(true);
  await expect(model.open()).rejects.toMatchObject({code: 'busy'});
  pending.resolve({files: [], notes: [], errors: []});
  await result;
  expect(model.opening).toBe(false);
  open.mockRejectedValueOnce({code: 'io', message: '读取失败'});
  await expect(model.open()).rejects.toMatchObject({code: 'io'});
  expect(model.opening).toBe(false);
 });

 it('uses dropped host grants, keeps partial errors and reuses an unsaved existing tab', async () => {
  const {model, repo, open} = setup();
  repo.openDropped = vi.fn(async () => ({files: [file('A')], notes: [], errors: [{code: 'binary', message: '二进制文件'}]}));
  const result = await model.openDropped('drop-1');
  expect(open).not.toHaveBeenCalled();
  expect(repo.openDropped).toHaveBeenCalledWith('drop-1');
  expect(result.errors).toHaveLength(1);
  const doc = model.current()!;
  model.edit(doc, '未保存修改');
  await model.openDropped('drop-2');
  expect(model.documents).toHaveLength(1);
  expect(model.current()).toBe(doc);
  expect(doc.text).toBe('未保存修改');
 });

 it('routes notes and enforces the same tab limit for dropped files', async () => {
  const {model, repo, close} = setup();
  model.onNote = vi.fn();
  for (let index = 0; index < MAX_TEXT_TABS; index++) {
   model.create();
  }
  repo.openDropped = vi.fn(async () => ({files: [file('A')], notes: ['owned.md'], errors: []}));
  const result = await model.openDropped('drop-3');
  expect(result.files).toHaveLength(0);
  expect(result.errors[0].code).toBe('tabs');
  expect(close).toHaveBeenCalledWith('A');
  expect(model.onNote).toHaveBeenCalledWith('owned.md');
  expect(model.documents).toHaveLength(MAX_TEXT_TABS);
 });
});
