import {test,expect,type Page,type Locator} from '@playwright/test';

const initialFiles:Record<string,string>={
 'A.md':'# 笔记 A\n\n[打开 B](B.md)\n\n保留原有相对链接。',
 'B.md':'# 笔记 B\n\n第二个窗格。',
 'C.md':'# 笔记 C\n\n中文与空行\n\n保持原样。',
 '入口.md':'# 笔记排序与移动',
 '项目/M.md':'# 项目 M\n\n不改写内容。',
 '项目/N.md':'# 项目 N',
 '归档/X.md':'# 归档 X',
};
const initialFolders=['Alpha','Beta','归档','归档/子文件夹','项目'];
const row=(page:Page,path:string)=>page.locator('.tree-row[data-path="'+path+'"]');
const files=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-files')!) as Record<string,string>);
const treePaths=(page:Page,parent='')=>page.locator('.tree-row').evaluateAll((nodes,parent)=>nodes.map(node=>(node as HTMLElement).dataset.path!).filter(path=>path.slice(0,path.lastIndexOf('/')+1)===(parent?parent+'/':'')),parent);
const source=(editor:Locator)=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));

test.beforeEach(async({page})=>{
 await page.addInitScript(({notes,folders})=>{
  if(localStorage.getItem('notes-moves-e2e-seeded'))return;localStorage.clear();localStorage.setItem('notes-moves-e2e-seeded','true');
  localStorage.setItem('shiye-demo-files',JSON.stringify(notes));localStorage.setItem('shiye-demo-folders',JSON.stringify(folders));
  localStorage.setItem('shiye-demo-settings',JSON.stringify({root:'演示笔记',session:{module:'notes',panes:[{path:'A.md',mode:'preview',cursor:0,scroll:0}],expanded:['归档','项目']}}));
 },{notes:initialFiles,folders:initialFolders});
 await page.goto('/');await expect(page.locator('.note-pane')).toHaveCount(1);await expect(row(page,'项目/M.md')).toBeVisible();
});

async function startDrag(page:Page,path:string){
 await expect.poll(()=>page.locator('#app').evaluate(element=>(element as HTMLElement).inert)).toBe(false);
 await row(page,path).hover();const bounds=await row(page,path).boundingBox();expect(bounds).not.toBeNull();
 await page.mouse.move(bounds!.x+80,bounds!.y+bounds!.height/2);await page.mouse.down();await page.mouse.move(bounds!.x+92,bounds!.y+bounds!.height/2,{steps:3});
}
async function pointAt(page:Page,path:string,position:'before'|'after'|'inside'){
 const target=path?row(page,path):page.locator('#workspace-name'),bounds=await target.boundingBox();expect(bounds).not.toBeNull();
 await page.mouse.move(bounds!.x+90,bounds!.y+(position==='before'?3:position==='after'?bounds!.height-3:bounds!.height/2),{steps:8});return target;
}
async function drag(page:Page,from:string,to:string,position:'before'|'after'|'inside'){
 await startDrag(page,from);await pointAt(page,to,position);await page.mouse.up();
}
async function confirmMove(page:Page,from:string,to:string){
 const dialog=page.locator('dialog:not(.folder-destination)');await expect(dialog).toBeVisible();await expect(dialog.getByRole('heading',{name:'移动笔记',exact:true})).toBeVisible();
 await expect(dialog).toContainText(from);await expect(dialog).toContainText(to);await expect(dialog).toContainText('相对链接');await expect(dialog).toContainText('图片');
 await dialog.getByRole('button',{name:'移动笔记',exact:true}).click();await expect(dialog).toHaveCount(0);
}
async function menu(page:Page,path:string){await row(page,path).click({button:'right'});return page.locator('.context-menu');}
async function menuAction(page:Page,path:string,label:string){await (await menu(page,path)).getByRole('button',{name:label,exact:true}).click();}
async function failStorage(page:Page,mode:'order'|'snapshot'){
 await page.evaluate(mode=>{
  const state=window as typeof window&{noteMoveStorageFailure:string};state.noteMoveStorageFailure=mode;const set=Storage.prototype.setItem;
  Storage.prototype.setItem=function(key,value){if((state.noteMoveStorageFailure==='order'&&key.startsWith('shiye-demo-folder-order:'))||(state.noteMoveStorageFailure==='snapshot'&&key==='shiye-demo-settings'))throw new DOMException('测试存储不可写','QuotaExceededError');return set.call(this,key,value);};
 },mode);
}

test('folder and note groups reorder independently and persist without changing file contents',async({page})=>{
 await drag(page,'Beta','Alpha','before');await expect.poll(()=>treePaths(page)).toEqual(['Beta','Alpha','归档','项目','A.md','B.md','C.md','入口.md']);
 await startDrag(page,'C.md');await pointAt(page,'A.md','before');await expect(row(page,'A.md')).toHaveAttribute('data-folder-drop','before');
 await page.screenshot({path:'.qa/note-drop-before.png'});await page.mouse.up();
 await expect.poll(()=>treePaths(page)).toEqual(['Beta','Alpha','归档','项目','C.md','A.md','B.md','入口.md']);await expect(page.locator('dialog')).toHaveCount(0);expect(await files(page)).toEqual(initialFiles);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-folder-order:'+encodeURIComponent('演示笔记'))!).parents[''])).toEqual(['Beta','Alpha','归档','项目','C.md','A.md','B.md','入口.md']);
 await page.locator('#refresh').click();await page.locator('#hide').click();await page.reload();
 await expect.poll(()=>treePaths(page)).toEqual(['Beta','Alpha','归档','项目','C.md','A.md','B.md','入口.md']);
});

test('note ordering menus respect group boundaries and reset both groups at the same level',async({page})=>{
 await drag(page,'Beta','Alpha','before');await drag(page,'C.md','A.md','before');
 const first=await menu(page,'C.md');await expect(first.getByRole('button',{name:'上移',exact:true})).toBeDisabled();
 await first.getByRole('button',{name:'下移',exact:true}).focus();await page.keyboard.press('Enter');
 await expect.poll(()=>treePaths(page)).toEqual(['Beta','Alpha','归档','项目','A.md','C.md','B.md','入口.md']);
 const last=await menu(page,'入口.md');await expect(last.getByRole('button',{name:'下移',exact:true})).toBeDisabled();await last.getByRole('button',{name:'恢复同级默认排序',exact:true}).click();
 await expect.poll(()=>treePaths(page)).toEqual(['Alpha','Beta','归档','项目','A.md','B.md','C.md','入口.md']);expect(await files(page)).toEqual(initialFiles);
});

test('the entire folder row accepts a note, and the workspace title moves it back to root',async({page})=>{
 await startDrag(page,'C.md');await pointAt(page,'归档','before');await expect(row(page,'归档')).toHaveAttribute('data-folder-drop','inside');
 await page.screenshot({path:'.qa/note-drop-inside.png'});await page.mouse.up();await confirmMove(page,'C.md','归档/C.md');
 await expect.poll(()=>treePaths(page,'归档')).toEqual(['归档/子文件夹','归档/X.md','归档/C.md']);expect((await files(page))['归档/C.md']).toBe(initialFiles['C.md']);expect((await files(page))['C.md']).toBeUndefined();
 await drag(page,'归档/C.md','','inside');await confirmMove(page,'归档/C.md','C.md');
 await expect.poll(()=>treePaths(page)).toEqual(['Alpha','Beta','归档','项目','A.md','B.md','入口.md','C.md']);expect(await files(page)).toEqual(initialFiles);
});

test('cross-parent note insertion uses the selected before or after position',async({page})=>{
 await drag(page,'项目/M.md','B.md','before');await confirmMove(page,'项目/M.md','M.md');
 await expect.poll(()=>treePaths(page)).toEqual(['Alpha','Beta','归档','项目','A.md','M.md','B.md','C.md','入口.md']);
 await drag(page,'C.md','项目/N.md','after');await confirmMove(page,'C.md','项目/C.md');
 await expect.poll(()=>treePaths(page,'项目')).toEqual(['项目/N.md','项目/C.md']);expect((await files(page))['M.md']).toBe(initialFiles['项目/M.md']);expect((await files(page))['项目/C.md']).toBe(initialFiles['C.md']);
});

test('the note destination picker supports keyboard selection and both cancellation stages',async({page})=>{
 await menuAction(page,'C.md','移动到…');let picker=page.locator('.folder-destination');await expect(picker.getByRole('button',{name:'移到此目录',exact:true})).toBeDisabled();
 await picker.getByRole('button',{name:'进入文件夹 归档',exact:true}).focus();await page.keyboard.press('Enter');await picker.getByRole('button',{name:'移到此目录',exact:true}).click();
 await expect(page.locator('dialog')).toContainText('归档/C.md');await page.getByRole('button',{name:'取消',exact:true}).click();expect(await files(page)).toEqual(initialFiles);
 await menuAction(page,'C.md','移动到…');await page.keyboard.press('Escape');await expect(page.locator('.folder-destination')).toHaveCount(0);expect(await files(page)).toEqual(initialFiles);
 await menuAction(page,'C.md','移动到…');picker=page.locator('.folder-destination');await picker.getByRole('button',{name:'进入文件夹 归档',exact:true}).click();await picker.getByRole('button',{name:'移到此目录',exact:true}).click();
 await confirmMove(page,'C.md','归档/C.md');await expect(row(page,'归档/C.md')).toBeVisible();
});

test('a name collision appearing during confirmation never overwrites either note',async({page})=>{
 await drag(page,'C.md','归档','inside');await expect(page.locator('dialog')).toBeVisible();
 await page.evaluate(()=>{const files=JSON.parse(localStorage.getItem('shiye-demo-files')!);files['归档/C.md']='目标必须保留';localStorage.setItem('shiye-demo-files',JSON.stringify(files));});
 await confirmMove(page,'C.md','归档/C.md');await expect(page.locator('#toast')).toContainText('同名');expect((await files(page))['C.md']).toBe(initialFiles['C.md']);expect((await files(page))['归档/C.md']).toBe('目标必须保留');
});

test('a removed note anchor is rejected before the source is moved',async({page})=>{
 await drag(page,'项目/M.md','B.md','before');await expect(page.locator('dialog')).toBeVisible();
 await page.evaluate(()=>{const files=JSON.parse(localStorage.getItem('shiye-demo-files')!);delete files['B.md'];localStorage.setItem('shiye-demo-files',JSON.stringify(files));});
 await confirmMove(page,'项目/M.md','M.md');await expect(page.locator('#toast')).toContainText(/不存在|失效|变化/);expect((await files(page))['项目/M.md']).toBe(initialFiles['项目/M.md']);expect((await files(page))['M.md']).toBeUndefined();
});

test('moving one open note preserves both panes and undo while only its own path changes',async({page})=>{
 await page.getByRole('link',{name:'打开 B',exact:true}).click();const panes=page.locator('.note-pane');await expect(panes).toHaveCount(2);
 for(let index=0;index<2;index++){const pane=panes.nth(index);await pane.getByRole('button',{name:'编辑模式',exact:true}).click();const editor=pane.locator('.cm-content');await editor.click();await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially(index?'Right marker':'Left marker');}
 await drag(page,'A.md','归档','inside');await confirmMove(page,'A.md','归档/A.md');
 await expect(panes.nth(0).locator('.note-title small')).toContainText('归档');await expect(panes.nth(1).locator('.note-title small')).toContainText('我的笔记');await expect(panes.locator('.cm-content')).toHaveCount(2);
 await page.screenshot({path:'.qa/note-moved-split.png'});
 for(let index=0;index<2;index++){const editor=panes.nth(index).locator('.cm-content'),marker=index?'Right marker':'Left marker';await editor.focus();await editor.press('Control+z');expect(await source(editor)).not.toContain(marker);await editor.press('Control+y');expect(await source(editor)).toContain(marker);await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially('After move');}
 await expect(panes.locator('.save-state')).toHaveText(['已保存到本地','已保存到本地']);const after=await files(page);
 expect(after['归档/A.md']).toContain('Left marker\nAfter move');expect(after['归档/A.md']).toContain('[打开 B](B.md)');expect(after['B.md']).toContain('Right marker\nAfter move');expect(after['A.md']).toBeUndefined();
 await page.reload();await expect(page.locator('.note-pane .cm-content')).toHaveCount(2);await expect(page.locator('.note-pane').nth(0).locator('.cm-content')).toContainText('Left marker');await expect(page.locator('.note-pane').nth(1).locator('.cm-content')).toContainText('Right marker');
});

test('a dirty note save conflict blocks movement and retains the editable buffer',async({page})=>{
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();await page.locator('.cm-content').fill('本地未保存修改');
 await page.evaluate(()=>{const files=JSON.parse(localStorage.getItem('shiye-demo-files')!);files['A.md']='外部修改';localStorage.setItem('shiye-demo-files',JSON.stringify(files));});
 await drag(page,'A.md','归档','inside');await confirmMove(page,'A.md','归档/A.md');await expect(page.locator('.save-state')).toHaveText('保存需要处理');await expect(page.locator('.cm-content')).toContainText('本地未保存修改');
 expect((await files(page))['A.md']).toBe('外部修改');expect((await files(page))['归档/A.md']).toBeUndefined();
});

test('failed pure note sorting keeps the previous order and note bytes',async({page})=>{
 await failStorage(page,'order');await drag(page,'C.md','A.md','before');await expect(page.locator('#toast')).toContainText(/未能保存|未保存/);
 expect(await treePaths(page)).toEqual(['Alpha','Beta','归档','项目','A.md','B.md','C.md','入口.md']);expect(await files(page)).toEqual(initialFiles);
});

for(const failure of ['order','snapshot'] as const)test('a note move survives '+failure+' persistence failure and metadata retry',async({page})=>{
 await failStorage(page,failure);await drag(page,'A.md','归档','inside');await confirmMove(page,'A.md','归档/A.md');
 const warning=page.locator('.folder-status');await expect(warning).toBeVisible();await expect(warning).toContainText(failure==='order'?'顺序未保存':'恢复记录未保存');await expect(page.locator('.note-title small')).toContainText('归档');
 const moved=await files(page);expect(moved['归档/A.md']).toBe(initialFiles['A.md']);expect(moved['A.md']).toBeUndefined();
 await page.evaluate(()=>{(window as typeof window&{noteMoveStorageFailure:string}).noteMoveStorageFailure='';});await warning.getByRole('button',{name:'重试保存',exact:true}).click();await expect(warning).toBeHidden();expect(await files(page)).toEqual(moved);
 await page.reload();await expect(page.locator('.note-title small')).toContainText('归档');await expect(page.locator('.article')).toContainText('保留原有相对链接');
});

test('note dragging still inserts editor links and Esc cancels a tree reorder',async({page})=>{
 await startDrag(page,'C.md');await pointAt(page,'A.md','before');await expect(row(page,'A.md')).toHaveAttribute('data-folder-drop','before');await page.keyboard.press('Escape');await page.mouse.up();await expect(page.locator('[data-folder-drop]')).toHaveCount(0);expect(await files(page)).toEqual(initialFiles);
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();const editor=page.locator('.cm-content');await editor.click();await editor.press('Control+Home');
 await row(page,'C.md').dragTo(editor,{targetPosition:{x:160,y:13}});await expect(editor.locator('.cm-line').first()).toContainText('[C](C.md)');
 expect((await files(page))['C.md']).toBe(initialFiles['C.md']);await editor.locator('.cm-line').first().getByText('C',{exact:true}).click({modifiers:['Control']});await expect(page.locator('.note-pane')).toHaveCount(2);await expect(page.locator('.note-pane').nth(1).locator('.note-title strong')).toHaveText('C');
});
