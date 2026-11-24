import {describe,expect,it} from 'vitest';
import {EditorState} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
import {paintHighlights,mapHighlights,validHighlights,type TextHighlight} from '../src/text-highlights';
import {highlightHistory,setTextHighlights,textHighlights} from '../src/text-highlight-state';

const yellow=(from:number,to:number):TextHighlight=>({from,to,color:'yellow'});
describe('text background annotations',()=>{
 it('recolors and clears only selected ranges, merging adjacent runs',()=>{
  expect(paintHighlights([yellow(0,10)],[{from:3,to:7}],'blue')).toEqual([yellow(0,3),{from:3,to:7,color:'blue'},yellow(7,10)]);
  expect(paintHighlights([yellow(0,10)],[{from:3,to:7}],null)).toEqual([yellow(0,3),yellow(7,10)]);
  expect(paintHighlights([yellow(0,3)],[{from:3,to:7}],'yellow')).toEqual([yellow(0,7)]);
  expect(paintHighlights([],[{from:0,to:3},{from:6,to:9}],'pink')).toEqual([{from:0,to:3,color:'pink'},{from:6,to:9,color:'pink'}]);
 });
 it('maps UTF-16 offsets through edits without coloring inserted boundary text',()=>{
  const state=EditorState.create({doc:'😀abcdef'});
  expect(mapHighlights([yellow(2,6)],state.changes({from:0,insert:'前'}))).toEqual([yellow(3,7)]);
  expect(mapHighlights([yellow(2,6)],state.changes({from:2,insert:'X'}))).toEqual([yellow(3,7)]);
  expect(mapHighlights([yellow(2,6)],state.changes({from:4,insert:'X'}))).toEqual([yellow(2,7)]);
  expect(mapHighlights([yellow(2,6)],state.changes({from:2,to:6}))).toEqual([]);
 });
 it('undo and redo restore deleted ranges as well as text, and undo coloring independently',()=>{
  let state=EditorState.create({doc:'abcdef',extensions:[history(),highlightHistory()]});
  const target={get state(){return state;},dispatch(tr:import('@codemirror/state').Transaction){state=tr.state;}};
  state=state.update({effects:setTextHighlights.of([yellow(1,5)])}).state;
  expect(state.doc.toString()).toBe('abcdef');expect(undo(target)).toBe(true);expect(state.field(textHighlights)).toEqual([]);
  expect(redo(target)).toBe(true);expect(state.field(textHighlights)).toEqual([yellow(1,5)]);
  state=state.update({changes:{from:1,to:5}}).state;expect(state.field(textHighlights)).toEqual([]);
  expect(undo(target)).toBe(true);expect(state.doc.toString()).toBe('abcdef');expect(state.field(textHighlights)).toEqual([yellow(1,5)]);
  expect(redo(target)).toBe(true);expect(state.doc.toString()).toBe('af');expect(state.field(textHighlights)).toEqual([]);
 });
 it('validates persisted ranges and limits',()=>{
  expect(validHighlights([yellow(0,2),{from:2,to:4,color:'pink'}],4)).toBe(true);
  for(const marks of [[yellow(1,1)],[yellow(0,301)],[yellow(0,3),yellow(2,4)],[{from:0,to:1,color:'bad'}],Array.from({length:257},(_,i)=>yellow(i,i+1))])expect(validHighlights(marks,300)).toBe(false);
 });
});
