import {SEARCH_TIMEOUT,type SearchOptions,type SearchRequest,type SearchResult} from './text-search';
export interface SearchWorker {onmessage:((event:MessageEvent<SearchResult>)=>void)|null;onerror:((event:ErrorEvent)=>unknown)|null;postMessage(value:SearchRequest):void;terminate():void}
export class TextSearchClient {
 private generation=0;
 private pending:{worker:SearchWorker;finish:(value:SearchResult)=>void;request:SearchRequest;timer:ReturnType<typeof setTimeout>}|null=null;
 constructor(private factory:()=>SearchWorker=()=>new Worker(new URL('./text-search.worker.ts',import.meta.url),{type:'module'}),private timeout=SEARCH_TIMEOUT){}
 run(documentId:string,revision:number,text:string,options:SearchOptions,replacement?:string):Promise<SearchResult>{
  this.cancel();const request:SearchRequest={documentId,revision,generation:++this.generation,text,options,replacement};
  return new Promise(resolve=>{
   const failure=(status:SearchResult['status'],message:string):SearchResult=>({documentId,revision,generation:request.generation,status,matches:[],scope:options.scope??{from:0,to:text.length},message});
   let worker:SearchWorker;
   try{worker=this.factory();}catch{resolve(failure('error','无法启动查找，请重试'));return;}
   const finish=(result:SearchResult)=>{if(this.pending?.request.generation!==request.generation)return;clearTimeout(this.pending.timer);this.pending=null;worker.terminate();worker.onmessage=null;worker.onerror=null;resolve(result);};
   const timer=setTimeout(()=>finish(failure('timeout','查找超过 1,500 毫秒，已停止；全文未改变')),this.timeout);
   this.pending={worker,finish,request,timer};
   worker.onmessage=event=>{const result=event.data;if(result.generation===request.generation&&result.documentId===documentId&&result.revision===revision)finish(result);};
   worker.onerror=()=>finish(failure('error','查找计算失败，全文未改变'));
   try{worker.postMessage(request);}catch{finish(failure('error','无法提交查找，全文未改变'));}
  });
 }
 cancel(){
  const task=this.pending;if(!task)return;
  task.finish({documentId:task.request.documentId,revision:task.request.revision,generation:task.request.generation,status:'cancelled',matches:[],scope:task.request.options.scope??{from:0,to:task.request.text.length}});
 }
 destroy(){this.cancel();}
}
