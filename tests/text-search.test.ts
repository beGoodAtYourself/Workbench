import {afterEach,describe,expect,it,vi} from 'vitest';
import {executeSearch,MAX_SEARCH_MATCHES,replacementFor,type SearchOptions,type SearchRequest,type SearchResult} from '../src/text-search';
import {TextSearchClient,type SearchWorker} from '../src/text-search-client';
function run(text:string,options:SearchOptions,replacement?:string){return executeSearch({documentId:'document-A',revision:7,generation:12,text,options,replacement});}
function apply(text:string,result:SearchResult){let offset=0;for(const change of result.changes??[]){text=text.slice(0,change.from+offset)+change.insert+text.slice(change.to+offset);offset+=change.insert.length-change.to+change.from;}return text;}
afterEach(()=>vi.useRealTimers());
describe('worker search calculation',()=>{
 it('uses Unicode words, case control and literal punctuation',()=>{
  expect(run('猫 猫咪 猫_ 猫1 x猫 猫😀',{query:'猫',wholeWord:true}).matches.map(match=>match.from)).toEqual([0,14]);
  expect(run('Aa aA aa',{query:'Aa',caseSensitive:true}).matches).toHaveLength(1);
  expect(run('Aa aA aa',{query:'Aa'}).matches).toHaveLength(3);
  expect(run('a.b axb a.b',{query:'a.b'}).matches.map(match=>match.from)).toEqual([0,8]);
 });
 it('limits search and replacement to the captured continuous range',()=>{
  const text='cat cat cat',result=run(text,{query:'cat',scope:{from:4,to:7}},'狗');
  expect(result.scope).toEqual({from:4,to:7});expect(result.matches.map(match=>[match.from,match.to])).toEqual([[4,7]]);expect(apply(text,result)).toBe('cat 狗 cat');
 });
 it('supports multiline anchors, explicit dotAll and rejects invalid expressions',()=>{
  expect(run('a\nb',{query:'^b$',regex:true}).matches[0].from).toBe(2);
  expect(run('a\nb',{query:'a.b',regex:true}).matches).toHaveLength(0);
  expect(run('a\nb',{query:'a.b',regex:true,dotAll:true}).matches).toHaveLength(1);
  expect(run('abc',{query:'[',regex:true}).status).toBe('invalid');
 });
 it('advances zero-width matches by Unicode code points and preserves surrounding text',()=>{
  const text='😀a',result=run(text,{query:'(?=.)|$',regex:true},'|');
  expect(result.matches.map(match=>match.from)).toEqual([0,2,3]);expect(apply(text,result)).toBe('|😀|a|');
 });
 it('expands numeric and named captures and dollar escapes only in regex mode',()=>{
  const text='ab a',result=run(text,{query:'(?<letter>a)(b)?',regex:true},'$<letter>:$2:$1:$$:$12');
  expect(apply(text,result)).toBe('a:b:a:$:a2 a::a:$:a2');
  expect(apply('a',run('a',{query:'a'},'$1 $$'))).toBe('$1 $$');
  expect(replacementFor({from:0,to:1,captures:['a','a']},'$<missing> $0 $2',true)).toBe('$<missing> $0 $2');
 });
 it('allows exactly 10,000 matches and rejects the entire operation above the limit',()=>{
  expect(run('a'.repeat(MAX_SEARCH_MATCHES),{query:'a'},'b').changes).toHaveLength(MAX_SEARCH_MATCHES);
  const result=run('a'.repeat(MAX_SEARCH_MATCHES+1),{query:'a'},'b');expect(result.status).toBe('limit');expect(result.changes).toBeUndefined();expect(result.matches).toHaveLength(0);
 });
 it('rejects an oversized replacement without exposing a partial change set',()=>{
  const result=run('aa',{query:'a'},'b'.repeat(8*1024*1024+1));expect(result.status).toBe('limit');expect(result.changes).toBeUndefined();
 });
 it('returns no partial changes when its budget expires',()=>{
  let tick=0;const result=executeSearch({documentId:'a',revision:1,generation:1,text:'aaa',options:{query:'a'},replacement:'b'},()=>tick++*800);
  expect(result.status).toBe('timeout');expect(result.matches).toEqual([]);expect(result.changes).toBeUndefined();
 });
});
class FakeWorker implements SearchWorker {
 onmessage:((event:MessageEvent<SearchResult>)=>void)|null=null;onerror:((event:ErrorEvent)=>unknown)|null=null;request!:SearchRequest;terminated=false;
 postMessage(request:SearchRequest){this.request=request;}terminate(){this.terminated=true;}
 respond(result:SearchResult){this.onmessage?.({data:result} as MessageEvent<SearchResult>);}
}
describe('disposable search workers',()=>{
 it('terminates a catastrophic or stalled worker at 1,500 ms',async()=>{
  vi.useFakeTimers();const worker=new FakeWorker(),client=new TextSearchClient(()=>worker),task=client.run('A',3,'aaaa',{query:'(a+)+b',regex:true});
  await vi.advanceTimersByTimeAsync(1500);expect((await task).status).toBe('timeout');expect(worker.terminated).toBe(true);
 });
 it('cancels the previous task and ignores responses for another version',async()=>{
  const workers:FakeWorker[]=[],client=new TextSearchClient(()=>{const worker=new FakeWorker();workers.push(worker);return worker;});
  const first=client.run('A',1,'a',{query:'a'}),second=client.run('A',2,'aa',{query:'a'});expect((await first).status).toBe('cancelled');expect(workers[0].terminated).toBe(true);
  const result=executeSearch(workers[1].request);workers[1].respond({...result,revision:1});expect(workers[1].terminated).toBe(false);workers[1].respond(result);
  expect((await second).matches).toHaveLength(2);expect(workers[1].terminated).toBe(true);
 });
 it('destroy resolves pending work as cancelled and releases the worker',async()=>{
  const worker=new FakeWorker(),client=new TextSearchClient(()=>worker),task=client.run('A',3,'a',{query:'a'});client.destroy();expect((await task).status).toBe('cancelled');expect(worker.terminated).toBe(true);
 });
});
