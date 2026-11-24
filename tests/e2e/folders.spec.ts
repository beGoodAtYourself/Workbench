import {test,expect,type Page,type Locator} from '@playwright/test';

const initialFiles:Record<string,string>={
 '入口.md':'# 文件夹验收\n\n[打开资料](项目/资料/A.md)\n\n[外部笔记](外部.md)',
 '外部.md':'# 外部笔记\n\n用于验证原笔记拖动。',
 '项目/资料/A.md':'# 资料 A\n\n[继续阅读](子目录/B.md)\n\n保留中文与空行。',
 '项目/资料/子目录/B.md':'# 资料 B\n\n第二个窗格的正文。',
 '项目/资料/附件.dat':'完整附件\u0000\u00ff\r\n不改写正文',
};
const initialFolders=['A','B','C','项目','项目/资料','项目/资料/子目录','归档','归档/已有'];
const orderKey='shiye-demo-folder-order:'+encodeURIComponent('演示笔记');
// These fixture paths contain no quotes or backslashes.
const folder=(page:Page,path:string)=>page.locator('.tree-row[data-path="'+path+'"]');
const visibleRootFolders=(page:Page)=>page.locator('.tree-row[aria-expanded]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.path!).filter(path=>!path.includes('/')));
const files=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-files')!) as Record<string,string>);
const storedFolders=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-folders')!) as string[]);
const savedOrder=(page:Page)=>page.evaluate(key=>{
 const raw=localStorage.getItem(key);if(!raw)return {};
 const folders=new Set(JSON.parse(localStorage.getItem('shiye-demo-folders')!) as string[]);
 return Object.fromEntries(Object.entries(JSON.parse(raw).parents as Record<string,string[]>).map(([path,items])=>[path,items.filter(item=>folders.has(item))]));
},orderKey);
const source=(editor:Locator)=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));

test.beforeEach(async({page})=>{
 await page.addInitScript(({notes,folders})=>{
  if(localStorage.getItem('folder-e2e-seeded'))return;
  localStorage.clear();localStorage.setItem('folder-e2e-seeded','true');
  localStorage.setItem('shiye-demo-files',JSON.stringify(notes));localStorage.setItem('shiye-demo-folders',JSON.stringify(folders));
  localStorage.setItem('shiye-demo-settings',JSON.stringify({root:'演示笔记',session:{module:'notes',panes:[{path:'入口.md',mode:'preview',cursor:0,scroll:0}],expanded:['项目','项目/资料','归档']}}));
 },{notes:initialFiles,folders:initialFolders});
 await page.goto('/');await expect(page.locator('.note-pane')).toHaveCount(1);await expect(folder(page,'项目/资料')).toBeVisible();
});

async function startDrag(page:Page,path:string){
 const element=folder(page,path);let bounds:Awaited<ReturnType<Locator['boundingBox']>>=null;
 // Virtual tree rows can be replaced by resize/refresh while the browser scrolls them.
 await expect(async()=>{await element.scrollIntoViewIfNeeded();bounds=await element.boundingBox();expect(bounds).not.toBeNull();}).toPass({timeout:5000});
 expect(bounds).not.toBeNull();await page.mouse.move(bounds!.x+80,bounds!.y+bounds!.height/2);await page.mouse.down();
 await page.mouse.move(bounds!.x+92,bounds!.y+bounds!.height/2,{steps:3});
}
async function pointAt(page:Page,target:Locator,position:'before'|'after'|'inside'){
 const bounds=await target.boundingBox();expect(bounds).not.toBeNull();
 const y=bounds!.y+(position==='before'?3:position==='after'?bounds!.height-3:bounds!.height/2);
 await page.mouse.move(bounds!.x+90,y,{steps:8});
}
async function drop(page:Page,path:string,target:string,position:'before'|'after'|'inside'){
 await startDrag(page,path);await pointAt(page,target===''?page.locator('#workspace-name'):folder(page,target),position);await page.mouse.up();
}
async function confirmMove(page:Page,from:string,to:string){
 const dialog=page.locator('dialog:not(.folder-destination)');await expect(dialog).toBeVisible();
 await expect(dialog).toContainText(from);await expect(dialog).toContainText(to);await expect(dialog).toContainText('相对链接');await expect(dialog).toContainText('图片');
 await dialog.getByRole('button',{name:'移动文件夹',exact:true}).click();await expect(dialog).toHaveCount(0);
}
async function menu(page:Page,path:string){await folder(page,path).click({button:'right'});return page.locator('.context-menu');}
async function menuAction(page:Page,path:string,action:string){await (await menu(page,path)).getByRole('button',{name:action,exact:true}).click();}
async function rename(page:Page,path:string,name:string){
 await menuAction(page,path,'重命名');await page.getByLabel('名称',{exact:true}).fill(name);await page.locator('dialog').getByRole('button',{name:'重命名',exact:true}).click();
}
async function openTwoNotes(page:Page){
 await page.getByRole('link',{name:'打开资料',exact:true}).click();await expect(page.locator('.note-pane')).toHaveCount(2);
 await page.locator('.note-pane').nth(1).getByRole('link',{name:'继续阅读',exact:true}).click();
 await expect(page.locator('.note-pane').nth(0).locator('.note-title strong')).toHaveText('A');await expect(page.locator('.note-pane').nth(1).locator('.note-title strong')).toHaveText('B');
}
async function failStorage(page:Page,mode:'order'|'snapshot'){
 await page.evaluate(mode=>{
  const state=window as typeof window&{folderStorageFailure:string};state.folderStorageFailure=mode;
  const set=Storage.prototype.setItem;
  Storage.prototype.setItem=function(key,value){
   if((state.folderStorageFailure==='order'&&key.startsWith('shiye-demo-folder-order:'))||(state.folderStorageFailure==='snapshot'&&key==='shiye-demo-settings'))throw new DOMException('测试存储不可写','QuotaExceededError');
   return set.call(this,key,value);
  };
 },mode);
}

test('same-parent insertion persists through refresh, hide and page restart',async({page})=>{
 const before=await files(page);await startDrag(page,'C');await pointAt(page,folder(page,'A'),'before');
 await expect(folder(page,'A')).toHaveAttribute('data-folder-drop','before');await expect(page.locator('.drag-ghost')).toContainText('调整同级顺序');
 await page.screenshot({path:'.qa/folder-drop-before.png'});await page.mouse.up();
 await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);await expect(page.locator('dialog')).toHaveCount(0);
 expect(await files(page)).toEqual(before);expect((await savedOrder(page))['']).toEqual(['C','A','B','归档','项目']);
 await page.locator('#refresh').click();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);
 await page.locator('#hide').click();await expect(page.locator('.note-pane')).toHaveCount(1);
 await page.reload();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);
 await drop(page,'C','B','after');await expect.poll(()=>visibleRootFolders(page)).toEqual(['A','B','C','归档','项目']);
});

test('new folders append, application renames retain rank, and external changes reconcile',async({page})=>{
 await drop(page,'C','A','before');await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);
 await page.locator('#workspace-name').click();await page.locator('#new-folder').click();await page.getByLabel('名称',{exact:true}).fill('Z');
 await page.getByRole('button',{name:'创建文件夹',exact:true}).click();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目','Z']);
 await rename(page,'A','ZZ');await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','ZZ','B','归档','项目','Z']);
 await page.evaluate(()=>{const folders=JSON.parse(localStorage.getItem('shiye-demo-folders')!) as string[];localStorage.setItem('shiye-demo-folders',JSON.stringify(folders.filter(path=>path!=='B'&&path!=='ZZ').concat('AA','D')));});
 await page.locator('#refresh').click();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','归档','项目','Z','AA','D']);
 await page.reload();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','归档','项目','Z','AA','D']);
});

test('resetting one level leaves descendant ordering and file bytes intact',async({page})=>{
 await page.evaluate(key=>{localStorage.setItem(key,JSON.stringify({version:1,root:'演示笔记',revision:'1',parents:{'':['C','A','B','归档','项目'],'项目/资料':['项目/资料/子目录']}}));},orderKey);
 await page.reload();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);const before=await files(page);
 await menuAction(page,'C','恢复同级默认排序');await expect.poll(()=>visibleRootFolders(page)).toEqual(['A','B','C','归档','项目']);
 expect((await savedOrder(page))['']).toBeUndefined();expect((await savedOrder(page))['项目/资料']).toEqual(['项目/资料/子目录']);expect(await files(page)).toEqual(before);
});

test('moving into a folder and back to the root retains the entire subtree',async({page})=>{
 const before=await files(page);await startDrag(page,'项目/资料');await pointAt(page,folder(page,'归档'),'inside');
 await expect(folder(page,'归档')).toHaveAttribute('data-folder-drop','inside');await expect(page.locator('.drag-ghost')).toContainText('移动到 归档');
 await page.screenshot({path:'.qa/folder-drop-inside.png'});await page.mouse.up();await confirmMove(page,'项目/资料','归档/资料');
 await expect(folder(page,'归档/资料')).toBeVisible();expect(await storedFolders(page)).not.toContain('项目/资料');
 for(const [path,text] of Object.entries(before).filter(([path])=>path.startsWith('项目/资料/')))expect((await files(page))['归档/资料/'+path.slice('项目/资料/'.length)]).toBe(text);
 expect((await savedOrder(page))['归档']).toEqual(['归档/已有','归档/资料']);
 await drop(page,'归档/资料','','inside');await confirmMove(page,'归档/资料','资料');await expect(folder(page,'资料')).toBeVisible();
 for(const [path,text] of Object.entries(before).filter(([path])=>path.startsWith('项目/资料/')))expect((await files(page))['资料/'+path.slice('项目/资料/'.length)]).toBe(text);
 expect((await savedOrder(page))[''].at(-1)).toBe('资料');expect((await storedFolders(page)).some(path=>path.startsWith('归档/资料'))).toBe(false);
 await page.reload();await expect(folder(page,'资料')).toBeVisible();
});

test('a cross-parent insertion line moves beside the anchor instead of into it',async({page})=>{
 await drop(page,'项目/资料','归档','before');await confirmMove(page,'项目/资料','资料');
 await expect.poll(()=>visibleRootFolders(page)).toEqual(['A','B','C','资料','归档','项目']);expect(await storedFolders(page)).toContain('资料/子目录');
 expect(await storedFolders(page)).not.toContain('归档/资料');expect((await files(page))['资料/A.md']).toBe(initialFiles['项目/资料/A.md']);
});

test('the keyboard menu exposes ordering boundaries and the destination picker cancels safely',async({page})=>{
 const tree=page.locator('#tree');await tree.focus();await tree.press('Home');await tree.press('Shift+F10');
 let context=page.locator('.context-menu');await expect(context.getByRole('button',{name:'上移',exact:true})).toBeDisabled();
 await context.getByRole('button',{name:'下移',exact:true}).focus();await page.keyboard.press('Enter');
 await expect.poll(()=>visibleRootFolders(page)).toEqual(['B','A','C','归档','项目']);
 context=await menu(page,'项目');await expect(context.getByRole('button',{name:'下移',exact:true})).toBeDisabled();
 await context.getByRole('button',{name:'移动到…',exact:true}).focus();await page.keyboard.press('Enter');
 const picker=page.locator('.folder-destination');await expect(picker).toBeVisible();await expect(picker.getByRole('button',{name:'进入文件夹 项目',exact:true})).toBeDisabled();
 await expect(picker.getByRole('button',{name:'移到此目录',exact:true})).toBeDisabled();
 await picker.getByRole('button',{name:'进入文件夹 归档',exact:true}).focus();await page.keyboard.press('Enter');await expect(picker.locator('.folder-destination-path')).toHaveText('归档');
 await picker.getByRole('button',{name:'返回上级',exact:true}).click();await expect(picker.locator('.folder-destination-path')).toHaveText('笔记根目录');
 await picker.getByRole('button',{name:'进入文件夹 归档',exact:true}).click();await picker.getByRole('button',{name:'笔记根目录',exact:true}).click();
 const before=await storedFolders(page);await page.keyboard.press('Escape');await expect(picker).toHaveCount(0);expect(await storedFolders(page)).toEqual(before);
});

test('destination selection shows the final path and cancelling either dialog keeps the old location',async({page})=>{
 const before=await files(page),foldersBefore=await storedFolders(page);await menuAction(page,'项目/资料','移动到…');
 let picker=page.locator('.folder-destination');await expect(picker.locator('.folder-destination-path')).toHaveText('项目');
 await expect(picker.getByRole('button',{name:'进入文件夹 资料',exact:true})).toBeDisabled();
 await picker.getByRole('button',{name:'笔记根目录',exact:true}).click();await picker.getByRole('button',{name:'进入文件夹 归档',exact:true}).click();
 await picker.getByRole('button',{name:'移到此目录',exact:true}).click();const confirmation=page.locator('dialog');await expect(confirmation).toContainText('归档/资料');
 await confirmation.getByRole('button',{name:'取消',exact:true}).click();expect(await storedFolders(page)).toEqual(foldersBefore);expect(await files(page)).toEqual(before);
 await menuAction(page,'项目/资料','移动到…');picker=page.locator('.folder-destination');await picker.getByRole('button',{name:'取消',exact:true}).click();
 expect(await storedFolders(page)).toEqual(foldersBefore);await expect(folder(page,'项目/资料')).toBeVisible();
});

test('a destination name created during confirmation fails without merging or overwriting',async({page})=>{
 await drop(page,'项目/资料','归档','inside');await expect(page.locator('dialog')).toBeVisible();
 await page.evaluate(()=>{const folders=JSON.parse(localStorage.getItem('shiye-demo-folders')!) as string[];folders.push('归档/资料');localStorage.setItem('shiye-demo-folders',JSON.stringify(folders));const files=JSON.parse(localStorage.getItem('shiye-demo-files')!);files['归档/资料/保护.md']='必须保留';localStorage.setItem('shiye-demo-files',JSON.stringify(files));});
 await confirmMove(page,'项目/资料','归档/资料');await expect(page.locator('#toast')).toContainText('同名');
 const after=await files(page);expect(after['项目/资料/A.md']).toBe(initialFiles['项目/资料/A.md']);expect(after['归档/资料/保护.md']).toBe('必须保留');expect(after['归档/资料/A.md']).toBeUndefined();
 await expect(folder(page,'项目/资料')).toBeVisible();
});

test('a removed insertion anchor is rejected after confirmation without moving the source',async({page})=>{
 await drop(page,'项目/资料','归档','before');await expect(page.locator('dialog')).toBeVisible();
 await page.evaluate(()=>{const folders=JSON.parse(localStorage.getItem('shiye-demo-folders')!) as string[];localStorage.setItem('shiye-demo-folders',JSON.stringify(folders.filter(path=>path!=='归档'&&!path.startsWith('归档/'))));});
 await confirmMove(page,'项目/资料','资料');await expect(page.locator('#toast')).toContainText(/不存在|失效|变化/);
 expect(await storedFolders(page)).toContain('项目/资料');expect((await files(page))['资料/A.md']).toBeUndefined();
});

test('moved panes retain mode and undo history, autosave only at new paths, and restore together',async({page})=>{
 await openTwoNotes(page);const panes=page.locator('.note-pane');
 for(let index=0;index<2;index++){
  const pane=panes.nth(index);await pane.getByRole('button',{name:'编辑模式',exact:true}).click();const editor=pane.locator('.cm-content');
  await editor.click();await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially(index===0?'Left marker':'Right marker');
 }
 await drop(page,'项目/资料','归档','inside');await confirmMove(page,'项目/资料','归档/资料');
 await expect(panes.nth(0).locator('.note-title small')).toContainText('归档/资料');await expect(panes.nth(1).locator('.note-title small')).toContainText('归档/资料/子目录');
 await expect(panes.locator('.cm-content')).toHaveCount(2);await expect(panes.locator('.save-state')).toHaveText(['已保存到本地','已保存到本地']);
 await page.screenshot({path:'.qa/folder-moved-split.png'});
 for(let index=0;index<2;index++){
  const editor=panes.nth(index).locator('.cm-content'),marker=index===0?'Left marker':'Right marker';
  await editor.focus();await editor.press('Control+z');expect(await source(editor)).not.toContain(marker);
  await editor.press('Control+y');expect(await source(editor)).toContain(marker);await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially('New path');
 }
 await expect(panes.locator('.save-state')).toHaveText(['已保存到本地','已保存到本地']);
 const after=await files(page);expect(after['归档/资料/A.md']).toContain('Left marker\nNew path');expect(after['归档/资料/子目录/B.md']).toContain('Right marker\nNew path');
 expect(Object.keys(after).some(path=>path.startsWith('项目/资料/'))).toBe(false);
 await page.reload();await expect(page.locator('.note-pane .cm-content')).toHaveCount(2);await expect(page.locator('.note-pane').nth(0).locator('.cm-content')).toContainText('Left marker');
 await expect(page.locator('.note-pane').nth(1).locator('.cm-content')).toContainText('Right marker');
 await page.locator('.note-pane').nth(0).getByRole('button',{name:'显示模式',exact:true}).click();await page.locator('.note-pane').nth(0).getByRole('link',{name:'继续阅读',exact:true}).click();
 await expect(page.locator('.note-pane')).toHaveCount(2);await expect(page.locator('.note-pane').nth(1).locator('.note-title small')).toContainText('归档/资料/子目录');
});

test('a dirty save conflict blocks the folder move and keeps the current editor buffer',async({page})=>{
 await page.getByRole('link',{name:'打开资料',exact:true}).click();const pane=page.locator('.note-pane').nth(1);await pane.getByRole('button',{name:'编辑模式',exact:true}).click();
 await pane.locator('.cm-content').fill('本地未保存修改');
 await page.evaluate(()=>{const files=JSON.parse(localStorage.getItem('shiye-demo-files')!);files['项目/资料/A.md']='外部程序修改';localStorage.setItem('shiye-demo-files',JSON.stringify(files));});
 await drop(page,'项目/资料','归档','inside');await confirmMove(page,'项目/资料','归档/资料');
 await expect(pane.locator('.save-state')).toHaveText('保存需要处理');await expect(pane.locator('.cm-content')).toContainText('本地未保存修改');
 await expect(pane.locator('.note-title small')).toContainText('项目/资料');expect(await storedFolders(page)).toContain('项目/资料');expect((await files(page))['项目/资料/A.md']).toBe('外部程序修改');
});

test('Esc, blur, and pointercancel remove drag feedback without committing a move',async({page})=>{
 const before=await storedFolders(page);
 for(const cancellation of ['Escape','blur','pointercancel']){
  await test.step('cancel drag with '+cancellation,async()=>{
  await startDrag(page,'C');await pointAt(page,folder(page,'A'),'before');await expect(folder(page,'A')).toHaveAttribute('data-folder-drop','before');
  if(cancellation==='Escape')await page.keyboard.press('Escape');
  else if(cancellation==='blur')await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  else await page.evaluate(()=>window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
  await page.mouse.up();await expect(page.locator('[data-folder-drop]')).toHaveCount(0);await expect(page.locator('.drag-ghost')).toBeHidden();
  expect(await storedFolders(page)).toEqual(before);expect(await savedOrder(page)).toEqual({});
  });
 }
 await expect(folder(page,'C')).toHaveAttribute('aria-expanded','false');
});

test('self, descendants, and blank tree areas are invalid folder drop targets',async({page})=>{
 const before=await storedFolders(page);await drop(page,'项目','项目/资料','inside');await expect(page.locator('#toast')).toContainText('不能放置');
 await expect(page.locator('dialog')).toHaveCount(0);expect(await storedFolders(page)).toEqual(before);
 await drop(page,'C','C','inside');await expect(page.locator('[data-folder-drop]')).toHaveCount(0);expect(await savedOrder(page)).toEqual({});
 await startDrag(page,'C');const tree=await page.locator('#tree').boundingBox();await page.mouse.move(tree!.x+20,tree!.y+tree!.height-5,{steps:5});await page.mouse.up();
 await expect(page.locator('dialog')).toHaveCount(0);expect(await storedFolders(page)).toEqual(before);
});

test('edge scrolling retargets virtual rows and stops when the drop finishes',async({page})=>{
 await page.evaluate(()=>{localStorage.setItem('shiye-demo-folders',JSON.stringify(Array.from({length:60},(_,index)=>'F'+String(index).padStart(3,'0'))));localStorage.setItem('shiye-demo-files',JSON.stringify({'入口.md':'# 长列表验收'}));const settings=JSON.parse(localStorage.getItem('shiye-demo-settings')!);settings.session.expanded=[];localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));});
 await page.reload();await expect(folder(page,'F000')).toBeVisible();expect(await page.locator('.tree-row').count()).toBeLessThan(45);
 await startDrag(page,'F000');const tree=page.locator('#tree'),bounds=await tree.boundingBox();await page.mouse.move(bounds!.x+90,bounds!.y+bounds!.height-10,{steps:5});
 await expect.poll(()=>folder(page,'F059').evaluateAll(nodes=>{const node=nodes[0];if(!node)return false;const row=node.getBoundingClientRect(),tree=document.getElementById('tree')!.getBoundingClientRect();return row.top>=tree.top&&row.bottom<=tree.bottom;}),{timeout:10000}).toBe(true);
 // 最后一个文件夹刚可见时列表仍在滚动，到达底部后再读取放置位置。
 await expect.poll(() => tree.evaluate(element =>
  element.scrollHeight - element.clientHeight - element.scrollTop
 ), {timeout: 10000}).toBeLessThanOrEqual(1);
 await pointAt(page,folder(page,'F059'),'before');await expect(folder(page,'F059')).toHaveAttribute('data-folder-drop','before');await page.mouse.up();
 await expect.poll(async()=>((await savedOrder(page))['']??[]).slice(-3)).toEqual(['F058','F000','F059']);
 await expect(page.locator('[data-folder-drop]')).toHaveCount(0);await expect(page.locator('.drag-ghost')).toBeHidden();
 const stopped=await tree.evaluate(element=>element.scrollTop);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));expect(await tree.evaluate(element=>element.scrollTop)).toBe(stopped);
});

test('notes still drag into an editor as links and folders never insert markdown',async({page})=>{
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();const editor=page.locator('.cm-content');await editor.click();await editor.press('Control+Home');
 await folder(page,'外部.md').dragTo(editor,{targetPosition:{x:160,y:13}});await expect(editor.locator('.cm-line').first()).toContainText('[外部]('+encodeURIComponent('外部')+'.md)');
 const before=await source(editor);await folder(page,'C').dragTo(editor);await expect(page.locator('#toast')).toContainText('文件夹不能插入链接');expect(await source(editor)).toBe(before);
 await editor.locator('.cm-line').first().getByText('外部',{exact:true}).click({modifiers:['Control']});await expect(page.locator('.note-pane')).toHaveCount(2);
 await expect(page.locator('.note-pane').nth(1).locator('.note-title strong')).toHaveText('外部');
});

test('a pure ordering write failure keeps the previous visible and persisted order',async({page})=>{
 await failStorage(page,'order');await drop(page,'C','A','before');await expect(page.locator('#toast')).toContainText('未能保存');
 expect(await visibleRootFolders(page)).toEqual(['A','B','C','归档','项目']);expect(await savedOrder(page)).toEqual({});expect(await files(page)).toEqual(initialFiles);
 await page.reload();await expect.poll(()=>visibleRootFolders(page)).toEqual(['A','B','C','归档','项目']);
});

for(const failure of ['order','snapshot'] as const){
 test('a moved folder keeps its new paths when '+failure+' persistence fails and retry succeeds',async({page})=>{
  await openTwoNotes(page);await failStorage(page,failure);await drop(page,'项目/资料','归档','inside');await confirmMove(page,'项目/资料','归档/资料');
  const warning=page.locator('.folder-status');await expect(warning).toBeVisible();await expect(warning).toContainText(failure==='order'?'顺序未保存':'恢复记录未保存');
  await expect(page.locator('.note-pane').nth(0).locator('.note-title small')).toContainText('归档/资料');await expect(page.locator('.note-pane').nth(1).locator('.note-title small')).toContainText('归档/资料/子目录');
  const moved=await files(page);expect(moved['归档/资料/A.md']).toBe(initialFiles['项目/资料/A.md']);expect(moved['项目/资料/A.md']).toBeUndefined();
  await page.evaluate(()=>{(window as typeof window&{folderStorageFailure:string}).folderStorageFailure='';});
  await warning.getByRole('button',{name:'重试保存',exact:true}).click();await expect(warning).toBeHidden();expect(await files(page)).toEqual(moved);
  expect((await savedOrder(page))['归档']).toEqual(['归档/已有','归档/资料']);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-settings')!).session.panes.map((pane:{path:string})=>pane.path))).toEqual(['归档/资料/A.md','归档/资料/子目录/B.md']);
  await page.reload();await expect(page.locator('.note-pane')).toHaveCount(2);await expect(page.locator('.note-pane').nth(0).locator('.note-title small')).toContainText('归档/资料');
 });
}

test('damaged ordering preferences stay intact until repaired and explicitly retried',async({page})=>{
 await page.evaluate(key=>localStorage.setItem(key,'damaged order'),orderKey);await page.reload();
 const warning=page.locator('.folder-status');await expect(warning).toContainText('读取失败');await expect.poll(()=>visibleRootFolders(page)).toEqual(['A','B','C','归档','项目']);
 await drop(page,'C','A','before');await expect(page.locator('#toast')).toContainText('读取失败');expect(await page.evaluate(key=>localStorage.getItem(key),orderKey)).toBe('damaged order');
 await page.evaluate(key=>localStorage.setItem(key,JSON.stringify({version:1,root:'演示笔记',revision:'1',parents:{'':['C','A','B','归档','项目']}})),orderKey);
 await warning.getByRole('button',{name:'重试保存',exact:true}).click();await expect(warning).toBeHidden();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);
});

test('opening another workspace reads only that workspace ordering preferences',async({page})=>{
 await drop(page,'C','A','before');await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);
 const first=await savedOrder(page);
 await page.evaluate(()=>{const settings=JSON.parse(localStorage.getItem('shiye-demo-settings')!);settings.root='第二笔记库';localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));});
 await page.reload();await expect(page.locator('#workspace-name')).toHaveText('第二笔记库');await expect.poll(()=>visibleRootFolders(page)).toEqual(['A','B','C','归档','项目']);
 await drop(page,'B','A','before');await expect.poll(()=>visibleRootFolders(page)).toEqual(['B','A','C','归档','项目']);expect(await savedOrder(page)).toEqual(first);
 await page.evaluate(()=>{const settings=JSON.parse(localStorage.getItem('shiye-demo-settings')!);settings.root='演示笔记';localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));});
 await page.reload();await expect.poll(()=>visibleRootFolders(page)).toEqual(['C','A','B','归档','项目']);
});

test('reopening a collapsed folder appends each external addition to its latest custom order',async({page})=>{
 await page.evaluate(key=>{
  const folders=JSON.parse(localStorage.getItem('shiye-demo-folders')!) as string[];
  localStorage.setItem('shiye-demo-folders',JSON.stringify(folders.concat('集合','集合/A','集合/C')));
  localStorage.setItem(key,JSON.stringify({version:1,root:'演示笔记',revision:'1',parents:{'集合':['集合/A','集合/C']}}));
 },orderKey);
 await page.reload();await expect(folder(page,'集合')).toHaveAttribute('aria-expanded','false');
 const children=()=>page.locator('.tree-row[aria-expanded][data-path^="集合/"]').evaluateAll(nodes=>nodes.map(node=>(node as HTMLElement).dataset.path!));
 for(const name of ['D','B']){
  await page.evaluate(name=>{const folders=JSON.parse(localStorage.getItem('shiye-demo-folders')!) as string[];folders.push('集合/'+name);localStorage.setItem('shiye-demo-folders',JSON.stringify(folders));},name);
  await folder(page,'集合').click();await expect(folder(page,'集合')).toHaveAttribute('aria-expanded','true');
  const expected=name==='D'?['集合/A','集合/C','集合/D']:['集合/A','集合/C','集合/D','集合/B'];
  await expect.poll(children).toEqual(expected);expect((await savedOrder(page))['集合']).toEqual(expected);
  if(name==='D'){await folder(page,'集合').click();await expect(folder(page,'集合')).toHaveAttribute('aria-expanded','false');await expect.poll(children).toEqual([]);}
 }
});

test('a move at the expansion limit selects the visible destination without opening a 301st folder',async({page})=>{
 await page.evaluate(()=>{
  const expanded=Array.from({length:300},(_,index)=>'F'+String(index).padStart(3,'0'));
  localStorage.setItem('shiye-demo-folders',JSON.stringify([...expanded,'归档','资料']));
  localStorage.setItem('shiye-demo-files',JSON.stringify({'入口.md':'# 展开上限验收','资料/A.md':'保留正文'}));
  const settings=JSON.parse(localStorage.getItem('shiye-demo-settings')!);settings.session.expanded=expanded;localStorage.setItem('shiye-demo-settings',JSON.stringify(settings));
 });
 await page.reload();await expect(folder(page,'F000')).toHaveAttribute('aria-expanded','true');
 await page.locator('#tree').evaluate(element=>{element.scrollTop=element.scrollHeight;});await expect(folder(page,'资料')).toBeVisible();
 await menuAction(page,'资料','移动到…');const picker=page.locator('.folder-destination');
 await picker.getByRole('button',{name:'进入文件夹 归档',exact:true}).click();await picker.getByRole('button',{name:'移到此目录',exact:true}).click();
 await confirmMove(page,'资料','归档/资料');await expect(page.locator('#toast')).toContainText('展开已达 300 个上限');
 await expect(folder(page,'归档')).toHaveAttribute('aria-selected','true');await expect(folder(page,'归档')).toHaveAttribute('aria-expanded','false');await expect(folder(page,'归档/资料')).toHaveCount(0);
 expect((await files(page))['归档/资料/A.md']).toBe('保留正文');expect((await files(page))['资料/A.md']).toBeUndefined();
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-settings')!).session.expanded.length)).toBe(300);
});
