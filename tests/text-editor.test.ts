import {expect,it} from 'vitest';
import {EditorState} from '@codemirror/state';
import {history,isolateHistory,redo,undo} from '@codemirror/commands';
import {foldService} from '@codemirror/language';
import {editorPosition,lineColumnPosition,measureHistory} from '../src/editor-base';
import {outputFormat,outputFormatHistory,setOutputFormat,textLanguageCapabilities} from '../src/text-editor';
import {isFallbackSupport,textLanguageForPath,textLanguages} from '../src/code-languages';
it('counts emoji as one column and a tab as one character, and clamps invalid locations',()=>{
 const state=EditorState.create({doc:'中文😀\tX\nlast',selection:{anchor:5}});
 expect(editorPosition(state)).toEqual({line:1,column:5});expect(lineColumnPosition(state,1,4)).toEqual({line:1,column:4,position:4,clamped:false});
 expect(lineColumnPosition(state,99,99)).toEqual({line:2,column:5,position:11,clamped:true});expect(lineColumnPosition(state,0,0)).toEqual({line:1,column:1,position:0,clamped:true});
});
it('undoes and redoes output encoding and newline choices without touching body text',()=>{
 let state=EditorState.create({doc:'中文\n😀',extensions:[history(),outputFormatHistory({encoding:'utf8',eol:'mixed'})]});
 const dispatch=(transaction:ReturnType<typeof state.update>)=>{state=transaction.state;};
 state=state.update({effects:setOutputFormat.of({encoding:'utf16be',eol:'lf'}),annotations:isolateHistory.of('full')}).state;
 expect(state.field(outputFormat)).toEqual({encoding:'utf16be',eol:'lf'});expect(undo({state,dispatch})).toBe(true);
 expect(state.field(outputFormat)).toEqual({encoding:'utf8',eol:'mixed'});expect(state.doc.toString()).toBe('中文\n😀');expect(redo({state,dispatch})).toBe(true);expect(state.field(outputFormat)).toEqual({encoding:'utf16be',eol:'lf'});
});
it('keeps a scoped batch replacement as one undoable operation',()=>{
 let state=EditorState.create({doc:'cat cat cat',extensions:history()});
 state=state.update({changes:[{from:4,to:7,insert:'狗'}],annotations:isolateHistory.of('full')}).state;
 expect(state.doc.toString()).toBe('cat 狗 cat');expect(undo({state,dispatch:transaction=>{state=transaction.state;}})).toBe(true);expect(state.doc.toString()).toBe('cat cat cat');
});
it('uses the existing 200-change or 4 Mi inserted-unit history boundary',()=>{
 const meter={changes:198,bytes:0};expect(measureHistory(meter,1)).toBe(false);expect(measureHistory(meter,1)).toBe(true);expect(measureHistory({changes:0,bytes:4*1024*1024},1)).toBe(true);
});
it('maps text extensions independently from note code-fence choices',()=>{
 expect(textLanguages).toHaveLength(21);expect(textLanguageForPath('C:\\work\\test.TSX')).toBe('tsx');expect(textLanguageForPath('/notes/a.md')).toBe('markdown');expect(textLanguageForPath('/work/a.svg')).toBe('xml');expect(textLanguageForPath(null)).toBe('plain');expect(textLanguageForPath('unknown.blob')).toBe('plain');
});
it('reports actual language capabilities without requiring a foldable range at the current cursor',async()=>{
 expect(textLanguageCapabilities(EditorState.create())).toMatchObject({comment:false,fold:false,commentReason:expect.stringContaining('纯文本'),foldReason:expect.stringContaining('纯文本')});
 for(const [id,comment,fold] of [['javascript',true,true],['json',false,true],['xml',true,false],['markdown',true,true]] as const){
  const support=await textLanguages.find(item=>item.id===id)!.description!.load(),state=EditorState.create({extensions:support});
  expect(isFallbackSupport(support)).toBe(false);expect(textLanguageCapabilities(state,support)).toMatchObject({comment,fold});
  if(!comment)expect(textLanguageCapabilities(state,support).commentReason).toContain('不提供');if(!fold)expect(textLanguageCapabilities(state,support).foldReason).toContain('不提供');
 }
 const xml=await textLanguages.find(item=>item.id==='xml')!.description!.load(),state=EditorState.create({extensions:[xml,foldService.of(()=>null)]});
 expect(textLanguageCapabilities(state,xml).fold).toBe(true);
});
