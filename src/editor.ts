import {EditorState,StateEffect,type Extension} from '@codemirror/state';
import {EditorView,keymap,lineNumbers,drawSelection,highlightActiveLine,highlightActiveLineGutter} from '@codemirror/view';
import {defaultKeymap,history,historyKeymap,indentWithTab} from '@codemirror/commands';
import {markdown} from '@codemirror/lang-markdown';
import {syntaxTree,syntaxHighlighting,defaultHighlightStyle} from '@codemirror/language';
import {Lexer} from 'marked';
import {makeLink,basename} from './paths';
import type {Document} from './model';
const memory=new WeakMap<Document,EditorState>();
const metrics=new WeakMap<Document,{changes:number;bytes:number}>();
export function editor(parent:HTMLElement,doc:Document,edit:(text:string)=>void,link:(href:string)=>void,save:()=>void,focus:()=>void){
 let disposed=false;
 const meter=metrics.get(doc)??{changes:0,bytes:0};metrics.set(doc,meter);
 function extensions():Extension[]{
  return [
   lineNumbers(),drawSelection(),highlightActiveLine(),highlightActiveLineGutter(),history({minDepth:100}),
   markdown(),syntaxHighlighting(defaultHighlightStyle),EditorView.lineWrapping,
   EditorView.contentAttributes.of({'aria-label':basename(doc.path)+' 编辑器',spellcheck:'true'}),
   keymap.of([{key:'Mod-s',run:()=>{save();return true;}},...defaultKeymap,...historyKeymap,indentWithTab]),
   EditorView.updateListener.of(update=>{
    doc.cursor=update.state.selection.main.head;memory.set(doc,update.state);
    if(update.docChanged){edit(update.state.doc.toString());meter.changes++;update.changes.iterChanges((_a,_b,_c,_d,inserted)=>{meter.bytes+=inserted.length;});
     if(meter.changes>=200||meter.bytes>4*1024*1024){meter.changes=0;meter.bytes=0;queueMicrotask(()=>{if(!disposed){const next=state(view.state.doc.toString(),view.state.selection.main.head);view.setState(next);memory.set(doc,next);}});}
    }
   }),
   EditorView.domEventHandlers({
    focus:()=>{focus();},scroll:()=>{doc.scroll=view.scrollDOM.scrollTop;},
    click:(event,view)=>{
     if(!event.ctrlKey)return false;const position=view.posAtCoords({x:event.clientX,y:event.clientY});if(position===null)return false;
     let node=syntaxTree(view.state).resolveInner(position,1);while(node.parent&&node.name!=='Link')node=node.parent;
     if(node.name!=='Link')return false;
     const token=Lexer.lexInline(view.state.sliceDoc(node.from,node.to)).find(t=>t.type==='link');
     if(token&&token.type==='link'){event.preventDefault();link(token.href);return true;}return false;
    },
    dragover:event=>{if(event.dataTransfer?.types.includes('application/x-shiye-note')){event.preventDefault();event.dataTransfer.dropEffect='link';return true;}return false;},
    drop:(event,view)=>{
     const target=event.dataTransfer?.getData('application/x-shiye-note');if(!target)return false;event.preventDefault();
     const pos=view.posAtCoords({x:event.clientX,y:event.clientY})??view.state.selection.main.head;
     const text=makeLink(doc.path,target);view.dispatch({changes:{from:pos,insert:text},selection:{anchor:pos+text.length}});view.focus();return true;
    }
   })
  ];
 }
 function state(text:string,cursor=doc.cursor):EditorState{
  return EditorState.create({doc:text,selection:{anchor:Math.min(cursor,text.length)},extensions:extensions()});
 }
 const cached=memory.get(doc);
 const restored=cached&&cached.doc.toString()===doc.text?cached.update({effects:StateEffect.reconfigure.of(extensions())}).state:state(doc.text);
 const view=new EditorView({parent,state:restored});
 requestAnimationFrame(()=>{if(!disposed)view.scrollDOM.scrollTop=doc.scroll;});
 return {view,
 insertLink(target:string,x:number,y:number){const pos=view.posAtCoords({x,y})??view.state.doc.length,text=makeLink(doc.path,target);view.dispatch({changes:{from:pos,insert:text},selection:{anchor:pos+text.length}});view.focus();},
 goTo(position:number){view.dispatch({selection:{anchor:position},effects:EditorView.scrollIntoView(position,{y:'start'})});view.focus();},
 destroy(){disposed=true;doc.cursor=view.state.selection.main.head;doc.scroll=view.scrollDOM.scrollTop;memory.set(doc,view.state);view.destroy();}};
}
