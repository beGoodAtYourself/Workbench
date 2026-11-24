import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {applyFolderOrder,folderDropIntent} from '../src/folder-tree';
import {demoRepository} from '../src/demo';
import type {Entry,FolderAction,Repository} from '../src/types';

const folder=(path:string):Entry=>({path,name:path.split('/').at(-1)!,kind:'folder'});
const note=(path:string):Entry=>({...folder(path),kind:'note'});
const paths=(entries:Entry[])=>entries.map(item=>item.path);

describe('folder ordering and drop intent',()=>{
 it('matches locale-independent Rust name sorting and keeps folders before notes',()=>{
  const entries=[note('a.md'),folder('中'),folder('😀'),folder('\uE000'),folder('b'),folder('A'),note('Z.md')];
  expect(paths(applyFolderOrder(entries))).toEqual(['A','b','中','\uE000','😀','a.md','Z.md']);
  expect(entries[0].path).toBe('a.md');
 });
 it('keeps valid preferences, ignores missing and duplicate paths, appends new folders by name',()=>{
  expect(paths(applyFolderOrder([folder('A'),note('0.md'),folder('C'),folder('B')],['missing','c','C']))).toEqual(['C','A','B','0.md']);
 });
 it('applies note and folder ranks only inside their own groups, including mixed legacy records',()=>{
  const entries=[note('a.md'),folder('A'),note('c.md'),folder('C'),note('b.md'),folder('B')];
  expect(paths(applyFolderOrder(entries,['c.md','C','a.md','A']))).toEqual(['C','A','B','c.md','a.md','b.md']);
  expect(paths(applyFolderOrder(entries,['C','A']))).toEqual(['C','A','B','a.md','b.md','c.md']);
 });
 it('generates sibling and cross-parent insertion intents',()=>{
  expect(folderDropIntent('A','B','before')).toEqual({source:'A',parent:'',anchor:'B',placement:'before'});
  expect(folderDropIntent('A/sub','B/sub','after')).toEqual({source:'A/sub',parent:'B',anchor:'B/sub',placement:'after'});
  expect(folderDropIntent('A/sub','A','before')).toEqual({source:'A/sub',parent:'',anchor:'A',placement:'before'});
 });
 it('allows moving inside a folder and back to the root',()=>{
  expect(folderDropIntent('A','B','inside')).toEqual({source:'A',parent:'B',placement:'inside'});
  expect(folderDropIntent('A/sub','','inside')).toEqual({source:'A/sub',parent:'',placement:'inside'});
 });
 it('produces note insertion and directory movement intents without guessing kinds from filenames',()=>{
  expect(folderDropIntent('A.md','B.md','after')).toEqual({source:'A.md',parent:'',anchor:'B.md',placement:'after'});
  expect(folderDropIntent('A/doc.md','B/doc.md','before')).toEqual({source:'A/doc.md',parent:'B',anchor:'B/doc.md',placement:'before'});
  expect(folderDropIntent('A.md','B','inside')).toEqual({source:'A.md',parent:'B',placement:'inside'});
  expect(folderDropIntent('A/doc.md','','inside')).toEqual({source:'A/doc.md',parent:'',placement:'inside'});
 });
 it.each([
  ['','A','inside'],['A','a','before'],['A','a/sub','inside'],['A','A/sub','after'],
  ['A','','before'],['A','','inside'],['A/sub','a','inside'],['../A','B','inside'],
  ['A','/outside','inside'],['A','C:\\outside','inside'],['A','B/../C','inside'],
 ] as const)('rejects root, self, descendants, no-op parent and invalid paths: %s → %s (%s)',(source,target,position)=>{
  expect(folderDropIntent(source,target,position)).toBeNull();
 });
});

class MemoryStorage {
 values=new Map<string,string>();
 getItem=vi.fn((name:string)=>this.values.get(name)??null);
 setItem=vi.fn((name:string,value:string)=>{this.values.set(name,value);});
 removeItem=(name:string)=>{this.values.delete(name);};
}
let storage:MemoryStorage;
const orderStorageKey='shiye-demo-folder-order:'+encodeURIComponent('演示笔记');
function seed(folders=['A','B','C'],files:Record<string,string>={}){
 storage.values.set('shiye-demo-folders',JSON.stringify(folders));
 storage.values.set('shiye-demo-files',JSON.stringify(files));
 return demoRepository();
}
async function action(repo:Repository,fields:Omit<FolderAction,'root'|'revision'>){
 const order=await repo.folderOrder();return repo.arrangeFolder({...fields,root:order.root,revision:order.revision});
}
const reorder=(repo:Repository,source:string,anchor:string,placement:'before'|'after'='before')=>action(repo,{source,parent:anchor.includes('/')?anchor.slice(0,anchor.lastIndexOf('/')):'',anchor,placement});
const move=(repo:Repository,source:string,parent:string)=>action(repo,{source,parent,placement:'inside'});
beforeEach(()=>{storage=new MemoryStorage();vi.stubGlobal('localStorage',storage);vi.stubGlobal('location',{search:''});});
afterEach(()=>vi.unstubAllGlobals());

describe('demo folder repository',()=>{
 it('persists custom order and empty folders across repository reloads',async()=>{
  const repo=seed();await reorder(repo,'C','A');await repo.create('','D',true);
  expect(paths(await demoRepository().list(''))).toEqual(['C','A','B','D']);
  expect((await demoRepository().folderOrder()).parents['']).toEqual(['C','A','B','D']);
 });
 it('isolates orders by normalized root and rejects previous workspace requests',async()=>{
  const repo=seed();await repo.workspace('C:\\Notes');await reorder(repo,'C','A');const stale=await repo.folderOrder();
  await repo.workspace('D:\\Notes');expect(paths(await repo.list(''))).toEqual(['A','B','C']);
  await expect(repo.arrangeFolder({...stale,source:'A',parent:'',anchor:'B',placement:'after'})).rejects.toMatchObject({code:'workspace'});
  await reorder(repo,'B','A');await repo.workspace('c:/notes/');expect(paths(await repo.list(''))).toEqual(['C','A','B']);
  await repo.workspace('D:\\Notes');expect(paths(await repo.list(''))).toEqual(['B','A','C']);
 });
 it('invalidates old requests even after switching back to the same root',async()=>{
  const repo=seed(),old=await repo.folderOrder();await repo.workspace('other');await repo.workspace(old.root);
  await expect(repo.arrangeFolder({...old,source:'C',parent:'',anchor:'A',placement:'before'})).rejects.toMatchObject({code:'stale'});
 });
 it('returns immutable snapshots and rejects stale revisions',async()=>{
  const repo=seed(),old=await repo.folderOrder();await reorder(repo,'C','A');
  const snapshot=await repo.folderOrder();snapshot.parents[''].reverse();
  expect(paths(await repo.list(''))).toEqual(['C','A','B']);
  await expect(repo.arrangeFolder({...old,source:'B',parent:'',anchor:'C',placement:'before'})).rejects.toMatchObject({code:'stale'});
 });
 it('does not save or advance revision for original insertion and existing parent',async()=>{
  const repo=seed(),before=await repo.folderOrder();storage.setItem.mockClear();
  expect((await reorder(repo,'A','B')).order.revision).toBe(before.revision);
  expect((await move(repo,'B','')).moved).toBe(false);
  expect(storage.setItem).not.toHaveBeenCalled();
 });
 it('appends external additions and treats external rename as delete plus add',async()=>{
  const repo=seed();await reorder(repo,'C','A');
  storage.values.set('shiye-demo-folders',JSON.stringify(['A','B','C','Z','D']));
  expect(paths(await repo.list(''))).toEqual(['C','A','B','D','Z']);
  storage.values.set('shiye-demo-folders',JSON.stringify(['A','B','Y','Z','D']));
  expect(paths(await repo.list(''))).toEqual(['A','B','D','Z','Y']);
 });
 it('preserves unread subtree preferences and does not clear on failed listing',async()=>{
  const repo=seed(['A','A/one','A/two','B']);await reorder(repo,'A/two','A/one');const before=await repo.folderOrder();
  await repo.list('');expect((await repo.folderOrder()).parents.A).toEqual(['A/two','A/one']);
  storage.getItem.mockImplementation(name=>{if(name==='shiye-demo-folders')throw new Error('denied');return storage.values.get(name)??null;});
  await expect(repo.list('A')).rejects.toMatchObject({code:'io'});expect(await repo.folderOrder()).toEqual(before);
 });
 it('cleans the records of externally removed subtrees only after parent listing succeeds',async()=>{
  const repo=seed(['A','A/one','A/two','B']);await reorder(repo,'A/two','A/one');
  storage.values.set('shiye-demo-folders',JSON.stringify(['B']));
  await expect(repo.list('A')).rejects.toMatchObject({code:'missing'});expect((await repo.folderOrder()).parents.A).toBeDefined();
  await repo.list('');expect((await repo.folderOrder()).parents.A).toBeUndefined();
 });
 it('maps folder rename and descendant sequences while default parents follow the new name',async()=>{
  const repo=seed(['A','A/one','A/two','B','C']);await reorder(repo,'A/two','A/one');
  await repo.rename('A','Z');expect(paths(await repo.list(''))).toEqual(['B','C','Z']);
  expect((await repo.folderOrder()).parents.Z).toEqual(['Z/two','Z/one']);
  await reorder(repo,'Z','B');await repo.rename('Z','Y');expect(paths(await repo.list(''))).toEqual(['Y','B','C']);
 });
 it('resets only the selected sibling order and cleans recycled folder records',async()=>{
  const repo=seed(['A','A/one','A/two','B','C']);await reorder(repo,'A/two','A/one');await reorder(repo,'C','A');
  await action(repo,{source:'',parent:'',placement:'reset'});expect(paths(await repo.list(''))).toEqual(['A','B','C']);
  expect((await repo.folderOrder()).parents.A).toEqual(['A/two','A/one']);
  await repo.recycle('A');expect((await repo.folderOrder()).parents.A).toBeUndefined();expect(paths(await demoRepository().list(''))).toEqual(['B','C']);
 });
 it('moves all contents, appends at destination and maps nested order',async()=>{
  const repo=seed(['A','A/资料','A/资料/one','A/资料/two','B','B/older'],{'A/资料/note.md':'中文\r\n正文','A/资料/image.bin':'\u0000\u00ff','B/stay.md':'stay'});
  await reorder(repo,'A/资料/two','A/资料/one');const result=await move(repo,'A/资料','B');
  expect(result).toMatchObject({path:'B/资料',moved:true});expect(paths(await repo.list('B'))).toEqual(['B/older','B/资料','B/stay.md']);
  expect((await repo.read('B/资料/note.md')).text).toBe('中文\r\n正文');await expect(repo.read('A/资料/note.md')).rejects.toMatchObject({code:'missing'});
  expect(JSON.parse(storage.values.get('shiye-demo-files')!)['B/资料/image.bin']).toBe('\u0000\u00ff');
  expect(result.order.parents['B/资料']).toEqual(['B/资料/two','B/资料/one','B/资料/note.md']);
  expect((await move(repo,'B/资料','')).path).toBe('资料');expect(paths(await repo.list(''))).toEqual(['A','B','资料']);
 });
 it('inserts across parents at an anchor and removes the old parent sequence entry',async()=>{
  const repo=seed(['A','A/x','A/y','B','B/one','B/two']);await reorder(repo,'A/y','A/x');
  await reorder(repo,'A/y','B/two');expect(paths(await repo.list('B'))).toEqual(['B/one','B/y','B/two']);
  expect((await repo.folderOrder()).parents.A).toEqual(['A/x']);
 });
 it.each([
  {source:'',parent:'B',placement:'inside'},
  {source:'A',parent:'a',placement:'inside'},
  {source:'A',parent:'A/sub',placement:'inside'},
  {source:'../A',parent:'B',placement:'inside'},
  {source:'A',parent:'C:\\outside',placement:'inside'},
 ] as const)('rejects unsafe movement without mutating storage: $source → $parent',async fields=>{
  const repo=seed(['A','A/sub','B']);const before=new Map(storage.values);
  await expect(action(repo,fields)).rejects.toMatchObject({code:'boundary'});expect(storage.values).toEqual(before);
 });
 it('matches source and target paths case-insensitively and rejects a conflicting file',async()=>{
  const repo=seed(['A','A/Item','B'],{'B/item':'binary'});
  await expect(move(repo,'a/item','b')).rejects.toMatchObject({code:'exists'});
  storage.values.set('shiye-demo-files','{}');expect((await move(repo,'a/item','b')).path).toBe('B/Item');
 });
 it('rejects an anchor that disappeared, moved or became a note before commit',async()=>{
  const repo=seed(['A','A/x','B','B/anchor']),order=await repo.folderOrder();
  const fields={root:order.root,revision:order.revision,source:'A/x',parent:'B',anchor:'B/anchor',placement:'before' as const};
  storage.values.set('shiye-demo-folders',JSON.stringify(['A','A/x','B','A/anchor']));
  await expect(repo.arrangeFolder(fields)).rejects.toMatchObject({code:'missing'});
  await expect(repo.arrangeFolder({...fields,anchor:'A/anchor'})).rejects.toMatchObject({code:'stale'});
  storage.values.set('shiye-demo-files',JSON.stringify({'B/anchor':'not a folder'}));
  await expect(repo.arrangeFolder(fields)).rejects.toMatchObject({code:'missing'});expect(paths(await repo.list('A'))).toContain('A/x');
 });
 it('rolls back a pure sorting preference failure',async()=>{
  const repo=seed();await reorder(repo,'C','A');const before=await repo.folderOrder(),saved=storage.values.get(orderStorageKey);
  storage.setItem.mockImplementation((name,value)=>{if(name===orderStorageKey)throw new Error('quota');storage.values.set(name,value);});
  await expect(reorder(repo,'B','C')).rejects.toMatchObject({code:'order'});
  expect(await repo.folderOrder()).toEqual(before);expect(storage.values.get(orderStorageKey)).toBe(saved);expect(paths(await repo.list(''))).toEqual(['C','A','B']);
 });
 it('preserves moved paths on metadata failure and retries the in-memory order',async()=>{
  const repo=seed(['A','A/sub','B'],{'A/sub/note.md':'keep'});
  storage.setItem.mockImplementation((name,value)=>{if(name===orderStorageKey)throw new Error('quota');storage.values.set(name,value);});
  const result=await move(repo,'A/sub','B');expect(result).toMatchObject({path:'B/sub',moved:true,warning:expect.stringContaining('顺序未保存')});
  expect((await repo.read('B/sub/note.md')).text).toBe('keep');expect((await repo.folderOrder()).warning).toBeDefined();
  storage.setItem.mockImplementation((name,value)=>{storage.values.set(name,value);});
  expect((await repo.retryFolderOrder(result.order.root)).warning).toBeUndefined();
  expect((await demoRepository().folderOrder()).parents.B).toEqual(['B/sub']);
 });
 it('keeps actual rename and recycle results when their metadata cannot be saved',async()=>{
  const repo=seed();await reorder(repo,'C','A');storage.setItem.mockImplementation((name,value)=>{if(name===orderStorageKey)throw new Error('quota');storage.values.set(name,value);});
  expect(await repo.rename('C','Z')).toBe('Z');expect((await repo.folderOrder()).warning).toBeDefined();
  await repo.recycle('Z');expect(paths(await repo.list(''))).toEqual(['A','B']);expect((await repo.folderOrder()).parents['']).toEqual(['A','B']);
 });
 it.each(['{broken',' '.repeat(1024*1024+1),JSON.stringify({version:1,root:'演示笔记',revision:'0',parents:{A:['B']}})])('preserves corrupt or oversized stored order instead of overwriting it',async raw=>{
  const repo=seed();storage.values.set(orderStorageKey,raw);expect((await repo.folderOrder()).warning).toBeDefined();
  expect(paths(await repo.list(''))).toEqual(['A','B','C']);await expect(reorder(repo,'C','A')).rejects.toMatchObject({code:'order'});
  expect(storage.values.get(orderStorageKey)).toBe(raw);
  storage.values.delete(orderStorageKey);expect((await repo.retryFolderOrder('演示笔记')).warning).toBeUndefined();await reorder(repo,'C','A');
 });
 it('handles valid directory names that are JavaScript object prototype keys',async()=>{
  const repo=seed(['__proto__','__proto__/A','__proto__/B','constructor']);
  expect(paths(await repo.list('__proto__'))).toEqual(['__proto__/A','__proto__/B']);await reorder(repo,'__proto__/B','__proto__/A');
  expect(paths(await demoRepository().list('__proto__'))).toEqual(['__proto__/B','__proto__/A']);
 });
 it('rejects a new sequence exceeding the size bound without replacing saved preferences',async()=>{
  const names=Array.from({length:3700},(_,i)=>String(i).padStart(4,'0')+'目'.repeat(96));
  const repo=seed(names),before=await repo.folderOrder();await expect(reorder(repo,names.at(-1)!,names[0])).rejects.toMatchObject({code:'order'});
  expect(await repo.folderOrder()).toEqual(before);expect(storage.values.has(orderStorageKey)).toBe(false);
 });
 it('can retry pending moved paths after a damaged preference record is repaired',async()=>{
  const repo=seed(['A','A/sub','B']);storage.values.set(orderStorageKey,'{broken');
  const result=await move(repo,'A/sub','B');expect(result.moved).toBe(true);expect(result.warning).toBeDefined();
  await expect(repo.retryFolderOrder(result.order.root)).rejects.toMatchObject({code:'order'});expect(storage.values.get(orderStorageKey)).toBe('{broken');
  storage.values.delete(orderStorageKey);expect((await repo.retryFolderOrder(result.order.root)).parents.B).toEqual(['B/sub']);
  expect((await demoRepository().folderOrder()).parents.B).toEqual(['B/sub']);
 });
 it('does not overwrite preference bytes changed externally after loading',async()=>{
  const repo=seed();await reorder(repo,'C','A');const before=await repo.folderOrder();storage.values.set(orderStorageKey,'external change');
  await expect(reorder(repo,'A','C')).rejects.toMatchObject({code:'stale'});expect(storage.values.get(orderStorageKey)).toBe('external change');expect(await repo.folderOrder()).toEqual(before);
 });
});

describe('demo Markdown-note arrangement',()=>{
 it('persists sibling note order independently of the folder group and restores old folder records',async()=>{
  const repo=seed(['A','B','C'],{'a.md':'a','b.md':'b','c.md':'c'});
  storage.values.set(orderStorageKey,JSON.stringify({version:1,root:'演示笔记',revision:'1',parents:{'':['C','A','B']}}));
  expect(paths(await repo.list(''))).toEqual(['C','A','B','a.md','b.md','c.md']);
  await reorder(repo,'c.md','a.md');expect(paths(await demoRepository().list(''))).toEqual(['C','A','B','c.md','a.md','b.md']);
  expect(JSON.parse(storage.values.get('shiye-demo-files')!)).toEqual({'a.md':'a','b.md':'b','c.md':'c'});
 });
 it('appends each new item within its own group and keeps earlier additions stable',async()=>{
  const repo=seed(['A'],{'a.md':'a','c.md':'c'});await reorder(repo,'c.md','a.md');
  await repo.create('','D',true);await repo.create('','z',false);
  expect(paths(await repo.list(''))).toEqual(['A','D','c.md','a.md','z.md']);
  await repo.create('','B',true);await repo.create('','b',false);
  expect(paths(await repo.list(''))).toEqual(['A','D','B','c.md','a.md','z.md','b.md']);
 });
 it('rejects anchors from another kind instead of crossing the folder/note group boundary',async()=>{
  const repo=seed(['A','B'],{'a.md':'a','b.md':'b'}),before=new Map(storage.values);
  await expect(reorder(repo,'a.md','A')).rejects.toMatchObject({code:'order'});
  await expect(reorder(repo,'B','b.md','after')).rejects.toMatchObject({code:'order'});
  expect(storage.values).toEqual(before);
 });
 it('moves a note inside a directory and back to root without touching siblings or its text',async()=>{
  const text='\uFEFF中文\r\n\r\n[链接](next.md)\r\n',repo=seed(['A','B','B/folder'],{'A/doc.MD':text,'A/stay.md':'source sibling','B/z.md':'destination sibling','root.md':'root'});
  const noteBefore=await repo.read('A/doc.MD');const result=await move(repo,'a/DOC.md','b');
  expect(result).toMatchObject({path:'B/doc.MD',moved:true});expect(paths(await repo.list('B'))).toEqual(['B/folder','B/z.md','B/doc.MD']);
  expect((await repo.read('B/doc.MD')).text).toBe(text);expect((await repo.read('A/stay.md')).text).toBe('source sibling');
  await expect(repo.save('A/doc.MD','should not recreate',noteBefore.version)).rejects.toMatchObject({code:'missing'});
  await repo.save('B/doc.MD',text+'saved',noteBefore.version);expect((await demoRepository().read('B/doc.MD')).text).toBe(text+'saved');
  expect((await move(repo,'B/doc.MD','')).path).toBe('doc.MD');expect(paths(await repo.list(''))).toEqual(['A','B','root.md','doc.MD']);
 });
 it('inserts a note in another directory at a same-kind anchor and cleans its former sequence',async()=>{
  const repo=seed(['A','B','B/folder'],{'A/a.md':'a','A/c.md':'c','B/one.md':'one','B/two.md':'two'});await reorder(repo,'A/c.md','A/a.md');
  await reorder(repo,'A/c.md','B/two.md');expect(paths(await repo.list('B'))).toEqual(['B/folder','B/one.md','B/c.md','B/two.md']);
  expect((await repo.folderOrder()).parents.A).toEqual(['A/a.md']);expect((await repo.read('B/c.md')).text).toBe('c');
 });
 it('preserves folder placement when moving a folder into a directory that already has ordered notes',async()=>{
  const repo=seed(['A','B','B/one'],{'B/a.md':'a','B/z.md':'z'});await reorder(repo,'B/z.md','B/a.md');
  await move(repo,'A','B');expect(paths(await repo.list('B'))).toEqual(['B/one','B/A','B/z.md','B/a.md']);
 });
 it('keeps a renamed note in its custom rank, follows default naming without preferences, and cleans recycle',async()=>{
  const repo=seed(['Folder'],{'a.md':'a','b.md':'b','c.md':'c'});await repo.rename('a.md','z');
  expect(paths(await repo.list(''))).toEqual(['Folder','b.md','c.md','z.md']);await reorder(repo,'z.md','b.md');await repo.rename('z.md','a');
  expect(paths(await repo.list(''))).toEqual(['Folder','a.md','b.md','c.md']);await repo.recycle('b.md');
  expect((await demoRepository().folderOrder()).parents['']).toEqual(['Folder','a.md','c.md']);await expect(repo.read('b.md')).rejects.toMatchObject({code:'missing'});
 });
 it('migrates saved descendant note ordering together with a renamed and moved parent folder',async()=>{
  const repo=seed(['A','A/Sub','B'],{'A/Sub/a.md':'a','A/Sub/z.md':'z'});await reorder(repo,'A/Sub/z.md','A/Sub/a.md');
  await repo.rename('A','Renamed');await move(repo,'Renamed','B');
  expect(paths(await demoRepository().list('B/Renamed/Sub'))).toEqual(['B/Renamed/Sub/z.md','B/Renamed/Sub/a.md']);
  expect((await repo.folderOrder()).parents['B/Renamed/Sub']).toEqual(['B/Renamed/Sub/z.md','B/Renamed/Sub/a.md']);
 });
 it('treats externally renamed notes as removal plus new insertion and ignores non-Markdown files',async()=>{
  const repo=seed(['A'],{'a.md':'a','b.md':'b','c.md':'c','hidden.txt':'keep'});await reorder(repo,'c.md','a.md');
  storage.values.set('shiye-demo-files',JSON.stringify({'a.md':'a','b.md':'b','z.md':'c','e.md':'new','hidden.txt':'keep'}));
  expect(paths(await repo.list(''))).toEqual(['A','a.md','b.md','e.md','z.md']);
  const current=JSON.parse(storage.values.get('shiye-demo-files')!);current['d.md']='later';storage.values.set('shiye-demo-files',JSON.stringify(current));
  expect(paths(await demoRepository().list(''))).toEqual(['A','a.md','b.md','e.md','z.md','d.md']);
  await expect(move(repo,'hidden.txt','A')).rejects.toMatchObject({code:'missing'});
 });
 it('resets both groups only at the selected parent, preserving descendant note preferences',async()=>{
  const repo=seed(['A','B'],{'a.md':'a','z.md':'z','A/a.md':'child a','A/z.md':'child z'});
  await reorder(repo,'B','A');await reorder(repo,'z.md','a.md');await reorder(repo,'A/z.md','A/a.md');
  await action(repo,{source:'',parent:'',placement:'reset'});expect(paths(await repo.list(''))).toEqual(['A','B','a.md','z.md']);
  expect((await repo.folderOrder()).parents['']).toBeUndefined();expect((await repo.folderOrder()).parents.A).toEqual(['A/z.md','A/a.md']);
 });
 it('rejects no-longer-valid note anchors and same-name file or folder destinations',async()=>{
  const repo=seed(['A','B','B/folder.md'],{'A/a.md':'a','A/folder.md':'f','B/a.md':'protected','B/anchor.md':'anchor'});
  await expect(move(repo,'A/a.md','B')).rejects.toMatchObject({code:'exists'});await expect(move(repo,'A/folder.md','B')).rejects.toMatchObject({code:'exists'});
  const current=JSON.parse(storage.values.get('shiye-demo-files')!);delete current['B/anchor.md'];storage.values.set('shiye-demo-files',JSON.stringify(current));
  await expect(reorder(repo,'A/a.md','B/anchor.md')).rejects.toMatchObject({code:'missing'});
  storage.values.set('shiye-demo-folders',JSON.stringify(['A','B','B/folder.md','B/anchor.md']));await expect(reorder(repo,'A/a.md','B/anchor.md')).rejects.toMatchObject({code:'order'});
  expect((await repo.read('A/a.md')).text).toBe('a');expect((await repo.read('B/a.md')).text).toBe('protected');
 });
 it('does not rewrite metadata for an unchanged note position or moving into its current parent',async()=>{
  const repo=seed(['A'],{'A/a.md':'a','A/b.md':'b'}),before=await repo.folderOrder();storage.setItem.mockClear();
  expect((await reorder(repo,'A/a.md','A/b.md')).order.revision).toBe(before.revision);expect((await move(repo,'A/a.md','A')).moved).toBe(false);expect(storage.setItem).not.toHaveBeenCalled();
 });
 it('rolls back failed note sorting but preserves a note move and retries failed metadata',async()=>{
  const repo=seed(['A','B'],{'A/a.md':'a','A/z.md':'z'});await reorder(repo,'A/z.md','A/a.md');const before=await repo.folderOrder();
  storage.setItem.mockImplementation((name,value)=>{if(name===orderStorageKey)throw new Error('quota');storage.values.set(name,value);});
  await expect(reorder(repo,'A/a.md','A/z.md')).rejects.toMatchObject({code:'order'});expect(await repo.folderOrder()).toEqual(before);
  const moved=await move(repo,'A/z.md','B');expect(moved).toMatchObject({path:'B/z.md',moved:true,warning:expect.any(String)});expect((await repo.read('B/z.md')).text).toBe('z');await expect(repo.read('A/z.md')).rejects.toMatchObject({code:'missing'});
  storage.setItem.mockImplementation((name,value)=>{storage.values.set(name,value);});await repo.retryFolderOrder(moved.order.root);
  expect((await demoRepository().folderOrder()).parents.B).toEqual(['B/z.md']);
 });
 it('keeps external note edits intact through movement and rejects an outdated save version at the new path',async()=>{
  const repo=seed(['A','B'],{'A/doc.md':'original'}),original=await repo.read('A/doc.md');
  storage.values.set('shiye-demo-files',JSON.stringify({'A/doc.md':'external'}));await move(repo,'A/doc.md','B');
  await expect(repo.save('B/doc.md','stale local edit',original.version)).rejects.toMatchObject({code:'conflict'});expect((await repo.read('B/doc.md')).text).toBe('external');
 });
 it('isolates note sorting by workspace and rejects stale note actions',async()=>{
  const repo=seed([] ,{'a.md':'a','b.md':'b','c.md':'c'}),old=await repo.folderOrder();await reorder(repo,'c.md','a.md');
  await expect(repo.arrangeFolder({...old,source:'b.md',parent:'',anchor:'a.md',placement:'before'})).rejects.toMatchObject({code:'stale'});
  await repo.workspace('Other');expect(paths(await repo.list(''))).toEqual(['a.md','b.md','c.md']);await repo.workspace(old.root);
  expect(paths(await repo.list(''))).toEqual(['c.md','a.md','b.md']);
 });
 it('removes a stale destination rank before renaming a note into that deleted name',async()=>{
  const repo=seed([],{'x.md':'source','y.md':'deleted externally','z.md':'middle'});await reorder(repo,'y.md','x.md');await reorder(repo,'x.md','z.md','after');
  expect((await repo.folderOrder()).parents['']).toEqual(['y.md','z.md','x.md']);
  storage.values.set('shiye-demo-files',JSON.stringify({'x.md':'source','z.md':'middle'}));
  await repo.rename('x.md','y.md');expect((await repo.folderOrder()).parents['']).toEqual(['z.md','y.md']);expect(paths(await demoRepository().list(''))).toEqual(['z.md','y.md']);
 });
 it('preserves the source rank during a case-only note rename',async()=>{
  const repo=seed([],{'a.md':'a','b.md':'b','c.md':'c'});await reorder(repo,'c.md','a.md');await repo.rename('c.md','C.MD');
  expect((await repo.folderOrder()).parents['']).toEqual(['C.MD','a.md','b.md']);expect(paths(await demoRepository().list(''))).toEqual(['C.MD','a.md','b.md']);expect((await repo.read('C.MD')).text).toBe('c');
 });
 it('keeps folders ending in .md in the folder group through moves and case-only renames',async()=>{
  const repo=seed(['A','B','folder.md','folder.md/child'],{'folder.md/doc.md':'inside folder','note.md':'a note'});await reorder(repo,'folder.md','A');
  await repo.rename('folder.md','Folder.MD');expect((await repo.list(''))[0]).toMatchObject({path:'Folder.MD',kind:'folder'});
  await move(repo,'Folder.MD','B');expect((await repo.list('B'))[0]).toMatchObject({path:'B/Folder.MD',kind:'folder'});expect((await repo.read('B/Folder.MD/doc.md')).text).toBe('inside folder');
  await expect(reorder(repo,'note.md','B/Folder.MD')).rejects.toMatchObject({code:'order'});
 });
});
