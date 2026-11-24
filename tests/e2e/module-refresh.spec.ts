import {expect,test,type Page} from '@playwright/test';

async function instrumentRefresh(page:Page){
 await page.evaluate(async()=>{
  const url=(path:string)=>performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname===path)!;
  const {Workbench}=await import(url('/src/model.ts')) as typeof import('../../src/model');
  const {TextWorkbench}=await import(url('/src/text-model.ts')) as typeof import('../../src/text-model');
  const counters={notes:0,text:0};Object.assign(window,{__moduleRefresh:counters});
  const notes=Workbench.prototype.refresh,text=TextWorkbench.prototype.refresh;
  Workbench.prototype.refresh=async function(){counters.notes++;return notes.call(this);};
  TextWorkbench.prototype.refresh=async function(){counters.text++;return text.call(this);};
 });
}
const counters=(page:Page)=>page.evaluate(()=>(window as Window&{__moduleRefresh?:{notes:number;text:number}}).__moduleRefresh!);
async function focus(page:Page){
 const before=await counters(page);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect.poll(async()=>{const now=await counters(page);return now.notes+now.text;}).toBeGreaterThan(before.notes+before.text);
}

test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{
  localStorage.setItem('shiye-demo-files',JSON.stringify({'A.md':'# Original note\n'}));localStorage.setItem('shiye-demo-folders','[]');
  localStorage.setItem('shiye-demo-settings',JSON.stringify({root:'演示笔记',shortcut:'Control+Alt+Space',floating:true,session:{module:'notes',panes:[{path:'A.md',mode:'preview',cursor:0,scroll:0}],expanded:[]}}));
  localStorage.setItem('shiye-demo-text-files-v1',JSON.stringify([{id:'demo-readme',path:'示例/readme.txt',name:'readme.txt',text:'Original text',version:'1',size:13,encoding:'utf8',eol:'lf',readonly:false}]));
 });
 await page.goto('/');await expect(page.getByRole('heading',{name:'Original note',exact:true})).toBeVisible();await instrumentRefresh(page);
});

test('focus reads only the active module and returning to notes reloads external changes',async({page})=>{
 await page.locator('#nav-text').click();await expect(page.locator('#text-workspace')).toBeVisible();
 const before=await counters(page);await focus(page);const after=await counters(page);expect(after.notes).toBe(before.notes);expect(after.text).toBeGreaterThan(before.text);
 await page.evaluate(()=>localStorage.setItem('shiye-demo-files',JSON.stringify({'A.md':'# External note\n'})));
 await focus(page);expect((await counters(page)).notes).toBe(before.notes);
 await page.locator('#nav-notes').click();await expect(page.getByRole('heading',{name:'External note',exact:true})).toBeVisible();expect((await counters(page)).notes).toBeGreaterThan(before.notes);
 const active=await counters(page);await page.locator('#refresh').click();await expect.poll(async()=>(await counters(page)).notes).toBeGreaterThan(active.notes);expect((await counters(page)).text).toBe(active.text);
});

test('inactive text is not probed on note focus and is revalidated before its editor is shown again',async({page})=>{
 await page.locator('#nav-text').click();await page.getByRole('button',{name:'打开文本文件',exact:true}).click();await expect(page.locator('#text-workspace .cm-content')).toHaveText('Original text');
 await page.locator('#nav-notes').click();await expect(page.getByRole('heading',{name:'Original note',exact:true})).toBeVisible();
 const before=await counters(page);await focus(page);expect((await counters(page)).text).toBe(before.text);
 await page.evaluate(()=>{const key='shiye-demo-text-files-v1',files=JSON.parse(localStorage.getItem(key)!);files[0].text='External text';files[0].version='2';localStorage.setItem(key,JSON.stringify(files));});
 await page.locator('#nav-text').click();await expect(page.locator('#text-workspace .cm-content')).toHaveText('External text');expect((await counters(page)).text).toBeGreaterThan(before.text);
});
