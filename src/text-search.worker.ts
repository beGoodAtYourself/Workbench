import {executeSearch,type SearchRequest,type SearchResult} from './text-search';
const scope=globalThis as unknown as {onmessage:(event:MessageEvent<SearchRequest>)=>void;postMessage:(value:SearchResult)=>void};
scope.onmessage=event=>{scope.postMessage(executeSearch(event.data));};
