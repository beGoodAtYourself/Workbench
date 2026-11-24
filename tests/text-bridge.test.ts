import {afterEach,describe,expect,it,vi} from 'vitest';
import {textRepository} from '../src/text-bridge';

const {invoke}=vi.hoisted(()=>({invoke:vi.fn(async(..._args:unknown[])=>undefined)}));
vi.mock('@tauri-apps/api/core',()=>({invoke}));
afterEach(()=>{vi.clearAllMocks();vi.unstubAllGlobals();});

describe('desktop text read wire compatibility',()=>{
 it('passes optional encoding choices to native open and reread commands',async()=>{
  vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});const repo=await textRepository();await repo.open('gb18030');await repo.read('owned-id','big5');
  expect(invoke.mock.calls).toEqual([['text_open',{encoding:'gb18030'}],['text_read',{id:'owned-id',encoding:'big5'}]]);
 });
 it('leaves legacy reads unwrapped and sends knownVersion only for a probe of an authorized ID',async()=>{
  vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});const repo=await textRepository();await repo.read('owned-id');await repo.probe('owned-id','bytes-version');
  expect(invoke.mock.calls).toEqual([['text_read',{id:'owned-id'}],['text_read',{id:'owned-id',knownVersion:'bytes-version'}]]);
 });
});


it('claims native drops with a token instead of accepting a frontend filesystem path', async () => {
 vi.stubGlobal('window', {__TAURI_INTERNALS__: {}});
 const repo = await textRepository();
 await repo.openDropped!('drop-42');
 expect(invoke).toHaveBeenCalledWith('text_open_dropped', {token: 'drop-42'});
});
