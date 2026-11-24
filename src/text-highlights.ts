import type {ChangeDesc} from '@codemirror/state';

export const highlightColors=[['yellow','黄色'],['green','绿色'],['blue','蓝色'],['pink','粉色']] as const;
export type HighlightColor=typeof highlightColors[number][0];
export interface TextHighlight {from:number;to:number;color:HighlightColor}
export const MAX_HIGHLIGHTS=256,MAX_SESSION_HIGHLIGHTS=1024;
export function validHighlights(value:unknown,length:number):value is TextHighlight[]{
 if(!Array.isArray(value)||value.length>MAX_HIGHLIGHTS)return false;
 let end=0;
 return value.every(mark=>{const valid=mark&&Number.isSafeInteger(mark.from)&&Number.isSafeInteger(mark.to)&&mark.from>=end&&mark.from<mark.to&&mark.to<=length&&highlightColors.some(([color])=>color===mark.color);end=mark?.to;return valid;});
}
export function sameHighlights(a:readonly TextHighlight[]=[],b:readonly TextHighlight[]=[]){return a===b||a.length===b.length&&a.every((mark,index)=>mark.from===b[index].from&&mark.to===b[index].to&&mark.color===b[index].color);}
function merge(marks:TextHighlight[]):TextHighlight[]{
 const result:TextHighlight[]=[];
 for(const mark of marks.sort((a,b)=>a.from-b.from)){
  if(mark.from>=mark.to)continue;
  const previous=result.at(-1);
  if(previous&&previous.to===mark.from&&previous.color===mark.color)previous.to=mark.to;
  else result.push({...mark});
 }
 return result;
}
export function paintHighlights(marks:readonly TextHighlight[],ranges:readonly {from:number;to:number}[],color:HighlightColor|null):TextHighlight[]{
 let next=marks.map(mark=>({...mark}));
 for(const {from,to} of ranges){
  if(from>=to)continue;
  next=next.flatMap(mark=>mark.to<=from||mark.from>=to?[mark]:[
   ...(mark.from<from?[{...mark,to:from}]:[]),...(mark.to>to?[{...mark,from:to}]:[])
  ]);
  if(color)next.push({from,to,color});
 }
 return merge(next);
}
export function mapHighlights(marks:readonly TextHighlight[],changes:ChangeDesc):TextHighlight[]{
 // 边界插入不染色；范围内部的输入继承标注，完全删除的标注随正文移除。
 return merge(marks.map(mark=>({...mark,from:changes.mapPos(mark.from,1),to:changes.mapPos(mark.to,-1)})));
}
