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
