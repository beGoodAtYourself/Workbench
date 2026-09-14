import {EditorState,type TransactionSpec} from '@codemirror/state';
import {isolateHistory} from '@codemirror/commands';
import {ensureSyntaxTree,syntaxTree} from '@codemirror/language';

export type FormatAction='paragraph'|'h1'|'h2'|'h3'|'bold'|'italic'|'bullet'|'ordered'|'task'|'quote'|'inline-code'|'code-block'|'link';
export type FormatOptions={language?:string;label?:string;href?:string};

function longestTickRun(text:string){let length=0;for(const match of text.matchAll(/`+/g))length=Math.max(length,match[0].length);return length;}

export function codeBlockAt(state:EditorState){
 const range=state.selection.main;
 const tree=ensureSyntaxTree(state,range.to,50)??syntaxTree(state);
 let node=tree.resolveInner(range.from,1);
 while(node.parent&&node.name!=='FencedCode')node=node.parent;
 if(node.name!=='FencedCode'||range.to>node.to)return null;
 const line=state.doc.lineAt(node.from),opening=/^(`{3,}|~{3,})(.*)$/.exec(state.sliceDoc(node.from,line.to));
 return opening?{from:node.from+opening[1].length,to:line.to,language:opening[2].trim()}:null;
}

function replacement(state:EditorState,from:number,to:number,insert:string,anchor?:number,head=anchor):TransactionSpec{
 const changes=state.changes({from,to,insert});
 return {changes,selection:anchor===undefined?state.selection.map(changes):{anchor,head},scrollIntoView:true,
  userEvent:'input.format',annotations:isolateHistory.of('full')};
}

function inline(state:EditorState,action:'bold'|'italic'|'inline-code'){
 const {from,to}=state.selection.main;
 const selected=state.sliceDoc(from,to),body=selected||(action==='inline-code'?'代码':'文字');
 let marker=action==='bold'?'**':action==='italic'?'*':'`';
 if(action==='inline-code'){
  // Repeated clicks remove the actual surrounding delimiter (which may be longer than one tick).
  const left=/(`+)( ?)$/.exec(state.sliceDoc(state.doc.lineAt(from).from,from));
  const right=/^( ?)(`+)/.exec(state.sliceDoc(to,state.doc.lineAt(to).to));
  if(selected&&left&&right&&left[1]===right[2]&&left[2]===right[1])return replacement(state,from-left[0].length,to+right[0].length,selected,from-left[0].length,from-left[0].length+selected.length);
  marker='`'.repeat(longestTickRun(body)+1);
 }
 if(selected&&state.sliceDoc(Math.max(0,from-marker.length),from)===marker&&state.sliceDoc(to,to+marker.length)===marker){
  return replacement(state,from-marker.length,to+marker.length,selected,from-marker.length,from-marker.length+selected.length);
 }
 if(selected.length>marker.length*2&&selected.startsWith(marker)&&selected.endsWith(marker)){
  const text=selected.slice(marker.length,-marker.length);return replacement(state,from,to,text,from,from+text.length);
 }
 const pad=action==='inline-code'&&!/^ +$/.test(body)&&(/^[` ]/.test(body)||/[` ]$/.test(body))?' ':'';
 const text=marker+pad+body+pad+marker;
 return replacement(state,from,to,text,from+marker.length+pad.length,from+marker.length+pad.length+body.length);
}

function selectedLines(state:EditorState){
 const range=state.selection.main,first=state.doc.lineAt(range.from);
 const last=state.doc.lineAt(range.to>range.from&&state.doc.lineAt(range.to).from===range.to?range.to-1:range.to);
 return {from:first.from,to:last.to,lines:state.sliceDoc(first.from,last.to).split('\n')};
}
function lineParts(line:string){
 const match=/^([ \t]*)(?:(#{1,6})[ \t]+|([-+*]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?|(>)[ \t]?)/.exec(line);
 if(!match){const indent=/^[ \t]*/.exec(line)![0];return {indent,body:line.slice(indent.length),kind:'paragraph'};}
 return {indent:match[1],body:line.slice(match[0].length),kind:match[2]?'h'+match[2].length:match[5]?'quote':match[4]!==undefined?'task':/^\d/.test(match[3])?'ordered':'bullet'};
}
export function formatTransaction(state:EditorState,action:FormatAction,options:FormatOptions={}):TransactionSpec|null{
 const range=state.selection.main,block=codeBlockAt(state);
 if(action==='code-block'){
  const language=(options.language||'').replace(/[^a-zA-Z0-9+#_-]/g,'');
  if(block)return replacement(state,block.from,block.to,language);
  const {from,to,lines}=selectedLines(state),body=lines.join('\n')||'代码';
  const fence='`'.repeat(Math.max(3,longestTickRun(body)+1));
  const start=fence+language+'\n',insert=start+body+'\n'+fence;
  return replacement(state,from,to,insert,from+start.length,from+start.length+body.length);
 }
 // Other Markdown formatting inside fenced code would only insert literal markup.
 if(block)return null;
 if(action==='bold'||action==='italic'||action==='inline-code')return inline(state,action);
 if(action==='link'){
  if(!options.href?.trim())return null;
  const label=options.label||state.sliceDoc(range.from,range.to)||'链接文字';
  const escaped=label.replace(/\r?\n/g,' ').replace(/([\\[\]*_`~])/g,'\\$1');
  const href=options.href.trim().replace(/[<>\\\r\n]/g,char=>encodeURIComponent(char));
  const insert='['+escaped+'](<'+href+'>)';
  return replacement(state,range.from,range.to,insert,range.from+1,range.from+1+escaped.length);
 }
 const {from,to,lines}=selectedLines(state),parts=lines.map(lineParts);
 const populated=parts.filter(part=>part.body.trim());
 const toggle=populated.length>0&&populated.every(part=>part.kind===action);
 let ordinal=0,placeholderStart=0;
 const outputLines=parts.map((part,index)=>{
  if(!lines[index].trim()&&lines.length>1)return lines[index];
  const kind=toggle?'paragraph':action;
  const prefix=kind==='paragraph'?'':kind[0]==='h'?'#'.repeat(Number(kind.slice(1)))+' ':kind==='bullet'?'- ':kind==='ordered'?String(++ordinal)+'. ':kind==='task'?'- [ ] ':kind==='quote'?'> ':'';
  placeholderStart=part.indent.length+prefix.length;
  return part.indent+prefix+(part.body||(kind==='paragraph'?'':kind[0]==='h'?'标题':kind==='quote'?'引用文字':'列表项'));
 });
 const output=outputLines.join('\n');
 if(output===state.sliceDoc(from,to))return null;
 if(!lines[0].trim()&&lines.length===1)return replacement(state,from,to,output,from+placeholderStart,from+output.length);
 // Keep the user's text selected, excluding newly generated leading markup.
 // This lets a heading immediately become bold without wrapping its '#' prefix.
 const first=parts[0],last=parts.at(-1)!;
 const startOffset=Math.max(0,Math.min(first.body.length,range.from-from-(lines[0].length-first.body.length)));
 const endOffset=Math.max(0,Math.min(last.body.length,Math.min(range.to,to)-(to-last.body.length)));
 const start=from+outputLines[0].length-first.body.length+startOffset;
 // The body itself is unchanged for nonempty lines, so its suffix gives a stable end position.
 const textEnd=range.empty?start:from+output.length-last.body.length+endOffset;
 return replacement(state,from,to,output,range.anchor<=range.head?start:textEnd,range.anchor<=range.head?textEnd:start);
}
