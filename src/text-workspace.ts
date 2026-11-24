import {highlightColors,type HighlightColor} from './text-highlights';
import {encodingOptions} from './text-encodings';
import {TextWorkbench,type TextDocument} from './text-model';
import {outputFormat,textEditor,type TextEditorCallbacks} from './text-editor';
import {codeLanguages} from './code-languages';
import {asFault} from './types';
import {MAX_TEXT_LENGTH,type TextEncoding,type TextEol} from './text-types';
import {escape} from './markdown';
import './text-style.css';
import {textTabDrag} from './text-tab-drag';

type Editor=ReturnType<typeof textEditor>;
type EditorPane={doc:TextDocument;pane:HTMLElement;version:string;revision:number;language:string;options:string};
type TextTab={doc:TextDocument;wrap:HTMLDivElement;tab:HTMLButtonElement;close:HTMLButtonElement;dot:HTMLSpanElement;label:Text};
const editorOptionsKey=(doc:TextDocument)=>doc.tabSize+'|'+doc.indentWithTabs+'|'+doc.wrap;
const paths:Record<string,string>={new:'M6 3h8l4 4v14H6z M14 3v5h4 M9 13h6 M12 10v6',open:'M3 6h7l2 2h9v12H3z M3 12h18',save:'M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8',undo:'M9 5 3 11l6 6 M3 11h10a6 6 0 0 1 6 6',redo:'m15 5 6 6-6 6 M21 11H11a6 6 0 0 0-6 6',search:'M20 20l-5-5 M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14',replace:'M4 7h13m-4-4 4 4-4 4 M20 17H7m4-4-4 4 4 4',split:'M3 4h18v16H3z M12 4v16',close:'m6 6 12 12 M18 6 6 18',code:'m8 7-5 5 5 5 m8-10 5 5-5 5 M14 4l-4 16',down:'m6 9 6 6 6-6',up:'m6 15 6-6 6 6',settings:'M4 6h16 M8 3v6 M4 12h16 M16 9v6 M4 18h16 M10 15v6'};
function icon(name:string){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[name]+'"/></svg>';}
function command(action:string,label:string,symbol:string,shortcut=''){return '<button type="button" data-text-action="'+action+'" aria-label="'+label+'" title="'+label+(shortcut?' · '+shortcut:'')+'">'+icon(symbol)+'<span>'+label+'</span></button>';}
export async function textChoice(title:string,message:string,choices:Array<{value:string;label:string;primary?:boolean}>):Promise<string>{
 const dialog=document.createElement('dialog');dialog.className='modal text-dialog';dialog.setAttribute('aria-label',title);
 dialog.innerHTML='<form method="dialog"><h2>'+escape(title)+'</h2><p>'+escape(message)+'</p><div class="modal-actions">'+choices.map(c=>'<button value="'+escape(c.value)+'" class="'+(c.primary?'primary':'secondary')+'">'+escape(c.label)+'</button>').join('')+'</div></form>';
 document.body.append(dialog);dialog.showModal();dialog.querySelector<HTMLButtonElement>('button')?.focus();
 return new Promise(resolve=>dialog.addEventListener('close',()=>{const value=dialog.returnValue||'cancel';dialog.remove();resolve(value);},{once:true}));
}
export class TextWorkspace {
 private disposeTabDrag: () => void;
 private editors=new Map<string,Editor>();
 private panes=new Map<string,EditorPane>();
 private tabEntries=new Map<string,TextTab>();
 private visible=false;
 private epoch=0;
 private searchTimer:ReturnType<typeof setTimeout>|undefined;
 private searchOpen=false;
 private replaceOpen=false;
 private scope:{from:number;to:number}|undefined;
 private currentSearch='';
 private searchDocument='';
 private searching=0;
 private lastFocus:string|undefined;
 private readonly keydown=(event:KeyboardEvent)=>this.onKey(event);
 private readonly toolbar:HTMLElement;
 private readonly tabs:HTMLElement;
 private readonly paneHost:HTMLElement;
 private readonly searchHost:HTMLElement;
 private readonly status:HTMLElement;
 private readonly errorHost:HTMLElement;
 constructor(private host:HTMLElement,readonly model:TextWorkbench,private notify:(message:string)=>void,private preview:boolean){
  host.className='text-workspace';host.setAttribute('aria-label','文本编辑工作区');
  host.innerHTML='<div class="text-toolbar" role="toolbar" aria-label="文本文件与编辑命令"><div class="text-command-group">'+command('new','新建文本','new','Ctrl+N')+command('open','打开文本文件','open','Ctrl+O')+command('save','保存文本','save','Ctrl+S')+'<button data-text-action="save-as">另存为</button><button data-text-action="save-all">全部保存</button><details class="text-more"><summary aria-label="更多文本操作">更多</summary><div class="text-more-menu" aria-label="文本操作"><button data-text-action="open-encoding">指定编码打开</button><button data-text-action="reopen-encoding">以其他编码重新打开</button><button data-text-action="close">关闭当前文本</button><button data-text-action="close-others">关闭其他文本</button><button data-text-action="move-left">标签向前移动</button><button data-text-action="move-right">标签向后移动</button><button data-text-action="duplicateLine">复制当前行</button><button data-text-action="comment">切换代码注释</button><button data-text-action="indent">增加缩进</button><button data-text-action="outdent">减少缩进</button><button data-text-action="fold">折叠代码</button><button data-text-action="unfold">展开代码</button><button data-text-action="selectAll">全选文本</button></div></details></div><div class="text-command-group text-edit-commands">'+command('undo','撤销文本编辑','undo','Ctrl+Z')+command('redo','重做文本编辑','redo','Ctrl+Y')+command('find','查找','search','Ctrl+F')+command('replace','替换','replace','Ctrl+H')+'</div><div class="text-command-group text-highlight-tools" role="group" aria-label="选区背景标注"><span class="text-highlight-label">标注</span>'+highlightColors.map(([color,label])=>'<button type="button" class="text-highlight-swatch text-mark-'+color+'" data-text-action="highlight-'+color+'" title="'+label+'背景标注 · 仅本机保存" aria-label="'+label+'背景标注"><span aria-hidden="true">A</span></button>').join('')+'<button type="button" data-text-action="highlight-clear" title="清除选中文字的背景标注" aria-label="清除选区标注">清除</button></div><div class="text-command-group text-view-commands">'+command('split','双视图','split')+command('options','编辑设置','settings')+'</div></div><div class="text-tabbar"><div class="text-tabs" role="tablist" aria-label="已打开文本"></div><button class="text-add-tab" data-text-action="new" title="新建文本 · Ctrl+N" aria-label="新建文本标签">'+icon('new')+'</button><span class="text-tab-count"></span></div><div class="text-search" hidden></div><div class="text-global-error" role="status" hidden></div><div class="text-panes"></div><footer class="text-statusbar"><span class="text-document-state"></span><div class="text-document-options"></div></footer>';
  this.toolbar=host.querySelector('.text-toolbar')!;this.tabs=host.querySelector('.text-tabs')!;this.paneHost=host.querySelector('.text-panes')!;this.searchHost=host.querySelector('.text-search')!;this.status=host.querySelector('.text-statusbar')!;this.errorHost=host.querySelector('.text-global-error')!;
  host.addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-text-action]');if(button&&!button.disabled){this.host.querySelector<HTMLDetailsElement>('.text-more')?.removeAttribute('open');this.task(()=>this.action(button.dataset.textAction!));}});
  model.onChange=layout=>{if(!this.visible)return;if(layout)this.task(()=>this.render());else this.update();};
  this.disposeTabDrag = textTabDrag(this.tabs, (id, target) => {
   this.task(() => this.model.move(id, this.model.documents.findIndex(doc => doc.id === target)));
  });
  window.addEventListener('keydown',this.keydown);
 }
 private task(action:()=>unknown|Promise<unknown>){void Promise.resolve().then(action).catch(error=>{this.notify(asFault(error).message);this.update();});}
 private activeEditor(){const doc=this.model.current();return doc?this.editors.get(doc.id):undefined;}
 focus(){this.activeEditor()?.focus();}
 async show(){const wasPaused=[...this.editors.values()].some(editor=>editor.isPaused());this.visible=true;this.host.hidden=false;await this.render();if(this.visible&&wasPaused)this.focus();}
 pause(){this.visible=false;this.epoch++;this.cancelSearch();for(const editor of this.editors.values())editor.pause();this.host.hidden=true;}
 hide(){this.visible=false;this.epoch++;this.cancelSearch();for(const editor of this.editors.values())editor.destroy();this.editors.clear();this.panes.clear();this.paneHost.replaceChildren();this.host.hidden=true;}
 destroy(){this.disposeTabDrag();this.hide();this.tabs.replaceChildren();this.tabEntries.clear();window.removeEventListener('keydown',this.keydown);}
 async render(){
  if(!this.visible)return;const refocus=!!(document.activeElement as HTMLElement|null)?.closest('.text-editor-host');const epoch=++this.epoch;this.cancelSearch();
  const wanted=new Map(this.model.recoveryBlocked?[]:this.model.views.flatMap(id=>{const doc=this.model.documents.find(item=>item.id===id);return doc?[[id,doc] as const]:[];}));
  const replacements=[...wanted.values()].filter(doc=>doc.loaded&&!this.panes.has(doc.id));
  for(const [id,record] of this.panes){
   const doc=wanted.get(id),editor=this.editors.get(id),format=editor?.view.state.field(outputFormat,false);
   if(!doc&&editor&&replacements.length){
    const next=replacements.shift()!;
    editor.rebind(next,this.callbacks(next,record));
    this.editors.delete(id);this.panes.delete(id);
    Object.assign(record,{doc:next,version:next.version,revision:next.revision,language:next.language,options:editorOptionsKey(next)});
    record.pane.dataset.document=next.id;this.editors.set(next.id,editor);this.panes.set(next.id,record);
    continue;
   }
   if(!doc||record.doc!==doc||record.version!==doc.version||record.revision!==doc.revision||!editor||editor.getText()!==doc.text||format?.encoding!==doc.encoding||format?.eol!==doc.eol){
    editor?.destroy();this.editors.delete(id);record.pane.remove();this.panes.delete(id);
   }
  }
  const retained=new Set([...this.panes.values()].map(record=>record.pane));
  for(const child of [...this.paneHost.children])if(!retained.has(child as HTMLElement))child.remove();
  if(this.model.recoveryBlocked){
   this.paneHost.innerHTML='<section class="text-empty"><div class="text-empty-symbol">'+icon('code')+'</div><h1>文本草稿尚未完整恢复</h1><p>现有恢复记录已保留。处理问题后可重试恢复，其他模块仍可使用。</p></section>';
  }else if(!this.model.documents.length){
   this.paneHost.innerHTML='<section class="text-empty"><div class="text-empty-symbol">'+icon('code')+'</div><h1>文本编辑</h1><p>临时记下想法，或打开文本、代码与配置文件。可将文件拖入窗口打开。</p><div class="text-empty-actions"><button class="primary" data-text-action="new">新建文本 <kbd>Ctrl N</kbd></button><button class="secondary" data-text-action="open">打开文件 <kbd>Ctrl O</kbd></button></div><p class="text-empty-detail">未保存的文本会暂存本机，下次打开可继续编辑。'+(this.preview?'<br>浏览器预览使用示例数据，不会写入本地文件。':'')+'</p></section>';
  }else{
   for(const [index,id] of this.model.views.entries()){
    const doc=this.model.documents.find(d=>d.id===id);if(!doc)continue;
    let record=this.panes.get(id),editor=this.editors.get(id);
    if(!record){
     const pane=document.createElement('section');pane.className='text-pane';pane.dataset.document=id;
     pane.innerHTML='<header class="text-pane-heading"><span class="text-pane-name"></span><span class="text-pane-path"></span><button class="text-pane-close" title="关闭视图，保留标签" aria-label="关闭第二文本视图">'+icon('close')+'</button></header><div class="text-editor-host"></div>';
     pane.querySelector('button')!.addEventListener('click',()=>this.model.merge());
     record={doc,pane,version:doc.version,revision:doc.revision,language:doc.language,options:editorOptionsKey(doc)};this.panes.set(id,record);
    }
    const pane=record.pane,before=this.paneHost.children[index];
    if(before!==pane)this.paneHost.insertBefore(pane,before??null);
    pane.setAttribute('aria-label',doc.name+' 文本窗格');const name=pane.querySelector('.text-pane-name')!;if(name.textContent!==doc.name)name.textContent=doc.name;
    const path=pane.querySelector<HTMLElement>('.text-pane-path')!,pathLabel=doc.path||'未命名 · 尚未选择保存位置';if(path.textContent!==pathLabel)path.textContent=pathLabel;if(path.title!==(doc.path||''))path.title=doc.path||'';
    pane.querySelector<HTMLButtonElement>('.text-pane-close')!.hidden=index===0;
    if(!doc.loaded){pane.querySelector('.text-editor-host')!.textContent='正在恢复文本…';await this.model.activate(id,index);if(epoch!==this.epoch||!this.visible||this.model.views[index]!==id||!this.model.documents.includes(doc))return;}
    if(!editor){
     pane.querySelector('.text-editor-host')!.replaceChildren();
     editor=textEditor(pane.querySelector<HTMLElement>('.text-editor-host')!,doc,this.callbacks(doc,record));
     this.editors.set(id,editor);record.version=doc.version;record.revision=doc.revision;
    }
    if(record.language!==doc.language){record.language=doc.language;void editor.setLanguage(doc.language);}
    const options=editorOptionsKey(doc);if(record.options!==options){record.options=options;editor.setOptions({tabSize:doc.tabSize,indentWithTabs:doc.indentWithTabs,wrap:doc.wrap});}
    editor.resume();
    editor.view.contentDOM.setAttribute('aria-label',doc.name+' 文本编辑器');
   }
  }
  if(epoch!==this.epoch||!this.visible)return;this.update();if(this.searchOpen)this.buildSearch();
  const focus=this.model.current();if(focus&&(refocus||focus.id!==this.lastFocus)){this.lastFocus=focus.id;this.editors.get(focus.id)?.focus();}
 }
 private callbacks(doc:TextDocument,record:EditorPane):TextEditorCallbacks{return {
     onEdit:(text,marks)=>{this.model.edit(doc,text,undefined,marks);record!.revision=doc.revision;this.changed();},
     onHighlights:marks=>{this.model.mark(doc,marks);this.update();},
     canHighlight:(marks,length)=>{try{this.model.checkHighlights(doc,marks,length);return true;}catch(error){this.notify(asFault(error).message);return false;}},
     onSelection:(cursor,anchor,scroll)=>{const changed=doc.cursor!==cursor||doc.anchor!==anchor||doc.scroll!==scroll;doc.cursor=cursor;doc.anchor=anchor;doc.scroll=scroll;if(changed&&!this.model.frozen)this.model.touch(doc);this.updatePosition();},
     onFocus:()=>{const index=this.model.views.indexOf(doc.id);if(index<0)return;if(this.model.active!==index){this.model.active=index;if(!this.model.frozen)this.model.touch(doc);if(this.searchOpen)this.buildSearch();}this.lastFocus=doc.id;this.update();},
     onSave:as=>this.task(()=>this.save(doc,as)),onSearch:replace=>this.openSearch(replace),onGoTo:()=>this.task(()=>this.goTo()),
     onFormat:(encoding,eol)=>{this.model.edit(doc,doc.text,{encoding,eol});record!.revision=doc.revision;this.update();},onNotice:this.notify,
     onFindNext:backward=>this.find(backward),
     onCapabilitiesChange:()=>this.update(),
     canEdit:text=>{if(!this.model.canEdit(doc))return false;const sum=this.model.documents.reduce((n,d)=>n+(d.id===doc.id?text.length:d.length),0);if(sum>MAX_TEXT_LENGTH){this.notify('文本总长度超过 16 Mi 个代码单元，请先关闭部分文档。');return false;}return true;}
 };}
 private changed(){if(this.searchOpen){clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>this.task(()=>this.runSearch()),180);}this.update();}
 update(){
  if(!this.visible)return;const current=this.model.current();
  this.host.setAttribute('aria-busy', String(this.model.opening));
  const ids=new Set(this.model.documents.map(doc=>doc.id));
  for(const [id,entry] of this.tabEntries)if(!ids.has(id)){entry.wrap.remove();this.tabEntries.delete(id);}
  for(const [index,doc] of this.model.documents.entries()){
   let entry=this.tabEntries.get(doc.id);
   if(!entry){
    const wrap=document.createElement('div');wrap.className='text-tab';wrap.draggable=false;wrap.dataset.document=doc.id;
    const tab=document.createElement('button');tab.setAttribute('role','tab');
    const label=document.createTextNode(doc.name);tab.append(label);
    const dot=document.createElement('span');dot.className='text-dirty-dot';dot.setAttribute('aria-label','未保存');
    const close=document.createElement('button');close.className='text-tab-close';close.innerHTML=icon('close');
    const item:TextTab={doc,wrap,tab,close,dot,label};entry=item;this.tabEntries.set(doc.id,item);
    // Handlers resolve the mutable record so a restored object with the same id never uses an old buffer.
    tab.onclick=()=>this.task(()=>this.model.activate(item.doc.id));
    tab.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();this.cycle(event.key==='ArrowLeft'?-1:1);}if(event.key==='Delete'){event.preventDefault();this.task(()=>this.close(item.doc));}};
    close.onclick=()=>this.task(()=>this.close(item.doc));wrap.append(tab,close);
   }
   entry.doc=doc;const {wrap,tab,close,dot,label}=entry,active=doc.id===current?.id;
   wrap.classList.toggle('active',active);if(tab.getAttribute('aria-selected')!==String(active))tab.setAttribute('aria-selected',String(active));
   if(tab.tabIndex!==(active?0:-1))tab.tabIndex=active?0:-1;if(tab.title!==(doc.path||doc.name))tab.title=doc.path||doc.name;
   if(label.data!==doc.name)label.data=doc.name;
   if(doc.dirty){if(dot.parentNode!==tab)tab.prepend(dot);}else if(dot.parentNode)dot.remove();
   const closeLabel='关闭 '+doc.name;if(close.getAttribute('aria-label')!==closeLabel)close.setAttribute('aria-label',closeLabel);if(close.title!==closeLabel)close.title=closeLabel;
   const before=this.tabs.children[index];if(before!==wrap)this.tabs.insertBefore(wrap,before??null);
  }
  const count=this.host.querySelector('.text-tab-count')!,countLabel=this.model.documents.length+' / 12';if(count.textContent!==countLabel)count.textContent=countLabel;
  for(const pane of this.paneHost.querySelectorAll<HTMLElement>('.text-pane'))pane.classList.toggle('active',pane.dataset.document===current?.id);
  for(const button of this.toolbar.querySelectorAll<HTMLButtonElement>('button'))button.disabled=this.model.opening||this.model.recoveryBlocked||(!current&&!['new','open','open-encoding'].includes(button.dataset.textAction||''));
  const capabilities=this.activeEditor()?.getCapabilities();
  for(const action of ['comment','fold','unfold'] as const){
   const button=this.toolbar.querySelector<HTMLButtonElement>('[data-text-action="'+action+'"]')!,available=capabilities?.[action==='comment'?'comment':'fold'];
   const reason=available?'':capabilities?(action==='comment'?capabilities.commentReason:capabilities.foldReason):'文本编辑器尚未就绪';
   button.disabled=button.disabled||!available;
   if(reason){button.title=reason;button.setAttribute('aria-description',reason);}else{button.removeAttribute('title');button.removeAttribute('aria-description');}
  }
  const split=this.toolbar.querySelector<HTMLButtonElement>('[data-text-action="split"]')!;split.disabled=this.model.recoveryBlocked||this.model.documents.length<2;split.title=this.model.views.length===2?'合并视图':'双视图';split.querySelector('span')!.textContent=this.model.views.length===2?'合并视图':'双视图';split.setAttribute('aria-label',split.title);
  const error=this.model.recoveryBlocked?this.model.recoveryError:current?.error||this.model.recoveryError;
  this.errorHost.hidden=!error;this.errorHost.replaceChildren();
  if(error){const message=document.createElement('span');message.textContent=error.message;this.errorHost.append(message);for(const [action,label] of this.model.recoveryBlocked?[['restore','重试恢复']]:current?.error?[['retry','重试保存'],['save-as','另存副本'],['reload','重新载入']]:[['checkpoint','重试暂存']]){const b=document.createElement('button');b.dataset.textAction=action;b.textContent=label;this.errorHost.append(b);}}
  if(this.model.recoveryBlocked)for(const button of this.paneHost.querySelectorAll<HTMLButtonElement>('button'))button.disabled=true;
  this.status.hidden=!current||this.model.recoveryBlocked;
  if(!current)return;
  const state=this.status.querySelector<HTMLElement>('.text-document-state')!;
  const recovery=current.recoveryRevision===current.revision?'已暂存本机':'正在等待暂存';
  const stateLabel=current.saving?'正在保存…':current.dirty?'未保存到原文件 · '+recovery:current.path?(this.preview?'已保存到示例数据':'已保存到原文件'):'未命名 · '+recovery;
  const label=stateLabel+(current.highlights.length||current.markRevision!==current.recoveryMarkRevision?' · 标注'+(current.markRevision===current.recoveryMarkRevision?'已存本机':'待暂存'):'');if(state.textContent!==label)state.textContent=label;
  state.classList.toggle('dirty',current.dirty);
  const options=this.status.querySelector<HTMLElement>('.text-document-options')!;
  const key=current.language+'|'+current.encoding+'|'+current.eol+'|'+current.tabSize+'|'+current.indentWithTabs+'|'+current.wrap;
  if(options.dataset.key!==key){
   options.dataset.key=key;options.innerHTML='<span class="text-position"></span><label><span class="sr-only">代码语言</span><select aria-label="代码语言">'+[['plain','纯文本'],['markdown','Markdown'],['xml','XML'],...codeLanguages.map(l=>[l.id,l.name])].map(([id,name])=>'<option value="'+id+'">'+name+'</option>').join('')+'</select></label><label><span class="sr-only">文本编码</span><select aria-label="文本编码" title="保存时使用的编码；乱码请在更多菜单中选择以其他编码重新打开">'+encodingOptions()+'</select></label><label><span class="sr-only">文件换行</span><select aria-label="文件换行"><option value="crlf">CRLF</option><option value="lf">LF</option>'+(current.eol==='mixed'?'<option value="mixed">混合换行</option>':current.eol==='cr'?'<option value="cr">CR</option>':'')+'</select></label><button data-text-action="options">'+(current.indentWithTabs?'Tab':'空格')+': '+current.tabSize+'</button><button data-text-action="wrap" aria-pressed="'+current.wrap+'">自动换行</button>';
   const [language,encoding,eol]=options.querySelectorAll<HTMLSelectElement>('select');language.value=current.language;encoding.value=current.encoding;eol.value=current.eol;
   language.onchange=()=>{const doc=this.model.current();if(!doc)return;this.model.configure(doc,{language:language.value});this.activeEditor()?.setLanguage(language.value);};
   encoding.onchange=()=>this.activeEditor()?.setFormat({encoding:encoding.value as TextEncoding});
   eol.onchange=()=>this.activeEditor()?.setFormat({eol:eol.value as TextEol});
  }
  this.updatePosition();
 }
 private updatePosition(){const doc=this.model.current(),label=this.status.querySelector('.text-position');if(!doc||!label)return;const result=this.activeEditor()?.position(),position=result?'行 '+result.line+'，列 '+result.column:'行 1，列 1';if(label.textContent!==position)label.textContent=position;}
 async save(doc=this.model.current(),as=false){
  if(!doc)return false;
  if(doc.eol==='mixed'||doc.eol==='cr'){
   const choice=await textChoice('选择文件换行','这个文件含混合或 CR 换行。保存前请选择统一的换行格式。',[{value:'cancel',label:'取消'},{value:'lf',label:'统一为 LF'},{value:'crlf',label:'统一为 CRLF',primary:true}]);
   if(choice==='cancel')return false;
   const editor=this.editors.get(doc.id);if(editor)editor.setFormat({eol:choice as TextEol});else this.model.edit(doc,doc.text,{encoding:doc.encoding,eol:choice as TextEol});
  }
  const saved=await this.model.save(doc,as);if(saved&&this.preview)this.notify('已保存到浏览器示例数据；本地文件没有改变。');this.update();return saved;
 }
 private async askClose(doc:TextDocument):Promise<'save'|'discard'|'cancel'>{return await textChoice('关闭 '+doc.name,'这份文本尚未保存到原文件。“不保存”将删除此标签的本机草稿。',[{value:'cancel',label:'取消'},{value:'discard',label:'不保存'},{value:'save',label:'保存',primary:true}]) as 'save'|'discard'|'cancel';}
 private async close(doc:TextDocument):Promise<boolean>{if(doc.dirty&&(doc.eol==='mixed'||doc.eol==='cr')){const choice=await this.askClose(doc);if(choice==='cancel')return false;if(choice==='save'){if(!await this.save(doc)||doc.dirty)return false;return this.model.close(doc,async()=> 'discard');}return this.model.close(doc,async()=> 'discard');}return this.model.close(doc,d=>this.askClose(d));}
 private async action(action:string){
  const doc=this.model.current();
  if(action==='open-encoding'||action==='reopen-encoding'){await this.chooseEncoding(action==='reopen-encoding');return;}
  if(action.startsWith('highlight-')){this.activeEditor()?.paint(action==='highlight-clear'?null:action.slice(10) as HighlightColor);return;}
  if(action==='new'){this.model.create();return;}
  if (action === 'open') {
   const result = await this.model.open();
   if (result.errors.length) {
    this.notify(result.errors.map(error => error.message).join('；'));
   }
   this.focus();
   return;
  }
  if(action==='save'||action==='retry'){await this.save();return;}
  if(action==='save-as'){await this.save(doc,true);return;}
  if(action==='save-all'){for(const item of this.model.documents)if((item.dirty||!item.path||item.markRevision!==item.recoveryMarkRevision)&&!await this.save(item))break;return;}
  if(action==='checkpoint'){await this.model.checkpoint();this.update();return;}
  if(action==='restore'){await this.model.restore();this.update();return;}
  if(action==='close'&&doc){await this.close(doc);return;}
  if(action==='close-others'&&doc){for(const other of [...this.model.documents])if(other!==doc&&!await this.close(other))break;return;}
  if((action==='move-left'||action==='move-right')&&doc){this.model.move(doc.id,this.model.documents.indexOf(doc)+(action==='move-left'?-1:1));return;}
  if(['duplicateLine','comment','fold','unfold','indent','outdent','selectAll'].includes(action)){this.activeEditor()?.command(action as import('./text-editor').TextEditorCommand);return;}
  if(action==='split'){if(this.model.views.length===2)this.model.merge();else await this.model.split();return;}
  if(action==='undo'||action==='redo'){this.activeEditor()?.command(action);return;}
  if(action==='find'||action==='replace'){this.openSearch(action==='replace');return;}
  if(action==='wrap'&&doc){this.model.configure(doc,{wrap:!doc.wrap});this.activeEditor()?.setOptions({wrap:doc.wrap});return;}
  if(action==='options'){await this.options();return;}
  if(action==='reload'&&doc){if(doc.dirty&&await textChoice('重新载入文本','这会丢弃当前尚未保存的修改。',[{value:'cancel',label:'取消'},{value:'reload',label:'丢弃并重载',primary:true}])!=='reload')return;await this.model.reload(doc);return;}
 }
 private async chooseEncoding(reopen:boolean){
  const doc=this.model.current();if(reopen&&!doc?.path){this.notify('请先打开一个已保存的文本文件。');return;}
  const revision=doc?.revision,dialog=document.createElement('dialog'),title=reopen?'以其他编码重新打开':'指定编码打开';
  dialog.className='modal text-dialog';dialog.setAttribute('aria-label',title);
  dialog.innerHTML='<form method="dialog"><h2>'+title+'</h2><label class="field-label">读取编码<select aria-label="读取编码">'+encodingOptions()+'</select></label><p>'+(reopen?'按所选编码重新读取原文件。'+(doc?.dirty?'当前未保存的修改将被丢弃。':'磁盘文件不会改变。'):'按所选编码读取接下来选择的文件。通常可直接用“打开文本文件”自动识别。已打开的标签请使用“以其他编码重新打开”。')+'</p><div class="modal-actions"><button value="cancel" class="secondary">取消</button><button value="apply" class="primary">'+(reopen&&doc?.dirty?'丢弃修改并重新打开':'打开')+'</button></div></form>';
  const select=dialog.querySelector<HTMLSelectElement>('select')!;select.value=reopen?doc!.encoding:'gb18030';document.body.append(dialog);dialog.showModal();
  const apply=await new Promise<boolean>(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='apply'),{once:true}));const encoding=select.value as TextEncoding;dialog.remove();
  if(!apply)return;
  if(reopen){if(doc?.revision!==revision)return;await this.model.reload(doc,encoding);}
  else{const result=await this.model.open(encoding);if(result.errors.length)this.notify(result.errors.map(error=>error.message).join('；'));}
 }
 private async options(){
  const doc=this.model.current();if(!doc)return;const dialog=document.createElement('dialog');dialog.className='modal text-dialog';dialog.setAttribute('aria-label','文本编辑设置');
  dialog.innerHTML='<form method="dialog"><h2>文本编辑设置</h2><label class="field-label">缩进方式<select name="indent"><option value="spaces">空格</option><option value="tabs">Tab 字符</option></select></label><label class="field-label">缩进宽度<select name="size"><option>2</option><option>4</option><option>8</option></select></label><label class="text-check"><input type="checkbox" name="wrap">自动换行</label><p>设置仅改变显示与后续输入，不自动转换已有缩进。</p><div class="modal-actions"><button value="cancel" class="secondary">取消</button><button value="apply" class="primary">应用设置</button></div></form>';
  const indent=dialog.querySelector<HTMLSelectElement>('[name="indent"]')!,size=dialog.querySelector<HTMLSelectElement>('[name="size"]')!,wrap=dialog.querySelector<HTMLInputElement>('[name="wrap"]')!;indent.value=doc.indentWithTabs?'tabs':'spaces';size.value=String(doc.tabSize);wrap.checked=doc.wrap;document.body.append(dialog);dialog.showModal();
  await new Promise<void>(resolve=>dialog.addEventListener('close',()=>{if(dialog.returnValue==='apply'){const patch={indentWithTabs:indent.value==='tabs',tabSize:Number(size.value),wrap:wrap.checked};this.model.configure(doc,patch);this.editors.get(doc.id)?.setOptions(patch);}dialog.remove();resolve();},{once:true}));
 }
 private async goTo(){const editor=this.activeEditor();if(!editor)return;const dialog=document.createElement('dialog');dialog.className='modal text-dialog';dialog.setAttribute('aria-label','跳转行列');dialog.innerHTML='<form method="dialog"><h2>跳转行列</h2><label class="field-label">行号<input name="line" inputmode="numeric" type="number" min="1" value="1" required></label><label class="field-label">列号<input name="column" inputmode="numeric" type="number" min="1" value="1" required></label><div class="modal-actions"><button value="cancel" formnovalidate class="secondary">取消</button><button value="go" class="primary">跳转</button></div></form>';document.body.append(dialog);dialog.showModal();dialog.querySelector<HTMLInputElement>('input')?.select();await new Promise<void>(resolve=>dialog.addEventListener('close',()=>{if(dialog.returnValue==='go'){const result=editor.goTo(Number(dialog.querySelector<HTMLInputElement>('[name="line"]')!.value),Number(dialog.querySelector<HTMLInputElement>('[name="column"]')!.value));if(result.clamped)this.notify('位置超出正文，已跳转到最近的有效行列。');}dialog.remove();resolve();},{once:true}));}
 private cycle(step:number){const doc=this.model.current(),index=this.model.documents.findIndex(d=>d===doc),next=this.model.documents[(index+step+this.model.documents.length)%this.model.documents.length];if(next)this.task(()=>this.model.activate(next.id));}
 private onKey(event:KeyboardEvent){
  if(!this.visible||this.host.closest('[inert]')||event.isComposing||document.querySelector('dialog[open]')||event.defaultPrevented)return;
  const target=event.target as HTMLElement;if(target.matches('input,textarea,select')&&!target.closest('.cm-editor'))return;
  const key=event.key.toLowerCase();if(event.ctrlKey&&!event.altKey){const action=key==='n'?'new':key==='o'?'open':key==='s'?(event.shiftKey?'save-as':'save'):key==='w'?'close':key==='f'?'find':key==='h'?'replace':undefined;if(action){event.preventDefault();this.task(()=>this.action(action));return;}if(key==='tab'){event.preventDefault();this.cycle(event.shiftKey?-1:1);}if(key==='g'){event.preventDefault();this.task(()=>this.goTo());}}
  if(event.key==='F3'){event.preventDefault();this.find(event.shiftKey);}
 }
 private cancelSearch(){clearTimeout(this.searchTimer);this.searching++;for(const editor of this.editors.values())editor.clearSearch();}
 openSearch(replace=false){if(!this.visible||this.model.frozen||!this.model.current())return;this.searchOpen=true;this.replaceOpen=replace;this.scope=this.activeEditor()?.selectionScope()??undefined;this.searchDocument=this.model.current()!.id;this.buildSearch();this.searchHost.querySelector<HTMLInputElement>('[name="query"]')?.focus();}
 private buildSearch(){
  this.searchHost.hidden=!this.searchOpen;if(!this.searchOpen)return;
  const id=this.model.current()?.id??'';if(id!==this.searchDocument){this.searchDocument=id;this.scope=this.activeEditor()?.selectionScope()??undefined;}
  if(!this.searchHost.firstElementChild){
  this.searchHost.innerHTML='<div class="text-search-main"><label class="text-search-input"><span class="sr-only">查找内容</span><input name="query" aria-label="查找内容" autocomplete="off" placeholder="查找内容"></label><button data-search="previous" title="上一个 · Shift+F3" aria-label="上一个匹配">'+icon('up')+'</button><button data-search="next" title="下一个 · F3" aria-label="下一个匹配">'+icon('down')+'</button><span class="text-search-result" role="status"></span><button data-search="close" aria-label="关闭查找">'+icon('close')+'</button></div><div class="text-search-flags"><label><input type="checkbox" name="case">区分大小写</label><label><input type="checkbox" name="word">整词</label><label><input type="checkbox" name="regex">正则表达式</label><label><input type="checkbox" name="dot">点号跨行</label><label><input type="checkbox" name="scope"'+(!this.scope||this.scope.from===this.scope.to?' disabled':'')+'>仅选区</label><button data-search="toggle">'+(this.replaceOpen?'收起替换':'展开替换')+'</button></div><div class="text-replace-row"'+(this.replaceOpen?'':' hidden')+'><label class="text-search-input"><span class="sr-only">替换内容</span><input name="replacement" aria-label="替换内容" autocomplete="off" placeholder="替换内容"></label><button data-search="replace">替换当前</button><button data-search="replace-all">全部替换</button><small>正则替换：$1、$&lt;name&gt;、$$</small></div>';
  this.searchHost.oninput=event=>{const field=event.target as HTMLInputElement;if(field.name==='regex'){const word=this.searchHost.querySelector<HTMLInputElement>('[name="word"]')!;word.disabled=field.checked;if(field.checked)word.checked=false;}clearTimeout(this.searchTimer);this.searchTimer=setTimeout(()=>this.task(()=>this.runSearch()),160);};
  this.searchHost.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();this.searchOpen=false;this.searchHost.hidden=true;this.cancelSearch();this.activeEditor()?.focus();}if(event.key==='Enter'&&!(event.target as HTMLElement).matches('button')){event.preventDefault();clearTimeout(this.searchTimer);this.task(async()=>{await this.runSearch();this.find(event.shiftKey);});}};
  this.searchHost.onclick=event=>{const action=(event.target as HTMLElement).closest<HTMLElement>('[data-search]')?.dataset.search;if(!action)return;this.task(async()=>{
   if(action==='close'){this.searchOpen=false;this.searchHost.hidden=true;this.cancelSearch();this.activeEditor()?.focus();return;}
   if(action==='toggle'){this.replaceOpen=!this.replaceOpen;this.searchHost.querySelector<HTMLElement>('.text-replace-row')!.hidden=!this.replaceOpen;(event.target as HTMLElement).textContent=this.replaceOpen?'收起替换':'展开替换';return;}
   const result=await this.runSearch();if(!result)return;
   if(action==='previous'||action==='next'){this.find(action==='previous');return;}
   const editor=this.activeEditor(),replacement=this.searchHost.querySelector<HTMLInputElement>('[name="replacement"]')!.value;if(!editor)return;
   if(action==='replace')editor.replaceCurrent(replacement);if(action==='replace-all'){const count=await editor.replaceAll(replacement);this.notify('已替换 '+count+' 处，可一次撤销。');}await this.runSearch();
  });};
  }
  this.searchHost.querySelector<HTMLInputElement>('[name="query"]')!.value=this.currentSearch;
  for(const name of ['case','word','regex','dot','scope']){
   const field=this.searchHost.querySelector<HTMLInputElement>('[name="'+name+'"]')!;
   field.checked=false;field.disabled=name==='scope'&&(!this.scope||this.scope.from===this.scope.to);
  }
  this.searchHost.querySelector<HTMLInputElement>('[name="replacement"]')!.value='';
  this.searchHost.querySelector<HTMLElement>('.text-replace-row')!.hidden=!this.replaceOpen;
  this.searchHost.querySelector('[data-search="toggle"]')!.textContent=this.replaceOpen?'收起替换':'展开替换';
  const result=this.searchHost.querySelector('.text-search-result')!;result.textContent='';result.classList.remove('error');
  if(this.currentSearch)this.task(()=>this.runSearch());
 }
 private async runSearch(){
  const editor=this.activeEditor(),doc=this.model.current();if(!this.visible||this.model.frozen||!this.searchOpen||!editor||!doc)return false;
  const query=this.searchHost.querySelector<HTMLInputElement>('[name="query"]')!.value;this.currentSearch=query;const generation=++this.searching;const checkbox=(name:string)=>!!this.searchHost.querySelector<HTMLInputElement>('[name="'+name+'"]')?.checked;
  if(checkbox('scope'))this.scope=editor.getSearchScope()??this.scope;
  const label=this.searchHost.querySelector('.text-search-result')!;label.textContent='正在查找…';
  const result=await editor.search({query,caseSensitive:checkbox('case'),regex:checkbox('regex'),wholeWord:checkbox('word'),dotAll:checkbox('dot'),scope:checkbox('scope')?this.scope:undefined});
  if(generation!==this.searching||doc!==this.model.current())return false;
  label.textContent=result.status==='ok'?result.matches.length+' 处匹配':result.message||'查找已取消';label.classList.toggle('error',!['ok','cancelled'].includes(result.status));return result.status==='ok';
 }
 private find(backward=false){const result=this.activeEditor()?.find(backward);if(result){const label=this.searchHost.querySelector('.text-search-result');if(label)label.textContent=(result.index+1)+' / '+result.total+(result.wrapped?' · 已循环':'');}else this.openSearch(false);}
}
