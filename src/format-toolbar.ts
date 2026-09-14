import {EditorView} from '@codemirror/view';
import {undo,redo,undoDepth,redoDepth} from '@codemirror/commands';
import {codeLanguage,codeLanguages} from './code-languages';
import {codeBlockAt,type FormatAction,type FormatOptions} from './formatting';

export function formatToolbar(host:HTMLElement,view:EditorView,format:(action:FormatAction,options?:FormatOptions)=>boolean){
 const toolbar=document.createElement('div');toolbar.className='format-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','文字格式');
 host.before(toolbar);
 let disposed=false,dialog:HTMLDialogElement|null=null;
 const editable:HTMLButtonElement[]=[];
 const heading=document.createElement('select');heading.setAttribute('aria-label','段落格式');heading.title='正文与标题';
 for(const [value,label] of [['','正文 / 标题'],['paragraph','正文'],['h1','一级标题'],['h2','二级标题'],['h3','三级标题']]){
  const option=new Option(label,value);option.disabled=!value;heading.add(option);
 }
 heading.value='';
 toolbar.append(heading);heading.onchange=()=>{format(heading.value as FormatAction);heading.value='';};
 function button(label:string,text:string,action:()=>void){
  const button=document.createElement('button');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.textContent=text;
  // Keep the editor's selection and focus on pointer activation. Keyboard activation still works.
  button.onpointerdown=event=>event.preventDefault();button.onclick=action;toolbar.append(button);return button;
 }
 const simple:Array<[FormatAction,string,string]>=[['bold','加粗（Ctrl+B）','加粗'],['italic','斜体（Ctrl+I）','斜体'],['bullet','无序列表','• 列表'],['ordered','有序列表','1. 列表'],['task','任务列表','☑ 任务'],['quote','引用','引用'],['inline-code','行内代码','行内代码']];
 for(const [action,label,text] of simple)editable.push(button(label,text,()=>{format(action);}));
 const codeButton=button('代码块与语言','代码块',()=>openDialog('code-block'));
 editable.push(button('插入链接','链接',()=>openDialog('link')));
 const undoButton=button('撤销（Ctrl+Z）','↶ 撤销',()=>{undo(view);view.focus();});
 const redoButton=button('重做（Ctrl+Y）','↷ 重做',()=>{redo(view);view.focus();});

 function openDialog(action:'code-block'|'link'){
  if(dialog||disposed)return;
  const savedSelection=view.state.selection,source=view.state.doc;
  const modal=document.createElement('dialog');dialog=modal;modal.className='modal formatting-dialog';
  const form=document.createElement('form');form.method='dialog';modal.append(form);
  const title=document.createElement('h2');title.textContent=action==='code-block'?'代码块与语言':'插入链接';form.append(title);
  const hint=document.createElement('p');hint.textContent=action==='code-block'?'选择代码语言以显示语法颜色；纯文本会保留原有内容与缩进。':'填写显示文字和网址，或笔记的相对路径。';form.append(hint);
  let language:HTMLSelectElement|undefined,label:HTMLInputElement|undefined,href:HTMLInputElement|undefined;
  function field(name:string,input:HTMLElement){const field=document.createElement('label');field.className='field-label';field.append(name,input);form.append(field);}
  if(action==='code-block'){
   language=document.createElement('select');language.add(new Option('纯文本',''));
   for(const item of codeLanguages)language.add(new Option(item.name,item.id));
   const existing=codeBlockAt(view.state)?.language||'',known=codeLanguage(existing);
   if(existing&&!known)language.add(new Option(existing+'（未支持，显示纯文本）',existing));
   language.value=known?.id||existing;field('代码语言',language);
  }else{
   label=document.createElement('input');label.value=view.state.sliceDoc(savedSelection.main.from,savedSelection.main.to)||'链接文字';label.required=true;field('显示文字',label);
   href=document.createElement('input');href.required=true;href.placeholder='https://… 或 笔记.md';field('链接地址',href);
  }
  const actions=document.createElement('div');actions.className='modal-actions';form.append(actions);
  const cancel=document.createElement('button');cancel.value='cancel';cancel.formNoValidate=true;cancel.className='secondary';cancel.textContent='取消';
  const confirm=document.createElement('button');confirm.value='confirm';confirm.className='primary';confirm.textContent='应用';actions.append(cancel,confirm);
  modal.addEventListener('close',()=>{
   const accepted=modal.returnValue==='confirm';modal.remove();if(dialog===modal)dialog=null;
   if(disposed||view.state.doc!==source)return;
   view.dispatch({selection:savedSelection});
   if(accepted)format(action,action==='code-block'?{language:language!.value}:{label:label!.value,href:href!.value});
   view.focus();
  },{once:true});
  document.body.append(modal);modal.showModal();(language||href)?.focus();
 }
 function update(){
  if(disposed)return;
  const inCode=!!codeBlockAt(view.state);
  for(const button of editable)button.disabled=inCode;
  heading.disabled=inCode;codeButton.title=inCode?'修改当前代码块语言':'插入代码块并选择语言';
  undoButton.disabled=undoDepth(view.state)===0;redoButton.disabled=redoDepth(view.state)===0;
 }
 update();
 return {update,destroy(){disposed=true;dialog?.close();dialog?.remove();dialog=null;toolbar.remove();}};
}
