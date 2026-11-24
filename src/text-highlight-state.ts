import {Facet,StateEffect,StateField,type Extension} from '@codemirror/state';
import {Decoration,EditorView} from '@codemirror/view';
import {invertedEffects} from '@codemirror/commands';
import {mapHighlights,type TextHighlight} from './text-highlights';

const initialHighlights=Facet.define<readonly TextHighlight[],readonly TextHighlight[]>({combine:values=>values[0]??[]});
export const setTextHighlights=StateEffect.define<readonly TextHighlight[]>({map:mapHighlights});
export const textHighlights=StateField.define<readonly TextHighlight[]>({
 create:state=>state.facet(initialHighlights),
 update:(value,tr)=>{
  if(tr.docChanged)value=mapHighlights(value,tr.changes);
  for(const effect of tr.effects)if(effect.is(setTextHighlights))value=effect.value;
  return value;
 }
});
export function highlightHistory(marks:readonly TextHighlight[]=[]):Extension{return [initialHighlights.of(marks),textHighlights,invertedEffects.of(tr=>tr.docChanged||tr.effects.some(effect=>effect.is(setTextHighlights))?[setTextHighlights.of(tr.startState.field(textHighlights))]:[])];}
export const highlightDecorations=EditorView.decorations.compute([textHighlights],state=>Decoration.set(state.field(textHighlights).map(mark=>Decoration.mark({class:'text-mark text-mark-'+mark.color}).range(mark.from,mark.to))));
