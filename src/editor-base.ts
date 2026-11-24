import {EditorState,type Extension} from '@codemirror/state';
import {drawSelection,highlightActiveLine,highlightActiveLineGutter,lineNumbers} from '@codemirror/view';
import {history} from '@codemirror/commands';
export function editorBase():Extension[]{return [lineNumbers(),drawSelection(),highlightActiveLine(),highlightActiveLineGutter(),history({minDepth:100})];}
export interface HistoryMeter {changes:number;bytes:number}
export function measureHistory(meter:HistoryMeter,inserted:number){meter.changes++;meter.bytes+=inserted;return meter.changes>=200||meter.bytes>4*1024*1024;}
export function editorPosition(state:EditorState){const head=state.selection.main.head,line=state.doc.lineAt(head);return {line:line.number,column:Array.from(line.text.slice(0,head-line.from)).length+1};}
export function lineColumnPosition(state:EditorState,line:number,column=1){
 const requestedLine=Number.isFinite(line)?Math.trunc(line):1,requestedColumn=Number.isFinite(column)?Math.trunc(column):1;
 const row=state.doc.line(Math.max(1,Math.min(state.doc.lines,requestedLine))),points=Array.from(row.text),col=Math.max(1,Math.min(points.length+1,requestedColumn));
 return {position:row.from+points.slice(0,col-1).join('').length,line:row.number,column:col,clamped:row.number!==requestedLine||col!==requestedColumn};
}
