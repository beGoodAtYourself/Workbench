import {paintHighlights,sameHighlights,type HighlightColor,type TextHighlight} from './text-highlights';
import {highlightDecorations,highlightHistory,setTextHighlights,textHighlights} from './text-highlight-state';
import {Compartment,EditorSelection,EditorState,Facet,StateEffect,StateField,Transaction,type Extension} from '@codemirror/state';
import {Decoration,EditorView,ViewPlugin,keymap,type DecorationSet,type ViewUpdate} from '@codemirror/view';
import {copyLineDown,defaultKeymap,history,historyKeymap,indentLess,indentMore,invertedEffects,isolateHistory,redo,toggleComment,undo} from '@codemirror/commands';
import {bracketMatching,foldCode,foldGutter,foldKeymap,foldNodeProp,foldService,indentUnit,syntaxHighlighting,unfoldCode,type LanguageSupport} from '@codemirror/language';
import {isFallbackSupport,textLanguages,tokenHighlighter} from './code-languages';
import {editorBase,editorPosition,lineColumnPosition,measureHistory} from './editor-base';
import {TextSearchClient} from './text-search-client';
import {replacementFor,type SearchOptions,type SearchResult,type SearchScope} from './text-search';
import {MAX_TEXT_LENGTH,type TextEncoding,type TextEol,type TextRecord} from './text-types';

export interface OutputFormat {encoding:TextEncoding;eol:TextEol}
const initialFormat=Facet.define<OutputFormat,OutputFormat>({combine:values=>values[0]??{encoding:'utf8',eol:'crlf'}});
export const setOutputFormat=StateEffect.define<OutputFormat>();
export const outputFormat=StateField.define<OutputFormat>({create:state=>state.facet(initialFormat),update:(value,tr)=>{for(const effect of tr.effects)if(effect.is(setOutputFormat))value=effect.value;return value;}});
export function outputFormatHistory(format:OutputFormat):Extension{return [initialFormat.of(format),outputFormat,invertedEffects.of(tr=>tr.effects.some(effect=>effect.is(setOutputFormat))?[setOutputFormat.of(tr.startState.field(outputFormat))]:[])];}
export type TextLanguageCapabilities=Readonly<{comment:boolean;fold:boolean;commentReason:string;foldReason:string}>;
function unavailableCapabilities(reason:string):TextLanguageCapabilities{return {comment:false,fold:false,commentReason:reason+'，不提供代码注释',foldReason:reason+'，不提供代码折叠'};}
export function textLanguageCapabilities(state:EditorState,support?:LanguageSupport):TextLanguageCapabilities{
 if(!support||isFallbackSupport(support))return unavailableCapabilities(support?'语言资源加载失败，已使用纯文本':'纯文本模式');
 const comment=state.facet(support.language.data).some(data=>{const tokens=data.commentTokens;return !!(tokens?.line||(tokens?.block?.open&&tokens.block.close));});
 const parser=support.language.parser as LanguageSupport['language']['parser']&{nodeSet?:{types:readonly {prop:(property:typeof foldNodeProp)=>unknown}[]}};
 const fold=state.facet(foldService).length>0||!!parser.nodeSet?.types.some(node=>node.prop(foldNodeProp));
 return {comment,fold,commentReason:comment?'':'当前语言不提供代码注释',foldReason:fold?'':'当前语言模式不提供代码折叠'};
}
export type TextEditorDocument=TextRecord&{text:string};
export interface TextEditorCallbacks {
 onEdit:(text:string,highlights?:readonly TextHighlight[])=>void;onHighlights?:(marks:readonly TextHighlight[])=>void;canHighlight?:(marks:readonly TextHighlight[],length:number)=>boolean;onSelection?:(cursor:number,anchor:number,scroll:number)=>void;onFocus?:()=>void;
 onSave?:(as?:boolean)=>void;onSearch?:(replace:boolean)=>void;onFindNext?:(backward:boolean)=>void;onGoTo?:()=>void;
 onFormat?:(encoding:TextEncoding,eol:TextEol)=>void;onNotice?:(message:string)=>void;canEdit?:(text:string)=>boolean;
 onSearchResult?:(result:SearchResult|null)=>void;
 onCapabilitiesChange?:(capabilities:TextLanguageCapabilities)=>void;
}
export type TextEditorCommand='undo'|'redo'|'duplicateLine'|'indent'|'outdent'|'comment'|'fold'|'unfold'|'selectAll';
const memory=new WeakMap<TextEditorDocument,{state:EditorState;text:string}>(),metrics=new WeakMap<TextEditorDocument,{changes:number;bytes:number}>();
const repaintSearch=StateEffect.define<null>();
// Cached document state owns history and metadata, never a mounted editor's callbacks or plugins.
function persistentExtensions(format:OutputFormat,marks:readonly TextHighlight[]):Extension[]{return [history({minDepth:100}),outputFormatHistory(format),highlightHistory(marks),EditorState.allowMultipleSelections.of(true)];}

export function textEditor(parent:HTMLElement,doc:TextEditorDocument,callbacks:TextEditorCallbacks){
 let disposed=false,paused=false,binding=0,languageId=doc.language,languageGeneration=0,searchGeneration=0,loadedLanguage:LanguageSupport|undefined,searchResult:SearchResult|null=null,searchOptions:SearchOptions|null=null,matchIndex=-1;
 let text=doc.text,pendingSearch:{snapshot:EditorState['doc'];revision:number;generation:number;key:string;promise:Promise<SearchResult>}|null=null;
 let historyResetBinding:number|undefined;
 let pausedStyles:Extension=[];
 let capabilities=unavailableCapabilities('纯文本模式');
 const language=new Compartment(),settings=new Compartment(),client=new TextSearchClient();
 const options={tabSize:doc.tabSize,indentWithTabs:doc.indentWithTabs,wrap:doc.wrap};
 let meter=metrics.get(doc)??{changes:0,bytes:0};metrics.set(doc,meter);
 const notice=(message:string)=>callbacks.onNotice?.(message);
 const publishCapabilities=(value:TextLanguageCapabilities)=>{capabilities=value;callbacks.onCapabilitiesChange?.(value);};
 const hasCapability=(name:'comment'|'fold')=>{if(capabilities[name])return true;notice(name==='comment'?capabilities.commentReason:capabilities.foldReason);return false;};
 const publishSelection=()=>{if(disposed||paused)return;const selection=view.state.selection.main;callbacks.onSelection?.(selection.head,selection.anchor,view.scrollDOM.scrollTop);};
 const validEdit=(text:string)=>{if(disposed||paused)return false;if(text.length>MAX_TEXT_LENGTH){notice('正文超出会话上限，操作未执行');return false;}try{return callbacks.canEdit?.(text)??true;}catch(error){notice(error instanceof Error?error.message:'正文超出会话上限');return false;}};
 function resetSearch(){searchGeneration++;pendingSearch=null;client.cancel();searchResult=null;matchIndex=-1;callbacks.onSearchResult?.(null);}
 function settingsExtension():Extension{return [EditorState.tabSize.of(options.tabSize),indentUnit.of(options.indentWithTabs?'\t':' '.repeat(options.tabSize)),options.wrap?EditorView.lineWrapping:[]];}
 // 短暂隐藏只保留文档状态和静态样式；仍移除解析、装饰与搜索插件。
 // 样式定义不含正文或监听，保留相同 facet 可避免恢复时重写整份样式表。
 function pausedExtensions(format:OutputFormat):Extension[]{return [...persistentExtensions(format,doc.highlights??[]),pausedStyles,EditorState.readOnly.of(true),EditorView.editable.of(false),EditorState.transactionFilter.of(()=>[])];}
 function highlights(view:EditorView):DecorationSet{
  if(!searchResult||searchResult.status!=='ok')return Decoration.none;
  const ranges=[];
  for(const visible of view.visibleRanges)for(const match of searchResult.matches){
   if(match.from>=visible.to)break;
   if(match.to<=visible.from||match.from===match.to)continue;
   ranges.push(Decoration.mark({class:'text-search-match'}).range(Math.max(match.from,visible.from),Math.min(match.to,visible.to)));
  }
  return Decoration.set(ranges,true);
 }
 const searchHighlights=ViewPlugin.fromClass(class {decorations:DecorationSet;constructor(view:EditorView){this.decorations=highlights(view);}update(update:ViewUpdate){if(update.docChanged)this.decorations=Decoration.none;else if(update.viewportChanged||update.transactions.some(tr=>tr.effects.some(effect=>effect.is(repaintSearch))))this.decorations=highlights(update.view);}},{decorations:value=>value.decorations});
 function extensions(format:OutputFormat):Extension[]{return [
  ...editorBase(),outputFormatHistory(format),highlightHistory(doc.highlights??[]),highlightDecorations,EditorState.allowMultipleSelections.of(true),EditorView.clickAddsSelectionRange.of(event=>event.altKey),
  language.of(loadedLanguage??[]),settings.of(settingsExtension()),syntaxHighlighting(tokenHighlighter),bracketMatching(),foldGutter(),searchHighlights,
  EditorView.contentAttributes.of({'aria-label':doc.name+' 文本编辑器',spellcheck:'false'}),
  EditorState.transactionFilter.of(tr=>(tr.docChanged||tr.effects.some(effect=>effect.is(setOutputFormat)||effect.is(setTextHighlights)))&&!validEdit(tr.docChanged?tr.newDoc.toString():text)?[]:tr),
  EditorState.transactionFilter.of(tr=>callbacks.canHighlight&&!callbacks.canHighlight(tr.state.field(textHighlights),tr.newDoc.length)?[]:tr),
  keymap.of([
   {key:'Mod-s',run:()=>{callbacks.onSave?.(false);return true;}},{key:'Mod-Shift-s',run:()=>{callbacks.onSave?.(true);return true;}},
   {key:'Mod-f',run:()=>{callbacks.onSearch?.(false);return true;}},{key:'Mod-h',run:()=>{callbacks.onSearch?.(true);return true;}},
   {key:'F3',run:()=>{if(callbacks.onFindNext)callbacks.onFindNext(false);else find(false);return true;}},{key:'Shift-F3',run:()=>{if(callbacks.onFindNext)callbacks.onFindNext(true);else find(true);return true;}},
   {key:'Mod-g',run:()=>{callbacks.onGoTo?.();return true;}},{key:'Mod-d',run:copyLineDown},{key:'Mod-/',run:()=>{command('comment');return true;}},
   {key:'Tab',run:view=>{if(!view.state.selection.main.empty)return indentMore(view);const insert=options.indentWithTabs?'\t':' '.repeat(options.tabSize-((editorPosition(view.state).column-1)%options.tabSize));view.dispatch(view.state.replaceSelection(insert));return true;}},
   {key:'Shift-Tab',run:indentLess},...historyKeymap,...foldKeymap.map(binding=>({...binding,run:(target:EditorView)=>hasCapability('fold')?(binding.run?.(target)??false):true})),...defaultKeymap
  ]),
  EditorView.updateListener.of(update=>{
   if(update.docChanged){
    text=update.state.doc.toString();
    if(searchOptions?.scope){let scope=searchOptions.scope;for(const tr of update.transactions)scope={from:tr.changes.mapPos(scope.from,-1),to:tr.changes.mapPos(scope.to,1)};searchOptions={...searchOptions,scope};}
    resetSearch();callbacks.onEdit(text,update.state.field(textHighlights));
    let inserted=0;update.changes.iterChanges((_a,_b,_c,_d,text)=>{inserted+=text.length;});
    if(measureHistory(meter,inserted)){meter.changes=0;meter.bytes=0;const scheduledBinding=binding;historyResetBinding=binding;queueMicrotask(()=>{if(!disposed&&binding===scheduledBinding){historyResetBinding=undefined;const next=makeState(text,view.state.selection,view.state.field(outputFormat));view.setState(next);memory.set(doc,{state:next,text});}});}
   }
   if(!update.docChanged&&!sameHighlights(update.startState.field(textHighlights),update.state.field(textHighlights)))callbacks.onHighlights?.(update.state.field(textHighlights));
   memory.set(doc,{state:update.state,text});
   const before=update.startState.field(outputFormat),after=update.state.field(outputFormat);
   if(before.encoding!==after.encoding||before.eol!==after.eol){resetSearch();callbacks.onFormat?.(after.encoding,after.eol);queueMicrotask(()=>{if(!disposed&&!paused)view.dispatch({effects:repaintSearch.of(null)});});}
   if(update.docChanged||update.selectionSet)publishSelection();
  }),
  EditorView.domEventHandlers({focus:()=>{if(!disposed&&!paused)callbacks.onFocus?.();},scroll:()=>{publishSelection();}})
 ];}
 function makeState(text:string,selection:EditorSelection|{anchor:number;head?:number}={anchor:Math.min(doc.anchor,text.length),head:Math.min(doc.cursor,text.length)},format:OutputFormat={encoding:doc.encoding,eol:doc.eol}){return EditorState.create({doc:text,selection,extensions:paused?pausedExtensions(format):extensions(format)});}
 function documentState(){
  const cached=memory.get(doc),format={encoding:doc.encoding,eol:doc.eol};
  const compatible=cached&&cached.text===doc.text&&sameHighlights(cached.state.field(textHighlights,false),doc.highlights)&&cached.state.field(outputFormat,false)?.encoding===doc.encoding&&cached.state.field(outputFormat,false)?.eol===doc.eol;
  return compatible?cached.state.update({effects:StateEffect.reconfigure.of(extensions(format)),filter:false}).state:makeState(doc.text);
 }
 function rememberDocument(){
  const extensions=persistentExtensions(view.state.field(outputFormat),view.state.field(textHighlights));
  const state=historyResetBinding===binding?EditorState.create({doc:view.state.doc,selection:view.state.selection,extensions}):view.state.update({effects:StateEffect.reconfigure.of(extensions),filter:false}).state;
  historyResetBinding=undefined;
  memory.set(doc,{state,text});
 }
 const view=new EditorView({parent,state:documentState()});view.dom.classList.add('text-code-editor');
 let scrollFrame=0;
 function restoreScroll(){if(scrollFrame)cancelAnimationFrame(scrollFrame);scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;if(!disposed&&!paused)view.scrollDOM.scrollTop=doc.scroll;});}
 restoreScroll();
 if(doc.language!=='plain')void setLanguage(doc.language);
 async function setLanguage(id:string){
  if(disposed)return;languageId=id;if(paused)return;
  const selected=textLanguages.find(item=>item.id===id)??textLanguages[0],generation=++languageGeneration;
  loadedLanguage=undefined;publishCapabilities(unavailableCapabilities(selected.description?'语言资源加载中':'纯文本模式'));view.dispatch({effects:language.reconfigure([])});
  if(!selected.description)return;
  try{
   const support=await selected.description.load();if(disposed||paused||generation!==languageGeneration)return;
   loadedLanguage=isFallbackSupport(support)?undefined:support;view.dispatch({effects:language.reconfigure(loadedLanguage??[])});publishCapabilities(textLanguageCapabilities(view.state,support));
   if(isFallbackSupport(support))notice('语言资源加载失败，已使用纯文本');
  }catch{if(!disposed&&!paused&&generation===languageGeneration){loadedLanguage=undefined;view.dispatch({effects:language.reconfigure([])});publishCapabilities(unavailableCapabilities('语言资源加载失败，已使用纯文本'));notice('语言资源加载失败，已使用纯文本');}}
 }
 function setOptions(value:Partial<typeof options>){Object.assign(options,value);options.tabSize=[2,4,8].includes(options.tabSize)?options.tabSize:4;if(!disposed&&!paused)view.dispatch({effects:settings.reconfigure(settingsExtension())});}
 function setFormat(value:Partial<OutputFormat>){if(disposed||paused)return;const before=view.state.field(outputFormat),after={...before,...value};if(before.encoding===after.encoding&&before.eol===after.eol)return;view.dispatch({effects:setOutputFormat.of(after),annotations:isolateHistory.of('full')});}
 function command(name:TextEditorCommand):boolean{
  if(disposed||paused)return false;
  if((name==='comment'&&!hasCapability('comment'))||((name==='fold'||name==='unfold')&&!hasCapability('fold')))return false;
  const commands={undo,redo,duplicateLine:copyLineDown,indent:indentMore,outdent:indentLess,comment:toggleComment,fold:foldCode,unfold:unfoldCode,selectAll:(view:EditorView)=>{view.dispatch({selection:{anchor:0,head:view.state.doc.length}});return true;}};
  const success=commands[name](view);if(!success&&['comment','fold','unfold'].includes(name))notice(name==='comment'?'当前语言或位置不支持注释':'当前位置没有可折叠的代码');view.focus();return success;
 }
 function search(value:SearchOptions):Promise<SearchResult>{
  const key=JSON.stringify(value),snapshot=view.state.doc,revision=doc.revision;
  if(disposed||paused)return Promise.resolve({documentId:doc.id,revision,generation:searchGeneration,status:'cancelled',matches:[],scope:value.scope??{from:0,to:text.length}});
  if(searchResult?.status==='ok'&&searchResult.revision===revision&&key===JSON.stringify(searchOptions))return Promise.resolve(searchResult);
  if(pendingSearch?.snapshot===snapshot&&pendingSearch.revision===revision&&pendingSearch.generation===searchGeneration&&pendingSearch.key===key)return pendingSearch.promise;
  searchOptions={...value,scope:value.scope?{...value.scope}:undefined};const generation=++searchGeneration;
  searchResult=null;matchIndex=-1;view.dispatch({effects:repaintSearch.of(null)});
  const promise=client.run(doc.id,revision,text,searchOptions).then(result=>{
   if(disposed||paused||generation!==searchGeneration||view.state.doc!==snapshot||doc.revision!==revision)return {...result,status:'cancelled' as const,matches:[],changes:undefined};
   searchResult=result;matchIndex=-1;callbacks.onSearchResult?.(result);view.dispatch({effects:repaintSearch.of(null)});return result;
  }).finally(()=>{if(pendingSearch?.promise===promise)pendingSearch=null;});
  pendingSearch={snapshot,revision,generation,key,promise};return promise;
 }
 function find(backward=false){
  if(disposed||paused||searchResult?.status!=='ok'||!searchResult.matches.length)return null;
  const matches=searchResult.matches,selection=view.state.selection.main;let index:number,wrapped=false;
  if(matchIndex>=0&&matches[matchIndex]?.from===selection.from&&matches[matchIndex]?.to===selection.to){index=matchIndex+(backward?-1:1);if(index<0||index>=matches.length){wrapped=true;index=(index+matches.length)%matches.length;}}
  else if(backward){index=-1;for(let at=matches.length-1;at>=0;at--)if(matches[at].to<=selection.from){index=at;break;}if(index<0){index=matches.length-1;wrapped=true;}}
  else {index=matches.findIndex(match=>match.from>=selection.to);if(index<0){index=0;wrapped=true;}}
  matchIndex=index;const match=matches[index];view.dispatch({selection:{anchor:match.from,head:match.to},effects:EditorView.scrollIntoView(match.from,{y:'center'})});view.focus();return {index,total:matches.length,wrapped};
 }
 function replaceCurrent(replacement:string){
  if(disposed||paused||searchResult?.status!=='ok'||!searchOptions)return false;
  const selection=view.state.selection.main;let match=searchResult.matches.find(item=>item.from===selection.from&&item.to===selection.to);
  if(!match){const found=find();if(!found)return false;match=searchResult.matches[found.index];}
  const insert=replacementFor(match,replacement,!!searchOptions.regex),next=text;
  if(!validEdit(next.slice(0,match.from)+insert+next.slice(match.to)))return false;
  view.dispatch({changes:{from:match.from,to:match.to,insert},selection:{anchor:match.from+insert.length},annotations:[isolateHistory.of('full'),Transaction.userEvent.of('input.replace')]});
  if(!disposed&&searchOptions)void search(searchOptions);return true;
 }
 async function replaceAll(replacement:string):Promise<number>{
  if(disposed||paused||!searchOptions)return 0;
  pendingSearch=null;
  const snapshot=view.state.doc,revision=doc.revision,generation=++searchGeneration,result=await client.run(doc.id,revision,text,searchOptions,replacement);
  if(disposed||paused||generation!==searchGeneration||view.state.doc!==snapshot||doc.revision!==revision)return 0;
  if(result.status!=='ok'||!result.changes){searchResult=result;callbacks.onSearchResult?.(result);notice(result.message??'替换未执行');return 0;}
  const changes=view.state.changes(result.changes),nextText=changes.apply(snapshot).toString();if(!validEdit(nextText))return 0;
  const scope=searchOptions.scope;view.dispatch({changes,selection:scope?{anchor:changes.mapPos(scope.from,-1),head:changes.mapPos(scope.to,1)}:undefined,annotations:[isolateHistory.of('full'),Transaction.userEvent.of('input.replace.all')]});
  const count=result.matches.length;if(!disposed&&searchOptions)void search(searchOptions);return count;
 }
 function paint(color:HighlightColor|null){
  if(disposed||paused)return false;
  const ranges=view.state.selection.ranges.filter(range=>!range.empty);
  if(!ranges.length){notice('请先选中需要标注或清除标注的文字');return false;}
  const before=view.state.field(textHighlights),after=paintHighlights(before,ranges,color);
  if(sameHighlights(before,after)){view.focus();return false;}
  view.dispatch({effects:setTextHighlights.of(after),annotations:isolateHistory.of('full')});view.focus();return true;
 }
 return {view,search,find,replaceCurrent,replaceAll,setLanguage,setOptions,setFormat,command,paint,
  getHighlights:()=>view.state.field(textHighlights),
  getText:()=>text,
  getCapabilities:()=>capabilities,
  position:()=>editorPosition(view.state),getSearchResult:()=>searchResult,getSearchScope:()=>searchOptions?.scope,
  selectionScope():SearchScope|null{const selection=view.state.selection.main;if(view.state.selection.ranges.length>1)notice('限定范围仅使用主选区');return selection.empty?null:{from:selection.from,to:selection.to};},
  clearSearch(){searchOptions=null;resetSearch();if(!disposed&&!paused)view.dispatch({effects:repaintSearch.of(null)});},
  focus(){if(!disposed&&!paused)view.focus();},
  goTo(line:number,column=1){const position=lineColumnPosition(view.state,line,column);if(disposed||paused)return {line:position.line,column:position.column,clamped:position.clamped};view.dispatch({selection:{anchor:position.position},effects:EditorView.scrollIntoView(position.position,{y:'center'})});if(position.clamped)notice('行列超出范围，已定位到最近的合法位置');view.focus();return {line:position.line,column:position.column,clamped:position.clamped};},
  isPaused:()=>paused,
  rebind(next:TextEditorDocument,nextCallbacks:TextEditorCallbacks){
   if(disposed)throw new Error('Cannot bind a destroyed text editor');
   publishSelection();rememberDocument();binding++;languageGeneration++;searchOptions=null;resetSearch();
   if(scrollFrame){cancelAnimationFrame(scrollFrame);scrollFrame=0;}
   // Only the visible view is reused. The old document retains pure state;
   // its worker, parser, callbacks and DOM bindings do not follow it.
   doc=next;callbacks=nextCallbacks;text=doc.text;paused=false;pausedStyles=[];loadedLanguage=undefined;languageId=doc.language;
   Object.assign(options,{tabSize:doc.tabSize,indentWithTabs:doc.indentWithTabs,wrap:doc.wrap});
   meter=metrics.get(doc)??{changes:0,bytes:0};metrics.set(doc,meter);
   capabilities=unavailableCapabilities('纯文本模式');view.setState(documentState());restoreScroll();
   if(languageId!=='plain')void setLanguage(languageId);
  },
  pause(){
   if(disposed||paused)return;publishSelection();paused=true;languageGeneration++;loadedLanguage=undefined;searchOptions=null;resetSearch();
   if(scrollFrame){cancelAnimationFrame(scrollFrame);scrollFrame=0;}
   pausedStyles=view.state.facet(EditorView.styleModule).map(module=>EditorView.styleModule.of(module));
   view.dispatch({effects:StateEffect.reconfigure.of(pausedExtensions(view.state.field(outputFormat))),filter:false});
   memory.set(doc,{state:view.state,text});capabilities=unavailableCapabilities('文本会话已暂停');
  },
  resume(){
   if(disposed||!paused)return;paused=false;
   view.dispatch({effects:StateEffect.reconfigure.of(extensions(view.state.field(outputFormat))),filter:false});pausedStyles=[];
   restoreScroll();view.requestMeasure();if(languageId!=='plain')void setLanguage(languageId);else publishCapabilities(unavailableCapabilities('纯文本模式'));
  },
  destroy(){
   if(disposed)return;publishSelection();disposed=true;languageGeneration++;searchGeneration++;pendingSearch=null;client.destroy();
   if(scrollFrame)cancelAnimationFrame(scrollFrame);
   rememberDocument();view.destroy();
  }
 };
}
export type TextEditor=ReturnType<typeof textEditor>;
