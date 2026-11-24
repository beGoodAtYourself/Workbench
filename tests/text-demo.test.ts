import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {textDemoRepository,TEXT_DEMO_WARNING} from '../src/text-demo';
import {TextWorkbench} from '../src/text-model';

class MemoryStorage implements Storage {
 private values=new Map<string,string>();
 get length(){return this.values.size;}
 clear(){this.values.clear();}
 getItem(name:string){return this.values.get(name)??null;}
 setItem(name:string,value:string){this.values.set(name,String(value));}
 removeItem(name:string){this.values.delete(name);}
 key(index:number){return [...this.values.keys()][index]??null;}
}
let storage:MemoryStorage;
beforeEach(()=>{vi.useFakeTimers();storage=new MemoryStorage();vi.stubGlobal('localStorage',storage);});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
const manifest='shiye-demo-text-session-v1';

describe('browser text example storage',()=>{
 it('does not reload over input added while pending annotations are being committed',async()=>{
  const model=new TextWorkbench(textDemoRepository());await model.open();const doc=model.current()!;
  model.mark(doc,[{from:0,to:3,color:'yellow'}]);const pending=model.reload(doc);model.edit(doc,'newer user input');await pending;
  expect(doc.text).toBe('newer user input');expect(doc.dirty).toBe(true);model.dispose();
 });
 it('save and reload commit pending annotations even when original text is clean',async()=>{
  const model=new TextWorkbench(textDemoRepository());await model.open();const doc=model.current()!;
  model.mark(doc,[{from:0,to:3,color:'yellow'}]);await model.save();expect(doc.recoveryMarkRevision).toBe(doc.markRevision);expect(storage.getItem('shiye-demo-text-annotations-v1')).toContain('yellow');
  model.mark(doc,[{from:0,to:3,color:'green'}]);await model.reload(doc);expect(doc.highlights).toEqual([{from:0,to:3,color:'green'}]);expect(doc.dirty).toBe(false);
  model.mark(doc,[]);await model.saveAll();expect(storage.getItem('shiye-demo-text-annotations-v1')).not.toContain('green');model.dispose();
 });
 it('keeps background annotations across close and reopen without modifying original text or dirty state',async()=>{
  const model=new TextWorkbench(textDemoRepository());await model.open();const doc=model.current()!,text=doc.text,original=storage.getItem('shiye-demo-text-files-v1');
  model.mark(doc,[{from:0,to:3,color:'yellow'}]);expect(doc.dirty).toBe(false);
  expect(await model.close(doc)).toBe(true);expect(storage.getItem('shiye-demo-text-files-v1')).toBe(original);
  await model.open();expect(model.current()?.text).toBe(text);expect(model.current()?.highlights).toEqual([{from:0,to:3,color:'yellow'}]);
  const reloaded=new TextWorkbench(textDemoRepository());await model.checkpoint();await reloaded.restore();expect(reloaded.current()?.highlights).toEqual([{from:0,to:3,color:'yellow'}]);
  model.dispose();reloaded.dispose();
 });
 it('preserves saved highlights when unsaved text and its highlights are discarded',async()=>{
  const model=new TextWorkbench(textDemoRepository());await model.open();const doc=model.current()!;
  model.mark(doc,[{from:0,to:3,color:'yellow'}]);await model.checkpoint();model.edit(doc,'changed body');model.mark(doc,[{from:0,to:7,color:'pink'}]);
  await model.close(doc,async()=> 'discard');await model.open();expect(model.current()?.highlights).toEqual([{from:0,to:3,color:'yellow'}]);
  model.mark(model.current()!,[]);await model.close();await model.open();expect(model.current()?.highlights).toEqual([]);model.dispose();
 });
 it('annotation write failure keeps the tab and recoverable marks available for retry',async()=>{
  const model=new TextWorkbench(textDemoRepository());await model.open();const doc=model.current()!;model.mark(doc,[{from:0,to:3,color:'green'}]);
  const set=storage.setItem.bind(storage);vi.spyOn(storage,'setItem').mockImplementation((name,value)=>{if(name==='shiye-demo-text-annotations-v1')throw new Error('quota');set(name,value);});
  await expect(model.close(doc)).rejects.toBeDefined();expect(model.documents).toContain(doc);expect(doc.highlights).toEqual([{from:0,to:3,color:'green'}]);expect(storage.getItem(manifest)).toContain('green');
  vi.mocked(storage.setItem).mockRestore();await model.close(doc);await model.open();expect(model.current()?.highlights).toEqual([{from:0,to:3,color:'green'}]);model.dispose();
 });
 it('opens fixed examples and explicitly identifies browser-only saves',async()=>{
  const repo=textDemoRepository(),opened=await repo.open();expect(opened.files.map(file=>file.name)).toEqual(['config.json','readme.txt']);expect((await repo.restore()).warning).toBe(TEXT_DEMO_WARNING);expect(TEXT_DEMO_WARNING).toContain('不会操作磁盘文件');
 });
 it('stores recovery bodies separately from metadata and existing application settings',async()=>{
  storage.setItem('shiye-demo-settings','{"root":"unchanged"}');const repo=textDemoRepository(),model=new TextWorkbench(repo);const doc=model.create('私有正文😀');await model.checkpoint();
  expect(storage.getItem(manifest)).not.toContain('私有正文');expect(storage.getItem('shiye-demo-settings')).toBe('{"root":"unchanged"}');
  const recovered=new TextWorkbench(textDemoRepository());await recovered.restore();expect(recovered.current()?.text).toBe('私有正文😀');expect(recovered.current()?.dirty).toBe(true);expect(recovered.current()?.id).toBe(doc.id);
 });
 it('keeps the previously committed manifest when a body write fails',async()=>{
  const repo=textDemoRepository(),model=new TextWorkbench(repo);const doc=model.create('old');await model.checkpoint();const previous=storage.getItem(manifest),set=storage.setItem.bind(storage);model.edit(doc,'new');
  vi.spyOn(storage,'setItem').mockImplementation((name,value)=>{if(name.startsWith('shiye-demo-text-body'))throw new Error('quota');set(name,value);});
  await expect(model.checkpoint()).rejects.toMatchObject({code:'recovery'});expect(storage.getItem(manifest)).toBe(previous);expect(doc.text).toBe('new');expect(doc.dirty).toBe(true);
 });
 it('keeps the previous valid session when switching the manifest fails',async()=>{
  const repo=textDemoRepository(),model=new TextWorkbench(repo);const doc=model.create('old');await model.checkpoint();const previous=storage.getItem(manifest),set=storage.setItem.bind(storage);model.edit(doc,'new');
  vi.spyOn(storage,'setItem').mockImplementation((name,value)=>{if(name===manifest)throw new Error('quota');set(name,value);});
  await expect(model.checkpoint()).rejects.toMatchObject({code:'recovery'});expect(storage.getItem(manifest)).toBe(previous);const recovered=new TextWorkbench(textDemoRepository());await recovered.restore();expect(recovered.current()?.text).toBe('old');
 });
 it('confirms a committed generation even when obsolete body cleanup fails',async()=>{
  const model=new TextWorkbench(textDemoRepository()),doc=model.create('old');await model.checkpoint();model.edit(doc,'new');vi.spyOn(storage,'removeItem').mockImplementation(()=>{throw new Error('locked');});
  const result=await model.checkpoint();expect(result.warning).toContain('旧草稿清理失败');expect(result.generation).toBe(model.generation);const recovered=new TextWorkbench(textDemoRepository());await recovered.restore();expect(recovered.current()?.text).toBe('new');
 });
 it('preserves corrupt metadata and prevents an empty replacement',async()=>{
  storage.setItem(manifest,'{broken');const model=new TextWorkbench(textDemoRepository());await expect(model.restore()).rejects.toMatchObject({code:'recovery'});expect(()=>model.create('fresh')).toThrow();await expect(model.checkpoint()).rejects.toMatchObject({code:'recovery'});expect(storage.getItem(manifest)).toBe('{broken');
 });
 it('rejects a same-length corrupted body without deleting or replacing it',async()=>{
  const model=new TextWorkbench(textDemoRepository());model.create('original');await model.checkpoint();const body=JSON.parse(storage.getItem(manifest)!).documents[0].blob as string;storage.setItem(body,'modified');const previous=storage.getItem(manifest),restored=new TextWorkbench(textDemoRepository());
  await expect(restored.restore()).rejects.toMatchObject({code:'recovery'});expect(storage.getItem(body)).toBe('modified');await expect(restored.checkpoint()).rejects.toMatchObject({code:'recovery'});expect(storage.getItem(manifest)).toBe(previous);
 });
 it('deletes discarded references so that a closed draft does not return on restart',async()=>{
  const model=new TextWorkbench(textDemoRepository()),a=model.create('discard'),b=model.create('keep');await model.checkpoint();expect(await model.close(a,async()=>'discard')).toBe(true);
  const recovered=new TextWorkbench(textDemoRepository());await recovered.restore();expect(recovered.documents.map(doc=>doc.id)).toEqual([b.id]);expect(recovered.current()?.text).toBe('keep');
 });
 it('keeps the buffer and draft when a close manifest update fails',async()=>{
  const model=new TextWorkbench(textDemoRepository()),doc=model.create('draft');await model.checkpoint();const previous=storage.getItem(manifest),set=storage.setItem.bind(storage);vi.spyOn(storage,'setItem').mockImplementation((name,value)=>{if(name===manifest)throw new Error('locked');set(name,value);});
  await expect(model.close(doc,async()=>'discard')).rejects.toMatchObject({code:'recovery'});expect(model.documents).toContain(doc);expect(doc.text).toBe('draft');expect(storage.getItem(manifest)).toBe(previous);
 });
 it('retries a repaired body in the same session without losing newer healthy input',async()=>{
  const initial=new TextWorkbench(textDemoRepository()),a=initial.create('A'),b=initial.create('B');await initial.activate(a.id);await initial.checkpoint();
  const body=JSON.parse(storage.getItem(manifest)!).documents.find((doc:{id:string})=>doc.id===b.id).blob as string;
  const restored=new TextWorkbench(textDemoRepository());await restored.restore();const liveA=restored.current()!;restored.edit(liveA,'newer A');storage.setItem(body,'X');
  await expect(restored.activate(b.id)).rejects.toMatchObject({code:'recovery'});await expect(restored.restore()).rejects.toMatchObject({code:'recovery'});expect(liveA.text).toBe('newer A');
  storage.setItem(body,'B');await restored.restore();expect(restored.recoveryBlocked).toBe(false);expect(restored.current()).toBe(liveA);expect(liveA.text).toBe('newer A');expect(restored.commit?.generation).toBe(restored.generation);
  const restarted=new TextWorkbench(textDemoRepository());await restarted.restore();expect(restarted.current()?.text).toBe('newer A');
 });
 it('clears only the repaired body failure until every known damaged body has been revalidated',async()=>{
  const repo=textDemoRepository(),model=new TextWorkbench(repo),a=model.create('one'),b=model.create('two');await model.checkpoint();
  const documents=JSON.parse(storage.getItem(manifest)!).documents as Array<{id:string;blob:string}>;
  const aBody=documents.find(doc=>doc.id===a.id)!.blob,bBody=documents.find(doc=>doc.id===b.id)!.blob;storage.setItem(aBody,'xxx');storage.setItem(bBody,'yyy');
  await expect(repo.recover(a.id)).rejects.toMatchObject({code:'recovery'});await expect(repo.recover(b.id)).rejects.toMatchObject({code:'recovery'});
  storage.setItem(aBody,'one');expect(await repo.recover(a.id)).toBe('one');await expect(repo.checkpoint(model.snapshot())).rejects.toMatchObject({code:'recovery'});
  storage.setItem(bBody,'two');expect(await repo.recover(b.id)).toBe('two');expect((await repo.checkpoint(model.snapshot())).generation).toBe(model.generation);
 });
 it('does not clear a metadata failure merely by validating a known body',async()=>{
  const repo=textDemoRepository(),model=new TextWorkbench(repo),doc=model.create('draft');await model.checkpoint();const previous=storage.getItem(manifest)!;
  storage.setItem(manifest,'{broken');await expect(repo.restore()).rejects.toMatchObject({code:'recovery'});storage.setItem(manifest,previous);expect(await repo.recover(doc.id)).toBe('draft');await expect(repo.checkpoint(model.snapshot())).rejects.toMatchObject({code:'recovery'});
  await repo.restore();expect((await repo.checkpoint(model.snapshot())).generation).toBe(model.generation);
 });
});

describe('metadata-only checkpoints preserve real browser recovery bodies',()=>{
 it('reuses confirmed host bodies through metadata edits, lazy activation and restart',async()=>{
  const first=new TextWorkbench(textDemoRepository()),a=first.create('persistent A'),b=first.create('persistent B');await first.activate(a.id);await first.checkpoint();
  const repo=textDemoRepository(),checkpoint=vi.spyOn(repo,'checkpoint'),restored=new TextWorkbench(repo);await restored.restore();expect(restored.documents.find(doc=>doc.id===b.id)?.loaded).toBe(false);
  restored.configure(restored.current()!,{language:'json',wrap:true});await restored.checkpoint();expect(checkpoint.mock.calls[0][0].documents.every(doc=>doc.text===undefined)).toBe(true);expect(restored.snapshot().documents.find(doc=>doc.id===a.id)?.text).toBe('persistent A');
  await restored.activate(b.id);expect(restored.current()?.text).toBe('persistent B');await restored.checkpoint();expect(checkpoint.mock.calls[1][0].documents.every(doc=>doc.text===undefined)).toBe(true);
  const restarted=new TextWorkbench(textDemoRepository());await restarted.restore();expect(restarted.current()?.text).toBe('persistent B');await restarted.activate(a.id);expect(restarted.current()?.text).toBe('persistent A');expect(restarted.current()?.language).toBe('json');expect(restarted.current()?.wrap).toBe(true);
 });
});

describe('browser original-file probes',()=>{
 it('keeps legacy reads complete and returns no body for an unchanged version, including permission-only changes',async()=>{
  const repo=textDemoRepository(),opened=await repo.open(),original=opened.files[0];
  expect(await repo.read(original.id)).toEqual(original);expect(await repo.read(original.id)).not.toHaveProperty('kind');
  const unchanged=await repo.probe(original.id,original.version);expect(unchanged).toEqual({kind:'unchanged',id:original.id,version:original.version,size:original.size,readonly:false});expect(unchanged).not.toHaveProperty('text');expect(unchanged).not.toHaveProperty('file');
  storage.setItem('shiye-demo-text-files-v1',JSON.stringify(opened.files.map(file=>file.id===original.id?{...file,readonly:true}:file)));
  expect(await repo.probe(original.id,original.version)).toEqual({...unchanged,readonly:true});expect((await repo.read(original.id)).text).toBe(original.text);
 });
 it('returns the full newly observed body for a changed version and never grants access through a known version',async()=>{
  const repo=textDemoRepository(),opened=await repo.open(),original=opened.files[0],changed={...original,text:'external change',version:'2',size:15};
  storage.setItem('shiye-demo-text-files-v1',JSON.stringify(opened.files.map(file=>file.id===original.id?changed:file)));expect(await repo.probe(original.id,original.version)).toEqual({kind:'changed',file:changed});
  await expect(repo.probe('not-granted','2')).rejects.toMatchObject({code:'unauthorized'});await repo.close(original.id);await expect(repo.probe(original.id,'2')).rejects.toMatchObject({code:'unauthorized'});
  await repo.open();storage.setItem('shiye-demo-text-files-v1',JSON.stringify(opened.files.filter(file=>file.id!==original.id)));await expect(repo.probe(original.id,'2')).rejects.toMatchObject({code:'missing'});
 });
});
