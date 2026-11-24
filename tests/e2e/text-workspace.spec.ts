import {expect,test,type Locator,type Page} from '@playwright/test';
import type {TextFile,TextRecord} from '../../src/text-types';
// These are the browser repository's separate example file, manifest and blob stores.
const manifestKey='shiye-demo-text-session-v1',filesKey='shiye-demo-text-files-v1';
type Manifest={documents:(TextRecord&{blob:string})[];views:string[];active:number};
const source=(editor:Locator)=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
const editor=(page:Page)=>page.locator('#text-workspace .cm-content').first();
async function enter(page:Page){await page.locator('#nav-text').click();await expect(page.locator('#text-workspace')).toBeVisible();}
async function create(page:Page,text:string){await page.locator('#text-workspace [data-text-action="new"]').first().click();const content=editor(page);await expect(content).toBeVisible();if(text)await content.fill(text);return content;}
async function manifest(page:Page):Promise<Manifest|null>{return page.evaluate(key=>{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null;},manifestKey);}
async function files(page:Page):Promise<TextFile[]|null>{return page.evaluate(key=>{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):null;},filesKey);}
async function draft(page:Page,id?:string):Promise<string|null>{return page.evaluate(({key,id})=>{const raw=localStorage.getItem(key);if(!raw)return null;const value=JSON.parse(raw),record=id?value.documents.find((item:{id:string})=>item.id===id):value.documents[0];return record?localStorage.getItem(record.blob):null;},{key:manifestKey,id});}
async function chooseClose(page:Page,choice:'保存'|'不保存'|'取消'){const title=await page.getByRole('dialog').getAttribute('aria-label'),dialog=page.getByRole('dialog',{name:title!,exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:choice,exact:true}).click();await expect(dialog).toHaveCount(0);}
async function more(page:Page,action:string){await page.getByLabel('更多文本操作',{exact:true}).click();await page.locator('#text-workspace [data-text-action="'+action+'"]').click();}

test('manual save and local draft checkpoint have distinct persisted versions and statuses',async({page})=>{
 await page.goto('/?empty');await enter(page);const content=await create(page,'manual version');
 await expect(page.locator('.text-document-state')).toHaveText('未保存到原文件 · 已暂存本机');expect(await files(page)).toBeNull();expect(await draft(page)).toBe('manual version');
 const record=(await manifest(page))!.documents[0];expect(record.path).toBeNull();expect(record.revision).toBeGreaterThan(record.savedRevision);
 await content.press('Control+s');await expect(page.locator('.text-document-state')).toHaveText('已保存到示例数据');
 const saved=(await files(page))!.find(file=>file.id===record.id)!;expect(saved.path).toMatch(/另存文本 1\.txt$/);expect(saved.text).toBe('manual version');
 await editor(page).press('Control+End');await page.keyboard.insertText(' with newer draft');await expect(page.locator('.text-document-state')).toHaveText('未保存到原文件 · 已暂存本机');
 expect((await files(page))!.find(file=>file.id===record.id)!.text).toBe('manual version');expect(await draft(page,record.id)).toBe('manual version with newer draft');
});

test('cancel keeps a dirty tab and discard removes its recovery reference across reload',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'keep until discard');await expect.poll(()=>draft(page)).toBe('keep until discard');
 const id=(await manifest(page))!.documents[0].id;await page.getByRole('button',{name:'关闭 未命名 1',exact:true}).click();await chooseClose(page,'取消');
 await expect(page.getByRole('tab',{name:/未命名 1$/})).toBeVisible();expect(await source(editor(page))).toBe('keep until discard');
 await page.getByRole('button',{name:'关闭 未命名 1',exact:true}).click();await chooseClose(page,'不保存');await expect(page.getByRole('tab')).toHaveCount(0);
 expect((await manifest(page))!.documents.some(record=>record.id===id)).toBe(false);await page.reload();await enter(page);await expect(page.getByRole('tab')).toHaveCount(0);await expect(page.locator('.text-empty')).toBeVisible();
});

test('save while closing persists the file and completes the close without reviving its draft',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'save through close');await page.getByRole('button',{name:'关闭 未命名 1',exact:true}).click();await chooseClose(page,'保存');
 await expect(page.getByRole('tab')).toHaveCount(0);expect((await files(page))!.some(file=>file.text==='save through close')).toBe(true);expect((await manifest(page))!.documents).toHaveLength(0);
 await page.reload();await enter(page);await expect(page.getByRole('tab')).toHaveCount(0);
});

test('close others processes tabs in order and cancellation keeps the unprocessed tabs',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'first draft');await create(page,'second draft');await create(page,'active draft');
 await more(page,'close-others');await expect(page.getByRole('dialog')).toHaveAccessibleName('关闭 未命名 1');await chooseClose(page,'不保存');
 await expect(page.getByRole('dialog')).toHaveAccessibleName('关闭 未命名 2');await chooseClose(page,'取消');await expect(page.getByRole('tab')).toHaveCount(2);
 await expect(page.getByRole('tab',{name:/未命名 1$/})).toHaveCount(0);await expect(page.getByRole('tab',{name:/未命名 2$/})).toBeVisible();await expect(page.getByRole('tab',{name:/未命名 3$/})).toHaveAttribute('aria-selected','true');
 expect(await source(editor(page))).toBe('active draft');await page.getByRole('tab',{name:/未命名 2$/}).click();expect(await source(editor(page))).toBe('second draft');
});

test('the thirteenth tab is rejected without replacing any existing buffer',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'first preserved draft');for(let count=2;count<=12;count++)await create(page,count===12?'twelfth preserved draft':'');
 await expect(page.getByRole('tab')).toHaveCount(12);await page.locator('#text-workspace [data-text-action="new"]').first().click();await expect(page.locator('#toast')).toContainText('12');
 await expect(page.getByRole('tab')).toHaveCount(12);expect(await source(editor(page))).toBe('twelfth preserved draft');await page.getByRole('tab',{name:/未命名 1$/}).click();expect(await source(editor(page))).toBe('first preserved draft');
});

test('module switches and demo hide checkpoint the latest drafts and reload restores both views',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'left draft before switching');await page.locator('#nav-notes').click();await expect(page.locator('#text-workspace')).toBeHidden();
 expect(await draft(page)).toBe('left draft before switching');await enter(page);expect(await source(editor(page))).toBe('left draft before switching');
 await create(page,'right draft before hiding');await page.getByRole('button',{name:'双视图',exact:true}).click();await expect(page.locator('.text-pane')).toHaveCount(2);
 await page.getByRole('button',{name:'隐藏工作台',exact:true}).click();await expect(page.locator('#toast')).toContainText('桌面版会隐藏');await expect(page.locator('.text-pane')).toHaveCount(2);
 const snapshot=(await manifest(page))!;expect(snapshot.documents).toHaveLength(2);expect(snapshot.views).toHaveLength(2);expect(await files(page)).toBeNull();
 await page.reload();await expect(page.locator('#text-workspace')).toBeVisible();await expect(page.locator('.text-pane')).toHaveCount(2);const bodies=await page.locator('.text-pane .cm-content').allTextContents();
 expect(bodies).toEqual(expect.arrayContaining(['left draft before switching','right draft before hiding']));await expect(page.getByRole('tab')).toHaveCount(2);
});

test('editing a selected range survives changes to its neighboring view without losing focus or replacing tabs',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'左侧 选区保留 末尾');await create(page,'第二份正文');await create(page,'第三份正文');
 await page.getByRole('button',{name:'双视图',exact:true}).click();await expect(page.locator('.text-pane')).toHaveCount(2);
 const left=page.getByRole('region',{name:'未命名 1 文本窗格',exact:true}),leftContent=left.locator('.cm-content');
 const tabs=[1,2,3].map(number=>page.getByRole('tab',{name:new RegExp('未命名 '+number+'$')}));
 const tabNodes=await Promise.all(tabs.map(tab=>tab.elementHandle())),leftNode=await left.locator('.cm-editor').elementHandle();
 try{
  await leftContent.click();await leftContent.press('Control+Home');for(let step=0;step<3;step++)await page.keyboard.press('ArrowRight');for(let step=0;step<4;step++)await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe('选区保留');
  // Switch only the neighboring pane. Focus follows the chosen document; the left selection must return intact.
  await page.getByRole('region',{name:'未命名 3 文本窗格',exact:true}).locator('.cm-content').click();await tabs[1].click();
  await expect(page.locator('.text-pane.active .cm-content')).toHaveText('第二份正文');await expect(page.locator('.text-pane.active .cm-content')).toBeFocused();
  expect(await left.locator('.cm-editor').evaluate((element,node)=>element===node,leftNode)).toBe(true);
  await tabs[2].click();const neighbor=page.getByRole('region',{name:'未命名 3 文本窗格',exact:true}),neighborNode=await neighbor.locator('.cm-editor').elementHandle();
  try{
   await expect(neighbor.locator('.cm-content')).toBeFocused();await more(page,'move-left');
   await expect(page.getByRole('tab')).toHaveText(['未命名 1','未命名 3','未命名 2']);
   expect(await neighbor.locator('.cm-editor').evaluate((element,node)=>element===node,neighborNode)).toBe(true);
  }finally{await neighborNode?.dispose();}
  expect(await left.locator('.cm-editor').evaluate((element,node)=>element===node,leftNode)).toBe(true);
  await tabs[0].click();await expect(leftContent).toBeFocused();await expect(left).toHaveClass(/active/);await expect(page.locator('.text-pane.active')).toHaveCount(1);
  await expect.poll(()=>page.evaluate(()=>window.getSelection()?.toString())).toBe('选区保留');
  await page.keyboard.insertText('已替换');await expect(leftContent).toBeFocused();expect(await source(leftContent)).toBe('左侧 已替换 末尾');
  for(const [index,tab] of tabs.entries())expect(await tab.evaluate((element,node)=>element===node,tabNodes[index])).toBe(true);
  await expect(page.locator('.text-document-state')).toHaveText('未保存到原文件 · 已暂存本机');
  await expect(leftContent).toBeFocused();for(const [index,tab] of tabs.entries())expect(await tab.evaluate((element,node)=>element===node,tabNodes[index])).toBe(true);
  const snapshot=(await manifest(page))!,byName=(name:string)=>snapshot.documents.find(doc=>doc.name===name)!;
  expect(snapshot.views).toEqual([byName('未命名 3').id,byName('未命名 1').id]);expect(snapshot.active).toBe(1);
  expect(await draft(page,byName('未命名 1').id)).toBe('左侧 已替换 末尾');expect(await draft(page,byName('未命名 2').id)).toBe('第二份正文');expect(await draft(page,byName('未命名 3').id)).toBe('第三份正文');
 }finally{await leftNode?.dispose();for(const node of tabNodes)await node?.dispose();}
});

test('an older notes-only configuration keeps its notes and offers an independent empty text workspace',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('shiye-demo-settings',JSON.stringify({root:'演示笔记',shortcut:'Control+Alt+Space',floating:true,floatX:40,floatY:180,session:{module:'notes',panes:[{path:'欢迎使用拾页.md',mode:'preview',cursor:0,scroll:0}],expanded:[]}})));
 await page.goto('/');await expect(page.getByRole('heading',{name:'给思绪一个落脚点'})).toBeVisible();await enter(page);await expect(page.getByRole('tab')).toHaveCount(0);await expect(page.locator('.text-empty')).toBeVisible();
 const content=await create(page,'independent workspace');await content.press('Control+s');await expect(page.locator('.text-document-state')).toHaveText('已保存到示例数据');await page.locator('#nav-notes').click();await expect(page.getByRole('heading',{name:'给思绪一个落脚点'})).toBeVisible();
});

test('corrupt text recovery stays untouched while notes and clipboard remain available',async({page})=>{
 const corrupt='{broken text manifest';await page.addInitScript(({key,corrupt})=>localStorage.setItem(key,corrupt),{key:manifestKey,corrupt});
 await page.goto('/');await expect(page.getByRole('heading',{name:'给思绪一个落脚点'})).toBeVisible();await page.locator('#nav-clipboard').click();await expect(page.getByRole('heading',{name:'当前剪贴板'})).toBeVisible();await expect(page.locator('#clip-text')).toContainText('浏览器预览仅展示此示例');
 await page.locator('#nav-notes').click();await expect(page.getByRole('heading',{name:'给思绪一个落脚点'})).toBeVisible();await enter(page);await expect(page.locator('.text-global-error')).toContainText('恢复');
 const createButton=page.locator('#text-workspace [data-text-action="new"]').first();await expect(createButton).toBeDisabled();expect(await page.evaluate(key=>localStorage.getItem(key),manifestKey)).toBe(corrupt);
 await page.locator('#nav-clipboard').click();await expect(page.getByRole('heading',{name:'当前剪贴板'})).toBeVisible();expect(await page.evaluate(key=>localStorage.getItem(key),manifestKey)).toBe(corrupt);
});

test('a damaged lazy recovery body keeps the app shell and original recovery records available',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'valuable local draft');
 await expect(page.locator('.text-document-state')).toContainText('已暂存本机');
 const original=await page.evaluate(key=>localStorage.getItem(key),manifestKey);
 const damaged=await page.evaluate(key=>{const value=JSON.parse(localStorage.getItem(key)!);const blob=value.documents[0].blob;localStorage.setItem(blob,'damaged body');return blob;},manifestKey);
 await page.reload();await expect(page.locator('#nav-text')).toBeVisible();await enter(page);
 await expect(page.getByRole('heading',{name:'文本草稿尚未完整恢复'})).toBeVisible();await expect(page.locator('.text-global-error')).toContainText('正文');await expect(page.locator('.text-pane .cm-editor')).toHaveCount(0);
 await page.locator('#nav-clipboard').click();await expect(page.getByRole('heading',{name:'当前剪贴板'})).toBeVisible();await page.locator('#nav-notes').click();await expect(page.locator('#nav-notes')).toHaveClass(/selected/);
 expect(await page.evaluate(key=>localStorage.getItem(key),manifestKey)).toBe(original);expect(await page.evaluate(key=>localStorage.getItem(key),damaged)).toBe('damaged body');
});

test('saving from the editor keeps keyboard focus and accepts the next character in the same document',async({page})=>{
 await page.goto('/?empty');await enter(page);const content=await create(page,'saved prefix');await content.press('Control+End');await content.press('Control+s');await expect(page.locator('.text-document-state')).toHaveText('已保存到示例数据');
 await expect(editor(page)).toBeFocused();await page.keyboard.insertText(' continued');expect(await source(editor(page))).toBe('saved prefix continued');await expect(page.locator('.text-document-state')).toContainText('未保存到原文件');expect((await files(page))!.some(file=>file.text==='saved prefix')).toBe(true);
});

test('closing mixed line endings keeps edits produced while the confirmed save was in flight',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'before save');await expect(page.locator('.text-document-state')).toContainText('已暂存本机');
 await page.evaluate(key=>{const value=JSON.parse(localStorage.getItem(key)!);value.documents[0].eol='mixed';localStorage.setItem(key,JSON.stringify(value));},manifestKey);await page.reload();await enter(page);
 await page.evaluate(async()=>{const modulePath=performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>new URL(name).pathname==='/src/text-model.ts').at(-1)!;const {TextWorkbench}=await import(modulePath) as typeof import('../../src/text-model');const original=TextWorkbench.prototype.save;TextWorkbench.prototype.save=async function(this:import('../../src/text-model').TextWorkbench,doc=this.current(),as=false){const saved=await original.call(this,doc,as);const gate=window as Window&{__textSaved?:boolean;__textRelease?:()=>void};gate.__textSaved=true;await new Promise<void>(resolve=>{gate.__textRelease=resolve;});return saved;};});
 await page.locator('.text-tab-close').click();await chooseClose(page,'保存');await page.getByRole('button',{name:'统一为 LF',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as Window&{__textSaved?:boolean}).__textSaved)).toBe(true);await editor(page).focus();await editor(page).press('Control+End');await page.keyboard.insertText(' newer input');await page.evaluate(()=>(window as Window&{__textRelease?:()=>void}).__textRelease?.());
 await expect(page.getByRole('tab')).toHaveCount(1);expect(await source(editor(page))).toBe('before save newer input');await expect(page.locator('.text-document-state')).toContainText('未保存到原文件');expect((await files(page))!.some(file=>file.text==='before save')).toBe(true);
});

test('search selection belongs to its document when switching tabs',async({page})=>{
 await page.goto('/?empty');await enter(page);const first=await create(page,'alpha alpha');await first.press('Control+Home');await first.press('Shift+ArrowRight');await first.press('Shift+ArrowRight');await first.press('Shift+ArrowRight');
 await first.press('Control+f');await expect(page.locator('.text-search [name="scope"]')).toBeEnabled();await page.locator('.text-search [name="scope"]').check();
 await page.getByRole('button',{name:'新建文本',exact:true}).click();await expect(page.locator('.text-search [name="scope"]')).toBeDisabled();await expect(page.locator('.text-search [name="scope"]')).not.toBeChecked();
});

test('identical tab preferences reuse controls while changes apply only to the active document',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'first body');
 const language=page.getByLabel('代码语言',{exact:true}),original=await language.elementHandle();
 await create(page,'second body');expect(await language.evaluate((element,previous)=>element===previous,original)).toBe(true);
 await language.selectOption('json');await page.getByRole('tab',{name:/未命名 1$/}).click();await expect(language).toHaveValue('plain');expect(await source(editor(page))).toBe('first body');
 await page.getByLabel('文本编码',{exact:true}).selectOption('utf16be');
 await page.getByRole('tab',{name:/未命名 2$/}).click();await expect(language).toHaveValue('json');await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf8');expect(await source(editor(page))).toBe('second body');
 await expect.poll(async()=>{const value=await manifest(page);return value?.documents.map(doc=>[doc.language,doc.encoding]);}).toEqual([['plain','utf16be'],['json','utf8']]);
});

test('startup keeps the shell inert until delayed text metadata and visible bodies finish restoring',async({page})=>{
 await page.goto('/?empty');await enter(page);await create(page,'existing draft before startup');await expect.poll(()=>draft(page)).toBe('existing draft before startup');
 await page.addInitScript(()=>{Object.assign(window,{__textStartupGate:{restoreReached:false,recoverReached:false,releaseRestore:null,releaseRecover:null}});});
 await page.route('**/src/text-demo.ts*',async route=>{
  const response=await route.fetch(),original=await response.text();
  const restorePattern=/async restore\(\)\s*\{/,recoverPattern=/async recover\(id\)\s*\{/;
  expect(original).toMatch(restorePattern);expect(original).toMatch(recoverPattern);
  const body=original.replace(restorePattern,match=>match+' window.__textStartupGate.restoreReached=true; await new Promise(resolve=>{window.__textStartupGate.releaseRestore=resolve;});').replace(recoverPattern,match=>match+' window.__textStartupGate.recoverReached=true; await new Promise(resolve=>{window.__textStartupGate.releaseRecover=resolve;});');
  await route.fulfill({response,body});
 });
 await page.reload();await expect.poll(()=>page.evaluate(()=>(window as Window&{__textStartupGate?:{restoreReached:boolean}}).__textStartupGate?.restoreReached)).toBe(true);
 const app=page.locator('#app');await expect(app).toHaveJSProperty('inert',true);
 const nav=await page.locator('#nav-text').boundingBox();expect(nav).not.toBeNull();await page.mouse.click(nav!.x+nav!.width/2,nav!.y+nav!.height/2);await page.keyboard.press('Control+n');await expect(page.locator('#text-workspace .cm-content')).toHaveCount(0);
 await page.evaluate(()=>(window as Window&{__textStartupGate?:{releaseRestore:()=>void}}).__textStartupGate?.releaseRestore());
 await expect.poll(()=>page.evaluate(()=>(window as Window&{__textStartupGate?:{recoverReached:boolean}}).__textStartupGate?.recoverReached)).toBe(true);await expect(app).toHaveJSProperty('inert',true);
 await page.keyboard.press('Control+n');await expect(page.locator('#text-workspace .cm-content')).toHaveCount(0);
 await page.evaluate(()=>(window as Window&{__textStartupGate?:{releaseRecover:()=>void}}).__textStartupGate?.releaseRecover());
 await expect(app).toHaveJSProperty('inert',false);await expect(editor(page)).toBeVisible();await expect(editor(page)).toBeFocused();expect(await source(editor(page))).toBe('existing draft before startup');
 await create(page,'new draft after startup');await expect(page.getByRole('tab')).toHaveCount(2);await page.getByRole('tab',{name:/未命名 1$/}).click();expect(await source(editor(page))).toBe('existing draft before startup');
 await editor(page).fill('existing draft edited after startup');await page.getByRole('tab',{name:/未命名 2$/}).click();expect(await source(editor(page))).toBe('new draft after startup');
 await expect.poll(async()=>{const value=await manifest(page);return value?.documents.length;}).toBe(2);
});
