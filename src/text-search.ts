export interface SearchScope {from:number;to:number}
export interface SearchOptions {query:string;regex?:boolean;caseSensitive?:boolean;wholeWord?:boolean;dotAll?:boolean;scope?:SearchScope}
export interface SearchMatch {from:number;to:number;captures:(string|undefined)[];groups?:Record<string,string|undefined>}
export interface SearchChange {from:number;to:number;insert:string}
export interface SearchRequest {documentId:string;revision:number;generation:number;text:string;options:SearchOptions;replacement?:string}
export type SearchStatus='ok'|'invalid'|'limit'|'timeout'|'cancelled'|'error';
export interface SearchResult {documentId:string;revision:number;generation:number;status:SearchStatus;matches:SearchMatch[];scope:SearchScope;changes?:SearchChange[];message?:string}
export const SEARCH_TIMEOUT=1500,MAX_SEARCH_MATCHES=10_000,MAX_SEARCH_LENGTH=16*1024*1024;
const word=/[\p{L}\p{N}_]/u;
function previousPoint(text:string,at:number){const last=text.charCodeAt(at-1);return text.slice(at-(last>=0xdc00&&last<=0xdfff&&at>1?2:1),at);}
function nextPoint(text:string,at:number){const value=text.codePointAt(at);return value===undefined?'':String.fromCodePoint(value);}
function escapeRegex(value:string){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
export function replacementFor(match:SearchMatch,replacement:string,regex:boolean):string{
 if(!regex)return replacement;
 return replacement.replace(/\$\$|\$<([^>]+)>|\$(\d{1,2})/g,(token:string,name:string|undefined,digits:string|undefined)=>{
  if(token==='$$')return '$';
  if(name!==undefined)return match.groups?match.groups[name]??'':token;
  const index=Number(digits);
  if(index>0&&index<match.captures.length)return match.captures[index]??'';
  if(digits?.length===2){const first=Number(digits[0]);if(first>0&&first<match.captures.length)return (match.captures[first]??'')+digits[1];}
  return token;
 });
}
/** Runs only inside a disposable worker in production. The clock checks also bound non-regex loops. */
export function executeSearch(request:SearchRequest,clock:()=>number=()=>performance.now()):SearchResult{
 const {text,options}=request,start=clock(),from=Math.max(0,Math.min(text.length,options.scope?.from??0)),to=Math.max(from,Math.min(text.length,options.scope?.to??text.length));
 const base:SearchResult={documentId:request.documentId,revision:request.revision,generation:request.generation,status:'ok',matches:[],scope:{from,to}};
 if(!options.query)return {...base,changes:request.replacement!==undefined?[]:undefined};
 let pattern:RegExp;
 try{pattern=new RegExp(options.regex?options.query:escapeRegex(options.query),'gum'+(options.caseSensitive?'':'i')+(options.regex&&options.dotAll?'s':''));}
 catch(error){return {...base,status:'invalid',message:error instanceof Error?error.message:'正则表达式无效'};}
 const content=text.slice(from,to);let match:RegExpExecArray|null;
 while((match=pattern.exec(content))!==null){
  if(clock()-start>SEARCH_TIMEOUT)return {...base,status:'timeout',matches:[],message:'查找超过 1,500 毫秒，已停止'};
  const at=match.index,end=at+match[0].length;
  if(options.regex||!options.wholeWord||(!word.test(previousPoint(content,at))&&!word.test(nextPoint(content,end)))){
   if(base.matches.length===MAX_SEARCH_MATCHES)return {...base,status:'limit',matches:[],message:'匹配超过 10,000 个，请缩小查找范围'};
   base.matches.push({from:at+from,to:end+from,captures:Array.from(match),groups:match.groups?{...match.groups}:undefined});
  }
  // RegExp.exec does not advance after empty matches. Never split a surrogate pair.
  if(match[0].length===0){if(pattern.lastIndex>=content.length)break;pattern.lastIndex+=nextPoint(content,pattern.lastIndex).length;}
 }
 if(request.replacement!==undefined){
  const changes:SearchChange[]=[];let length=text.length;
  for(const item of base.matches){
   if(clock()-start>SEARCH_TIMEOUT)return {...base,status:'timeout',matches:[],message:'替换计算超过 1,500 毫秒，全文未改变'};
   const insert=replacementFor(item,request.replacement,!!options.regex);length+=insert.length-(item.to-item.from);changes.push({from:item.from,to:item.to,insert});
  }
  if(length>MAX_SEARCH_LENGTH)return {...base,status:'limit',changes:undefined,message:'替换后的正文超出会话上限，全文未改变'};
  base.changes=changes;
 }
 return base;
}
