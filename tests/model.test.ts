import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Workbench} from '../src/model';
import type {Repository,Note} from '../src/types';

function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function setup(){
 const files=new Map<string,string>([['A.md','A'],['B.md','B'],['C.md','C']]);
 const read=vi.fn(async(path:string):Promise<Note>=>{if(!files.has(path))throw {code:'missing',message:'missing'};return {path,text:files.get(path)!,version:files.get(path)!,size:1};});
 const save=vi.fn(async(path:string,text:string,version:string)=>{if(files.get(path)!==version)throw {code:'conflict',message:'conflict'};files.set(path,text);return text;});
 const repo={read,save} as unknown as Repository;
 return {model:new Workbench(repo,async()=>true),repo,read,save,files};
}
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
describe('two-pane document transactions',()=>{
 it('keeps source left and target right through right-side navigation',async()=>{
  const {model}=setup();await model.select('A.md');const a=model.current();a.mode='edit';a.cursor=1;a.scroll=25;
  await model.follow(a,'B.md');const b=model.panes[1];b.mode='edit';b.scroll=33;
  expect(model.panes).toEqual([a,b]);await model.follow(b,'C.md');
  expect(model.panes.map(d=>d.path)).toEqual(['B.md','C.md']);expect(model.panes[0]).toBe(b);expect(b.scroll).toBe(33);expect(b.mode).toBe('edit');
 });
 it('reuses an already open target and does not split a self link',async()=>{
  const {model}=setup();await model.select('A.md');const a=model.current();await model.follow(a,'B.md');const b=model.panes[1];
  await model.follow(b,'A.md');expect(model.panes).toEqual([b,a]);await model.follow(a,'A.md');expect(model.panes).toEqual([b,a]);
  await model.select('B.md');expect(model.active).toBe(0);expect(model.panes.length).toBe(2);
 });
 it('does not evict dirty notes when saving fails',async()=>{
  const {model,save}=setup();await model.select('A.md');const a=model.current();await model.follow(a,'B.md');const b=model.panes[1];model.edit(a,'unsaved');
  save.mockRejectedValueOnce({code:'permission',message:'read only'});
  await expect(model.follow(b,'C.md')).rejects.toMatchObject({code:'permission'});
  expect(model.panes).toEqual([a,b]);expect(a.text).toBe('unsaved');expect(a.dirty).toBe(true);
 });
 it('leaves layout unchanged for a missing destination',async()=>{
  const {model}=setup();await model.select('A.md');const a=model.current();await expect(model.follow(a,'missing.md')).rejects.toMatchObject({code:'missing'});expect(model.panes).toEqual([a]);
 });
 it('discards stale navigation results',async()=>{
  const {model,read}=setup();await model.select('A.md');const a=model.current(),slow=deferred<Note>();
  read.mockImplementationOnce(()=>slow.promise);const first=model.follow(a,'B.md');await model.follow(a,'C.md');
  slow.resolve({path:'B.md',text:'B',version:'B',size:1});await first;expect(model.panes.map(d=>d.path)).toEqual(['A.md','C.md']);
 });
 it('requires a successful save before closing the right pane',async()=>{
  const {model,save}=setup();await model.select('A.md');await model.follow(model.current(),'B.md');const b=model.panes[1];model.edit(b,'B edit');save.mockRejectedValueOnce({code:'io',message:'failed'});
  await expect(model.closeRight()).rejects.toMatchObject({code:'io'});expect(model.panes.length).toBe(2);await model.closeRight();expect(model.panes.map(d=>d.path)).toEqual(['A.md']);
 });
});
describe('save and external changes',()=>{
 it('ignores a stale refresh after a newer edit has already saved',async()=>{
  const {model,read,files}=setup();await model.select('A.md');const doc=model.current(),old=deferred<Note>();read.mockImplementationOnce(()=>old.promise);
  const refresh=model.refresh();model.edit(doc,'new saved text');await model.flush(doc);old.resolve({path:'A.md',text:'A',version:'A',size:1});await refresh;
  expect(doc.text).toBe('new saved text');expect(doc.version).toBe('new saved text');expect(files.get('A.md')).toBe('new saved text');expect(doc.error).toBeNull();
 });
 it('does not let a delayed close erase newer navigation',async()=>{
  const {model,save}=setup();await model.select('A.md');const a=model.current();await model.follow(a,'B.md');
  const b=model.panes[1],pending=deferred<string>();model.edit(b,'changed');save.mockImplementationOnce(()=>pending.promise);
  const closing=model.closeRight();await model.follow(b,'C.md');pending.resolve('changed');await closing;
  expect(model.panes.map(d=>d.path)).toEqual(['B.md','C.md']);
 });
 it('queues newer edits without treating an older save as current',async()=>{
  const {model,save}=setup();await model.select('A.md');const a=model.current(),first=deferred<string>();
  model.edit(a,'first');save.mockImplementationOnce(()=>first.promise);const saving=model.flush(a);model.edit(a,'second');expect(a.dirty).toBe(true);
  save.mockResolvedValueOnce('second');first.resolve('first');await saving;
  expect(save.mock.calls.map(call=>call[1])).toEqual(['first','second']);expect(a.text).toBe('second');expect(a.dirty).toBe(false);
 });
 it('autosaves after 500 ms of idle input',async()=>{
  const {model,save}=setup();await model.select('A.md');model.edit(model.current(),'new');await vi.advanceTimersByTimeAsync(499);expect(save).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(save).toHaveBeenCalledOnce();
 });
 it('does not reload dirty buffers after an external edit',async()=>{
  const {model,files}=setup();await model.select('A.md');const a=model.current();model.edit(a,'local');files.set('A.md','external');await model.refresh();expect(a.text).toBe('local');expect(a.error?.code).toBe('conflict');
  await vi.advanceTimersByTimeAsync(1000);expect(files.get('A.md')).toBe('external');
 });
 it('refreshes clean documents and reports removed files',async()=>{
  const {model,files}=setup();await model.select('A.md');files.set('A.md','external');await model.refresh();expect(model.current().text).toBe('external');files.delete('A.md');await model.refresh();expect(model.current().error?.code).toBe('missing');
 });
 it('preserves identity when a parent directory is renamed',async()=>{
  const {model,files}=setup();files.set('old/A.md','A');await model.select('old/A.md');const doc=model.current();model.remap('old','new');expect(model.current()).toBe(doc);expect(doc.path).toBe('new/A.md');
 });
});

describe('folder operation session guard',()=>{
 it('waits for in-flight saves and flushes both panes before remapping their existing sessions',async()=>{
  const {model,files,save}=setup();files.set('old/A.md','A');files.set('old/nested/B.md','B');
  await model.select('old/A.md');const a=model.current();await model.follow(a,'old/nested/B.md');const b=model.current();
  a.mode='edit';a.cursor=3;a.scroll=45;b.mode='preview';b.cursor=2;b.scroll=62;
  model.edit(a,'A first');const pending=deferred<string>();save.mockImplementationOnce(()=>pending.promise);
  const saving=model.flush(a);model.edit(a,'A latest');model.edit(b,'B latest');
  let ready=false;const entering=model.beginFileOperation().then(release=>{ready=true;return release;});
  await Promise.resolve();expect(ready).toBe(false);expect(save).toHaveBeenCalledTimes(1);
  files.set('old/A.md','A first');pending.resolve('A first');await saving;const release=await entering;
  expect(save.mock.calls.map(([path,text])=>[path,text])).toEqual([['old/A.md','A first'],['old/A.md','A latest'],['old/nested/B.md','B latest']]);
  expect(a.dirty||b.dirty).toBe(false);
  for(const doc of [a,b]){files.set('new'+doc.path.slice(3),files.get(doc.path)!);files.delete(doc.path);}
  model.remap('old','new');release();
  expect(model.panes).toEqual([a,b]);expect(model.panes[0]).toBe(a);expect(model.panes[1]).toBe(b);expect(model.active).toBe(1);
  expect(model.records()).toEqual([{path:'new/A.md',mode:'edit',cursor:3,scroll:45},{path:'new/nested/B.md',mode:'preview',cursor:2,scroll:62}]);
  save.mockClear();model.edit(a,'A moved');model.edit(b,'B moved');await model.flushAll();
  expect(save.mock.calls.map(([path])=>path)).toEqual(['new/A.md','new/nested/B.md']);
  expect(files.has('old/A.md')||files.has('old/nested/B.md')).toBe(false);
 });
 it('unlocks automatically after a save failure while retaining the original dirty buffer',async()=>{
  const {model,save}=setup();await model.select('A.md');const a=model.current();model.edit(a,'unsaved');
  save.mockRejectedValueOnce({code:'conflict',message:'changed outside'});
  await expect(model.beginFileOperation()).rejects.toMatchObject({code:'conflict'});
  expect(model.current()).toBe(a);expect(a.path).toBe('A.md');expect(a.text).toBe('unsaved');expect(a.dirty).toBe(true);expect(a.error?.code).toBe('conflict');
  const release=await model.beginFileOperation();release();await model.select('B.md');expect(model.current().path).toBe('B.md');
 });
 it('blocks new navigation, reloads and refreshes until its idempotent release',async()=>{
  const {model,read}=setup();await model.select('A.md');const a=model.current();await model.follow(a,'B.md');const b=model.current();
  const release=await model.beginFileOperation();read.mockClear();
  await model.select('C.md');await model.follow(a,'C.md');await model.reload(a);await model.refresh();await model.closeRight();await model.clear();
  expect(read).not.toHaveBeenCalled();expect(model.panes).toEqual([a,b]);expect(model.active).toBe(1);
  await expect(model.beginFileOperation()).rejects.toMatchObject({code:'busy'});
  release();release();const nextRelease=await model.beginFileOperation();release();
  await expect(model.beginFileOperation()).rejects.toMatchObject({code:'busy'});
  nextRelease();await model.select('C.md');expect(model.current().path).toBe('C.md');
 });
 it.each(['select','follow'] as const)('discards a slow %s result without delaying a file operation',async action=>{
  const {model,read}=setup();await model.select('A.md');const a=model.current(),pending=deferred<Note>();
  read.mockImplementationOnce(()=>pending.promise);const navigation=action==='select'?model.select('B.md'):model.follow(a,'B.md');
  const release=await model.beginFileOperation();model.remap('A.md','moved/A.md');release();
  pending.resolve({path:'B.md',text:'old read',version:'old',size:8});await navigation;
  expect(model.panes).toEqual([a]);expect(a.path).toBe('moved/A.md');expect(a.error).toBeNull();
 });
 it.each(['select','follow'] as const)('ignores a stale %s read failure after the move',async action=>{
  const {model,read}=setup();await model.select('A.md');const a=model.current(),pending=deferred<Note>();
  read.mockImplementationOnce(()=>pending.promise);const navigation=action==='select'?model.select('B.md'):model.follow(a,'B.md');
  const release=await model.beginFileOperation();model.remap('A.md','moved/A.md');release();pending.reject({code:'missing',message:'old path missing'});
  await expect(navigation).resolves.toBeUndefined();expect(a.error).toBeNull();expect(model.panes).toEqual([a]);
 });
 it('does not show an obsolete large-file prompt or retry an obsolete confirmed read',async()=>{
  const {repo,read}=setup(),large=vi.fn(async()=>true),model=new Workbench(repo,large);await model.select('A.md');
  const pending=deferred<Note>();read.mockImplementationOnce(()=>pending.promise);const selecting=model.select('B.md');
  const release=await model.beginFileOperation();release();pending.reject({code:'large',message:'large file'});await selecting;expect(large).not.toHaveBeenCalled();
  const confirmation=deferred<boolean>();large.mockImplementationOnce(()=>confirmation.promise);read.mockRejectedValueOnce({code:'large',message:'large file'});
  const another=model.select('B.md');await Promise.resolve();expect(large).toHaveBeenCalledOnce();const anotherRelease=await model.beginFileOperation();anotherRelease();
  const reads=read.mock.calls.length;confirmation.resolve(true);await another;expect(read).toHaveBeenCalledTimes(reads);expect(model.current().path).toBe('A.md');
 });
 it.each(['refresh','reload'] as const)('ignores old %s text after remapping, without reading another old pane',async action=>{
  const {model,read}=setup();await model.select('A.md');const a=model.current();await model.follow(a,'B.md');const b=model.current(),pending=deferred<Note>();
  read.mockImplementationOnce(()=>pending.promise);const reading=action==='refresh'?model.refresh():model.reload(a);
  const release=await model.beginFileOperation();model.remap('A.md','moved/A.md');release();const reads=read.mock.calls.length;
  pending.resolve({path:'A.md',text:'obsolete text',version:'old',size:12});await reading;
  expect(a.text).toBe('A');expect(a.path).toBe('moved/A.md');expect(model.panes).toEqual([a,b]);expect(read).toHaveBeenCalledTimes(reads);
 });
 it.each(['refresh','reload'] as const)('ignores an old %s failure and permits autosave at the new path',async action=>{
  const {model,read,files,save}=setup();await model.select('A.md');const a=model.current(),pending=deferred<Note>();read.mockImplementationOnce(()=>pending.promise);
  const reading=action==='refresh'?model.refresh():model.reload(a),release=await model.beginFileOperation();
  files.set('moved/A.md','A');files.delete('A.md');model.remap('A.md','moved/A.md');release();
  pending.reject({code:'missing',message:'old path disappeared'});await expect(reading).resolves.toBeUndefined();expect(a.error).toBeNull();model.edit(a,'after move');
  await vi.advanceTimersByTimeAsync(500);expect(save).toHaveBeenLastCalledWith('moved/A.md','after move','A');expect(a.dirty).toBe(false);
 });
 it('cancels a navigation that already read its target but is still waiting for a save',async()=>{
  const {model,save}=setup();await model.select('A.md');const a=model.current();model.edit(a,'new');const pending=deferred<string>();save.mockImplementationOnce(()=>pending.promise);
  const navigation=model.select('B.md');await Promise.resolve();await Promise.resolve();expect(save).toHaveBeenCalledOnce();
  const entering=model.beginFileOperation();pending.resolve('new');const release=await entering;await navigation;
  expect(model.panes).toEqual([a]);release();
 });
 it('does not let an already pending workspace clear discard the guarded documents',async()=>{
  const {model,save}=setup();await model.select('A.md');const a=model.current();model.edit(a,'new');const pending=deferred<string>();save.mockImplementationOnce(()=>pending.promise);
  const clearing=model.clear(),entering=model.beginFileOperation();pending.resolve('new');await clearing;const release=await entering;
  expect(model.panes).toEqual([a]);release();
 });
 it('does not recreate a missing recovery path on startup',async()=>{
  const {model,files,save}=setup();files.delete('A.md');
  await expect(model.load('A.md')).rejects.toMatchObject({code:'missing'});await model.flushAll();
  expect(model.panes).toEqual([]);expect(save).not.toHaveBeenCalled();expect(files.has('A.md')).toBe(false);
 });
});
