import {describe,it,expect} from 'vitest';
import {EditorState,type Transaction} from '@codemirror/state';
import {markdown} from '@codemirror/lang-markdown';
import {history,undo,redo} from '@codemirror/commands';
import {formatTransaction,codeBlockAt,type FormatAction,type FormatOptions} from '../src/formatting';

function state(text:string,from=0,to=text.length){return EditorState.create({doc:text,selection:{anchor:from,head:to},extensions:[markdown(),history()]});}
function apply(current:EditorState,action:FormatAction,options?:FormatOptions){const transaction=formatTransaction(current,action,options);return transaction?current.update(transaction).state:current;}
function text(current:EditorState){return current.doc.toString();}

describe('formatting preserves user text and produces reversible Markdown',()=>{
 it.each(['bold','italic','inline-code'] as const)('%s applies to selected Chinese text and toggles off',action=>{
  const original=state('前面的文字 内容 后面的文字',6,8),formatted=apply(original,action);
  expect(text(formatted)).not.toBe(text(original));expect(text(apply(formatted,action))).toBe(text(original));
 });
 it('inserts a selected placeholder at an empty cursor',()=>{
  const next=apply(state('前后',1,1),'bold');expect(text(next)).toBe('前**文字**后');expect(next.sliceDoc(next.selection.main.from,next.selection.main.to)).toBe('文字');
 });
 it('uses valid delimiters around inline backticks and preserves spaces on toggle',()=>{
  for(const source of ['`x`','a``b',' text ','   ']){
   const next=apply(state(source),'inline-code');expect(text(next)).toContain(source);expect(text(apply(next,'inline-code'))).toBe(source);
  }
 });
 it.each(['h1','h2','h3','bullet','ordered','task','quote'] as const)('%s covers whole selected lines, skips blank lines and toggles',action=>{
  const original=state('甲\n\n乙\n末行',0,5),next=apply(original,action);
  expect(text(next)).toContain('\n\n');expect(text(next)).toMatch(/\n末行$/);expect(text(apply(next,action))).toBe(text(original));
 });
 it('excludes the line at the selection end and replaces existing formats',()=>{
  const original=state('- 甲\n- 乙\n尾部',0,8),next=apply(original,'ordered');expect(text(next)).toBe('1. 甲\n2. 乙\n尾部');
  expect(text(apply(next,'h2'))).toBe('## 甲\n## 乙\n尾部');expect(text(apply(apply(next,'h2'),'paragraph'))).toBe('甲\n乙\n尾部');
 });
 it('creates a heading placeholder on an empty line',()=>{
  const next=apply(state(''),'h2');expect(text(next)).toBe('## 标题');expect(next.sliceDoc(next.selection.main.from,next.selection.main.to)).toBe('标题');
 });
 it('keeps heading markers out of a following inline formatting operation',()=>{
  const heading=apply(state('标题'),'h2');expect(heading.sliceDoc(heading.selection.main.from,heading.selection.main.to)).toBe('标题');
  expect(text(apply(heading,'bold'))).toBe('## **标题**');
 });
 it('preserves full-width indentation pasted from a Chinese text file',()=>{
  const original=state('　　中文正文'),next=apply(original,'bullet');expect(text(next)).toBe('- 　　中文正文');expect(text(apply(next,'bullet'))).toBe(text(original));
 });
 it('each formatting action is independently undoable and redoable',()=>{
  let current=apply(apply(state('甲乙'),'bold'),'italic');const formatted=text(current);
  const target={get state(){return current;},dispatch:(transaction:Transaction)=>{current=transaction.state;}};
  expect(undo(target)).toBe(true);expect(text(current)).toBe('**甲乙**');expect(undo(target)).toBe(true);expect(text(current)).toBe('甲乙');
  expect(redo(target)).toBe(true);expect(redo(target)).toBe(true);expect(text(current)).toBe(formatted);
 });
 it('code block fences exceed embedded runs and preserve indentation',()=>{
  const body='    value = "```"\n    next()',next=apply(state(body),'code-block',{language:'python'});
  expect(text(next)).toBe('````python\n'+body+'\n````');expect(codeBlockAt(next)?.language).toBe('python');
 });
 it('wraps a large selection containing many backticks without a spread-argument limit',()=>{
  const body='a`'.repeat(150000),next=apply(state(body),'code-block');expect(text(next)).toBe('```\n'+body+'\n```');
 });
 it('changes an existing fence language without nesting or changing its body',()=>{
  const original=state('~~~js\nconst x = 1;\n~~~',10,10),next=apply(original,'code-block',{language:'typescript'});
  expect(text(next)).toBe('~~~typescript\nconst x = 1;\n~~~');expect(text(apply(next,'code-block',{language:''}))).toBe('~~~\nconst x = 1;\n~~~');
  expect(apply(next,'h1')).toBe(next);
 });
 it('builds valid links with literal labels, spaces and parentheses',()=>{
  const next=apply(state('说明'),'link',{label:'文[件]*',href:'../资料/笔记 (一).md'});
  expect(text(next)).toBe('[文\\[件\\]\\*](<../资料/笔记 (一).md>)');
 });
});
