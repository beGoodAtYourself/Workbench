import {expect,test,type Page} from '@playwright/test';

async function enter(page:Page){await page.goto('/?empty');await page.locator('#nav-text').click();}
async function create(page:Page,text:string){await page.getByRole('button',{name:'新建文本',exact:true}).click();await page.locator('.text-pane.active .cm-content').fill(text);}

test('short hide reuses both views and histories while a module exit releases every text view',async({page})=>{
 await enter(page);await create(page,'left draft');await create(page,'right draft');
 await page.locator('.text-pane.active .cm-content').press('Control+End');await page.keyboard.insertText('!');
 await page.getByRole('button',{name:'双视图',exact:true}).click();
 const views=await page.locator('.text-pane .cm-editor').elementHandles();expect(views).toHaveLength(2);
 try{
  for(let index=0;index<5;index++){
   await page.locator('#hide').click();await expect(page.locator('#app')).not.toHaveAttribute('inert','');
   for(const view of views)expect(await view.evaluate(element=>element.isConnected)).toBe(true);
   await expect(page.locator('.text-pane.active .cm-content')).toBeFocused();
  }
  const saved=await page.evaluate(()=>{const manifest=JSON.parse(localStorage.getItem('shiye-demo-text-session-v1')!);return manifest.documents.map((doc:{blob:string})=>localStorage.getItem(doc.blob));});
  expect(saved).toEqual(['left draft','right draft!']);
  await page.locator('#nav-notes').click();await expect(page.locator('#text-workspace .cm-editor')).toHaveCount(0);
  for(const view of views)expect(await view.evaluate(element=>element.isConnected)).toBe(false);
  await page.locator('#nav-text').click();await expect(page.locator('.text-pane')).toHaveCount(2);
  await page.getByRole('tab',{name:/未命名 2$/}).click();await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();
  await expect(page.locator('.text-pane.active .cm-content')).toHaveText('right draft');
 }finally{for(const view of views)await view.dispose();}
});

test('paused editor rejects document, format and selection changes and cancels its worker without callbacks',async({page})=>{
 await enter(page);await create(page,'fixture');
 const result=await page.evaluate(async()=>{
  const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/text-editor.ts')!;
  const {textEditor,outputFormat}=await import(url) as typeof import('../../src/text-editor');
  const languageUrl=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname.endsWith('/@codemirror_language.js'))!;
  const {language,syntaxParserRunning}=await import(languageUrl) as typeof import('@codemirror/language');
  const doc:import('../../src/text-editor').TextEditorDocument={id:'paused-fixture',path:null,name:'fixture.json',text:'{"cat":"cat"}',length:13,version:'',encoding:'utf8',eol:'lf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'json',tabSize:4,indentWithTabs:false,wrap:false};
  const host=document.createElement('div');document.body.append(host);const counts={edit:0,format:0,selection:0,focus:0};
  const editor=textEditor(host,doc,{onEdit:text=>{counts.edit++;doc.text=text;doc.length=text.length;doc.revision++;},onFormat:()=>{counts.format++;},onSelection:()=>{counts.selection++;},onFocus:()=>{counts.focus++;}});
  try{
   await editor.setLanguage('json');editor.view.dispatch({changes:{from:doc.text.length,insert:'!'},selection:{anchor:3}});
   const pending=editor.search({query:'cat'}),view=editor.view;editor.pause();const before={...counts},selection=view.state.selection.main.head;
   view.dispatch({changes:{from:0,insert:'hidden input'},selection:{anchor:0}});editor.setFormat({encoding:'utf16be'});editor.goTo(1,1);editor.focus();
   view.scrollDOM.dispatchEvent(new Event('scroll'));const undoWhilePaused=editor.command('undo'),searchWhilePaused=await editor.search({query:'cat'});
   await new Promise(resolve=>setTimeout(resolve,20));
   const paused={readonly:view.contentDOM.contentEditable,body:editor.getText(),selectionUnchanged:view.state.selection.main.head===selection,callbacksUnchanged:JSON.stringify(before)===JSON.stringify(counts),format:view.state.field(outputFormat).encoding,fold:editor.getCapabilities().fold,languageDetached:view.state.facet(language)===null,parserRunning:syntaxParserRunning(view)};
   const cancelled=(await pending).status;editor.resume();await editor.setLanguage('json');
   const resumed={sameView:editor.view===view,editable:view.contentDOM.contentEditable,fold:editor.getCapabilities().fold,undo:editor.command('undo'),body:editor.getText()};
   editor.pause();editor.destroy();const replacement=textEditor(host,doc,{onEdit:()=>{}});const afterDestroy=replacement.view.contentDOM.contentEditable;replacement.destroy();
   return {paused,cancelled,undoWhilePaused,searchWhilePaused:searchWhilePaused.status,resumed,afterDestroy};
  }finally{editor.destroy();host.remove();}
 });
 expect(result).toEqual({paused:{readonly:'false',body:'{"cat":"cat"}!',selectionUnchanged:true,callbacksUnchanged:true,format:'utf8',fold:false,languageDetached:true,parserRunning:false},cancelled:'cancelled',undoWhilePaused:false,searchWhilePaused:'cancelled',resumed:{sameView:true,editable:'true',fold:true,undo:true,body:'{"cat":"cat"}'},afterDestroy:'true'});
 await expect.poll(()=>page.workers().length).toBe(0);
});

test('a history reset queued before pause cannot reactivate a hidden editor',async({page})=>{
 await enter(page);await create(page,'fixture');
 const result=await page.evaluate(async()=>{
  const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/text-editor.ts')!;
  const {textEditor}=await import(url) as typeof import('../../src/text-editor');
  const doc:import('../../src/text-editor').TextEditorDocument={id:'history-pause',path:null,name:'fixture.txt',text:'',length:0,version:'',encoding:'utf8',eol:'lf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'plain',tabSize:4,indentWithTabs:false,wrap:false};
  const host=document.createElement('div');document.body.append(host);let edits=0;
  const editor=textEditor(host,doc,{onEdit:text=>{edits++;doc.text=text;doc.length=text.length;doc.revision++;}});
  try{
   for(let index=0;index<200;index++)editor.view.dispatch({changes:{from:editor.getText().length,insert:'x'}});
   editor.pause();await Promise.resolve();const readonly=editor.view.contentDOM.contentEditable;
   editor.view.dispatch({changes:{from:0,insert:'hidden'}});const beforeResume=editor.getText();editor.resume();
   return {readonly,beforeResume,edits,undo:editor.command('undo'),afterResume:editor.getText(),editable:editor.view.contentDOM.contentEditable};
  }finally{editor.destroy();host.remove();}
 });
 expect(result).toEqual({readonly:'false',beforeResume:'x'.repeat(200),edits:200,undo:false,afterResume:'x'.repeat(200),editable:'true'});
});

test('failed recovery commit blocks hiding and restores the same editable focused view',async({page})=>{
 await enter(page);await create(page,'draft before failed hide');
 const view=await page.locator('.text-pane.active .cm-editor').elementHandle();
 await page.evaluate(async()=>{
  const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/text-model.ts')!;
  const {TextWorkbench}=await import(url) as typeof import('../../src/text-model'),suspend=TextWorkbench.prototype.suspend;
  TextWorkbench.prototype.suspend=async function(){
   const checkpoint=this.repo.checkpoint;this.repo.checkpoint=async()=>{throw {code:'recovery',message:'fixture checkpoint refused'};};
   try{return await suspend.call(this);}finally{this.repo.checkpoint=checkpoint;TextWorkbench.prototype.suspend=suspend;}
  };
 });
 await page.locator('#hide').click();await expect(page.locator('#toast')).toContainText('fixture checkpoint refused');
 await expect(page.locator('#app')).not.toHaveAttribute('inert','');await expect(page.locator('#text-workspace')).toBeVisible();
 const content=page.locator('.text-pane.active .cm-content');await expect(content).toBeFocused();
 expect(await view!.evaluate(element=>element.isConnected)).toBe(true);await view!.dispose();
 await content.press('Control+End');await page.keyboard.insertText('!');await expect(content).toHaveText('draft before failed hide!');
});

test('rebinding a visible editor isolates body, history, format, selection and cancelled search per document',async({page})=>{
 await enter(page);await create(page,'fixture');
 const result=await page.evaluate(async()=>{
  const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/text-editor.ts')!;
  const {textEditor,outputFormat}=await import(url) as typeof import('../../src/text-editor');
  const make=(id:string,text:string):import('../../src/text-editor').TextEditorDocument=>({id,path:null,name:id+'.txt',text,length:text.length,version:'',encoding:'utf8',eol:'lf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'plain',tabSize:4,indentWithTabs:false,wrap:false});
  const a=make('A','alpha'),b=make('B','bravo'),calls={A:0,B:0};
  const callbacks=(doc:typeof a)=>({onEdit:(text:string)=>{calls[doc.id as 'A'|'B']++;doc.text=text;doc.length=text.length;doc.revision++;},onFormat:(encoding:typeof doc.encoding,eol:typeof doc.eol)=>{doc.encoding=encoding;doc.eol=eol;doc.revision++;},onSelection:(cursor:number,anchor:number,scroll:number)=>Object.assign(doc,{cursor,anchor,scroll})});
  const host=document.createElement('div');document.body.append(host);const editor=textEditor(host,a,callbacks(a)),dom=editor.view.dom;
  try{
   editor.view.dispatch({changes:{from:5,insert:'!'},selection:{anchor:3}});editor.setFormat({encoding:'utf16be'});
   const pending=editor.search({query:'alpha'});editor.rebind(b,callbacks(b));const cancelled=(await pending).status;
   const fresh={body:editor.getText(),format:editor.view.state.field(outputFormat).encoding,undo:editor.command('undo')};
   editor.view.dispatch({changes:{from:5,insert:'?'},selection:{anchor:2}});editor.rebind(a,callbacks(a));
   const restored={body:editor.getText(),format:editor.view.state.field(outputFormat).encoding,cursor:editor.view.state.selection.main.head};
   editor.command('undo');const formatUndo=editor.view.state.field(outputFormat).encoding;editor.command('undo');const bodyUndo=editor.getText();
   editor.rebind(b,callbacks(b));const second={body:editor.getText(),cursor:editor.view.state.selection.main.head,undo:editor.command('undo'),after:editor.getText()};
   return {sameView:editor.view.dom===dom,cancelled,fresh,restored,formatUndo,bodyUndo,second,calls};
  }finally{editor.destroy();host.remove();}
 });
 expect(result).toEqual({sameView:true,cancelled:'cancelled',fresh:{body:'bravo',format:'utf8',undo:false},restored:{body:'alpha!',format:'utf16be',cursor:3},formatUndo:'utf8',bodyUndo:'alpha',second:{body:'bravo?',cursor:2,undo:true,after:'bravo'},calls:{A:2,B:2}});
 await expect.poll(()=>page.workers().length).toBe(0);
});

test('a queued history reset belongs to its old document when the visible view is rebound',async({page})=>{
 await enter(page);await create(page,'fixture');
 const result=await page.evaluate(async()=>{
  const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/text-editor.ts')!;
  const {textEditor}=await import(url) as typeof import('../../src/text-editor');
  const make=(id:string):import('../../src/text-editor').TextEditorDocument=>({id,path:null,name:id+'.txt',text:'',length:0,version:'',encoding:'utf8',eol:'lf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'plain',tabSize:4,indentWithTabs:false,wrap:false});
  const a=make('A'),b=make('B'),callbacks=(doc:typeof a)=>({onEdit:(text:string)=>{doc.text=text;doc.length=text.length;doc.revision++;}});
  const host=document.createElement('div');document.body.append(host);const editor=textEditor(host,b,callbacks(b));
  try{
   editor.view.dispatch({changes:{from:0,insert:'kept B undo'}});editor.rebind(a,callbacks(a));
   for(let i=0;i<200;i++)editor.view.dispatch({changes:{from:i,insert:'x'}});
   editor.rebind(b,callbacks(b));await Promise.resolve();const bUndo=editor.command('undo'),bBody=editor.getText();
   editor.rebind(a,callbacks(a));return {bUndo,bBody,aBody:editor.getText(),aUndo:editor.command('undo')};
  }finally{editor.destroy();host.remove();}
 });
 expect(result).toEqual({bUndo:true,bBody:'',aBody:'x'.repeat(200),aUndo:false});
});

test('tab replacement reuses one visible editor and reopening search reuses its form with fresh scope',async({page})=>{
 await enter(page);await create(page,'first body');
 const view=await page.locator('.text-pane.active .cm-editor').elementHandle();
 await create(page,'second body');expect(await view!.evaluate(el=>el.isConnected)).toBe(true);
 await page.getByRole('tab',{name:/未命名 1$/}).click();await expect(page.locator('.text-pane.active .cm-content')).toHaveText('first body');
 expect(await view!.evaluate(el=>el.isConnected)).toBe(true);await view!.dispose();
 await page.getByRole('button',{name:'替换',exact:true}).click();const form=await page.locator('.text-search-main').elementHandle();
 await page.getByLabel('查找内容',{exact:true}).fill('first');await page.getByRole('checkbox',{name:'正则表达式',exact:true}).check();await page.getByLabel('替换内容',{exact:true}).fill('changed');
 await expect(page.locator('.text-search-result')).toHaveText('1 处匹配');await page.getByRole('button',{name:'关闭查找',exact:true}).click();
 await page.getByRole('tab',{name:/未命名 2$/}).click();await page.getByRole('button',{name:'查找',exact:true}).click();
 expect(await form!.evaluate(el=>el.isConnected)).toBe(true);await form!.dispose();
 await expect(page.getByRole('checkbox',{name:'正则表达式',exact:true})).not.toBeChecked();await expect(page.getByRole('checkbox',{name:'仅选区',exact:true})).toBeDisabled();
 await expect(page.locator('.text-replace-row')).toBeHidden();await expect(page.locator('.text-search-result')).toHaveText('0 处匹配');
 await page.getByRole('button',{name:'展开替换',exact:true}).click();await expect(page.getByLabel('替换内容',{exact:true})).toHaveValue('');
});

test('a reused view restores each document scroll after switching between long and short bodies',async({page})=>{
 await enter(page);await create(page,Array.from({length:1000},(_,i)=>'line '+i).join('\n'));
 const scroll=page.locator('.text-pane.active .cm-scroller');
 await scroll.evaluate(element=>element.scrollTop=1800);await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBe(1800);
 const view=await page.locator('.text-pane.active .cm-editor').elementHandle();
 try{
  await create(page,'short body');await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBe(0);
  for(let i=0;i<3;i++){
   await page.getByRole('tab',{name:/未命名 1$/}).click();await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBe(1800);
   await page.getByRole('tab',{name:/未命名 2$/}).click();await expect.poll(()=>scroll.evaluate(element=>element.scrollTop)).toBe(0);
  }
  expect(await view!.evaluate(element=>element.isConnected)).toBe(true);
 }finally{await view!.dispose();}
});

test('a delayed language from the previous document cannot configure the reused view',async({page})=>{
 await enter(page);await create(page,'first body');await create(page,'second body');
 await page.getByRole('tab',{name:/未命名 1$/}).click();
 let release!:()=>void,requested=false;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route(/.*lang-python.*|.*lang_python.*/,async route=>{requested=true;await gate;await route.continue();});
 const view=await page.locator('.text-pane.active .cm-editor').elementHandle();
 try{
  await page.getByLabel('代码语言',{exact:true}).selectOption('python');await expect.poll(()=>requested).toBe(true);
  await page.getByRole('tab',{name:/未命名 2$/}).click();expect(await view!.evaluate(el=>el.isConnected)).toBe(true);release();
  await expect.poll(()=>page.evaluate(()=>performance.getEntriesByType('resource').some(entry=>/lang-python|lang_python/.test(entry.name)))).toBe(true);
  await expect(page.getByLabel('代码语言',{exact:true})).toHaveValue('plain');await expect(page.locator('[data-text-action="comment"]')).toBeDisabled();
  await expect(page.locator('.text-pane.active .cm-content')).toHaveText('second body');
  await page.getByRole('tab',{name:/未命名 1$/}).click();await expect(page.getByLabel('代码语言',{exact:true})).toHaveValue('python');await expect(page.locator('[data-text-action="comment"]')).toBeEnabled();
  await expect(page.locator('.text-pane.active .cm-content')).toHaveText('first body');
 }finally{release();await view!.dispose();await page.unrouteAll({behavior:'wait'});}
});

test('a paused language load stays detached until resume and clean external changes replace a parked view',async({page})=>{
 await enter(page);await create(page,'unchanged text');
 let release!:()=>void,requested=false;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route(/.*lang-python.*|.*lang_python.*/,async route=>{requested=true;await gate;await route.continue();});
 try{
  await page.getByLabel('代码语言',{exact:true}).selectOption('python');await expect.poll(()=>requested).toBe(true);
  await page.evaluate(async()=>{
   const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/text-workspace.ts')!;
   const {TextWorkspace}=await import(url) as typeof import('../../src/text-workspace');
   const show=TextWorkspace.prototype.show;
   Object.assign(window,{__resumeText:()=>{TextWorkspace.prototype.show=show;}});
   // Observe the real demo hide boundary before its normal restoration resumes it.
   TextWorkspace.prototype.show=async function(){Object.assign(window,{__parkedText:this});};
  });
  await page.locator('#hide').click();await expect(page.locator('#text-workspace')).toBeHidden();
  await expect(page.locator('#text-workspace .cm-content')).toHaveAttribute('contenteditable','false');release();
  await expect.poll(()=>page.evaluate(()=>performance.getEntriesByType('resource').some(entry=>/lang-python|lang_python/.test(entry.name)))).toBe(true);
  await expect(page.locator('#text-workspace .cm-content')).toHaveAttribute('contenteditable','false');
  await page.evaluate(async()=>{const state=window as unknown as Window&{__resumeText:()=>void;__parkedText:import('../../src/text-workspace').TextWorkspace};state.__resumeText();await state.__parkedText.show();});
  await expect(page.locator('.text-pane.active .cm-content')).toBeFocused();await expect(page.locator('[data-text-action="comment"]')).toBeEnabled();
 }finally{release();await page.evaluate(()=>{(window as Window&{__resumeText?:()=>void}).__resumeText?.();});await page.unrouteAll({behavior:'wait'});}
 // The original file changed while the window was parked: refresh must run before reuse.
 await page.getByRole('button',{name:'打开文本文件',exact:true}).click();await expect(page.getByRole('tab',{name:/readme.txt$/})).toBeVisible();
 await page.getByRole('tab',{name:/readme.txt$/}).click();const original=await page.locator('.text-pane.active .cm-editor').elementHandle();
 await page.evaluate(()=>{const key='shiye-demo-text-files-v1',files=JSON.parse(localStorage.getItem(key)||'[]');const record={id:'demo-readme',path:'示例/readme.txt',name:'readme.txt',text:'external replacement body',version:'2',size:25,encoding:'utf8',eol:'lf',readonly:false};const other=files.filter((file:{id:string})=>file.id!==record.id);localStorage.setItem(key,JSON.stringify([...other,record]));});
 await page.locator('#hide').click();await expect(page.locator('.text-pane.active .cm-content')).toHaveText('external replacement body');
 expect(await original!.evaluate(element=>element.isConnected)).toBe(false);await original!.dispose();
});

test('short hide keeps static styles without stylesheet rewrites while parsers and input stay paused',async({page})=>{
 await enter(page);await create(page,'fixture');
 const result=await page.evaluate(async()=>{
  const resource=(suffix:string)=>performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname.endsWith(suffix))!;
  const {textEditor}=await import(resource('/src/text-editor.ts')) as typeof import('../../src/text-editor');
  const {language,syntaxParserRunning}=await import(resource('/@codemirror_language.js')) as typeof import('@codemirror/language');
  const bodies=['plain fixture','{"fixture":"value"}'],hosts=bodies.map(()=>{const host=document.createElement('div');document.body.append(host);return host;});
  const editors=hosts.map((host,index)=>{
   const doc:import('../../src/text-editor').TextEditorDocument={id:'style-fixture-'+index,path:null,name:index?'fixture.json':'fixture.txt',text:bodies[index],length:bodies[index].length,version:'',encoding:'utf8',eol:'lf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:index?'json':'plain',tabSize:4,indentWithTabs:false,wrap:false};
   return textEditor(host,doc,{onEdit:text=>{doc.text=text;doc.length=text.length;doc.revision++;}});
  });
  let styleWrites=0,pausedSafe=true;const observer=new MutationObserver(records=>{styleWrites+=records.filter(record=>record.target instanceof HTMLStyleElement).length;});
  try{
   await editors[1].setLanguage('json');const styles=()=>Array.from(document.head.querySelectorAll('style'),node=>node.textContent);
   const before=styles();observer.observe(document.head,{childList:true,subtree:true});
   for(let index=0;index<100;index++){
    for(const editor of editors){editor.pause();editor.view.dispatch({changes:{from:0,insert:'hidden'}});pausedSafe&&=editor.view.contentDOM.contentEditable==='false'&&editor.view.state.facet(language)===null&&!syntaxParserRunning(editor.view);}
    // 每轮等待异步语言配置完成，避免靠取消尚未加载的语言缩短循环。
    for(const editor of editors)editor.resume();await editors[1].setLanguage('json');
   }
   await Promise.resolve();return {styleWrites,stylesUnchanged:JSON.stringify(before)===JSON.stringify(styles()),pausedSafe,bodies:editors.map(editor=>editor.getText()),resumedEditable:editors.every(editor=>editor.view.contentDOM.contentEditable==='true'),fold:editors[1].getCapabilities().fold};
  }finally{observer.disconnect();editors.forEach(editor=>editor.destroy());hosts.forEach(host=>host.remove());}
 });
 expect(result).toEqual({styleWrites:0,stylesUnchanged:true,pausedSafe:true,bodies:['plain fixture','{"fixture":"value"}'],resumedEditable:true,fold:true});
});
