// Run only against a build made with scripts/folder-native-config.json.
// node scripts/folder-native-smoke.mjs src-tauri/target/folder-moves/release/shiye.exe
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,stat,rename,rmdir,chmod} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=path.resolve(workspace,process.argv[2]||'src-tauri/target/folder-moves/release/shiye.exe');
if(!exe.startsWith(path.join(workspace,'src-tauri','target')+path.sep))throw new Error('QA executable must be inside this workspace target directory.');
const executableBytes=await readFile(exe);
if(!executableBytes.includes(Buffer.from('local.shiye.workbench.folderqa')))throw new Error('Build with scripts/folder-native-config.json; never run this harness with the production identity.');
const data=path.join(workspace,'.qa','folder-native-'+Date.now()),notes=path.join(data,'notes'),otherNotes=path.join(data,'other-notes');
const output=path.join(workspace,'docs','verification'),reportPath=path.join(output,'raw','folder-moves-native.json');
await mkdir(path.dirname(reportPath),{recursive:true});
for(const directory of ['A','B','C','项目/资料/子目录','归档/已有'])await mkdir(path.join(notes,directory),{recursive:true});
for(const directory of ['A','B','C'])await mkdir(path.join(otherNotes,directory),{recursive:true});
await writeFile(path.join(notes,'入口.md'),'# 文件夹原生验收\n\n[打开资料](项目/资料/A.md)\n');
await writeFile(path.join(notes,'项目/资料/A.md'),'\uFEFF# 资料 A\r\n\r\n[继续阅读](子目录/B.md)\r\n\r\n保留中文与空行。\r\n');
await writeFile(path.join(notes,'项目/资料/子目录/B.md'),'# 资料 B\n\n第二个窗格的正文。\n');
await writeFile(path.join(notes,'项目/资料/附件.dat'),Buffer.from([0,255,13,10,1,2,128,254]));
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:notes,shortcut:'Control+Alt+F10',floating:false,session:{module:'notes',expanded:['项目','项目/资料','归档'],panes:[{path:'入口.md',mode:'preview',cursor:0,scroll:0}]}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const assetNames=['index.html',...(await readdir(path.join(workspace,'dist','assets'))).map(name=>'assets/'+name)].sort();
const assets=Object.fromEntries(await Promise.all(assetNames.map(async name=>[name,sha256(await readFile(path.join(workspace,'dist',name)))])));
const results={date:new Date().toISOString(),executable:exe,sha256:sha256(executableBytes),assets,data,configuration:'Production code/assets with isolated identifier local.shiye.workbench.folderqa; isolated SHIYE_DATA_DIR and fixtures; WebView2 CDP automation, not physical input.',checks:[],screenshots:[],hashes:{}};
let child,browser,page,readonlyRecord;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(){
 child=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});results.pid=child.pid;
 for(let attempt=0;attempt<100;attempt++){
  if(child.exitCode!==null)throw new Error('QA application exited before WebView2 was ready.');
  try{
   browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1500});page=browser.contexts()[0].pages()[0];
   if(page){page.setDefaultTimeout(12000);await page.locator('#tree').waitFor();await expect(page.locator('.startup-error')).toHaveCount(0);return;}
  }catch{}
  await wait(150);
 }
 throw new Error('Cannot attach to the isolated WebView2 fixture.');
}
const invoke=async(command,args={})=>{
 const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message||String(error)}};}},[command,args]);
 if(!result.ok)throw result.error;return result.value;
};
async function stop(){
 await invoke('exit_app').catch(()=>{});await expect.poll(()=>child.exitCode).toBe(0);await browser?.close().catch(()=>{});browser=undefined;page=undefined;
}
function check(name,details){results.checks.push({name,pass:true,...(details?{details}:{})});console.log(name);}
async function shot(name){await page.screenshot({path:path.join(output,name)});results.screenshots.push(name);}
async function hashes(directory){
 const result={};
 async function walk(current){for(const entry of await readdir(current,{withFileTypes:true})){const full=path.join(current,entry.name);if(entry.isDirectory())await walk(full);else if(entry.isFile()){const bytes=await readFile(full);result[path.relative(directory,full).replaceAll('\\','/')]={bytes:bytes.length,sha256:sha256(bytes)};}else throw new Error('Unexpected link in QA fixture.');}}
 await walk(directory);return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
const exists=async full=>{try{await stat(full);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const row=relative=>page.locator('.tree-row[data-path="'+relative+'"]');
const rootFolders=()=>page.locator('.tree-row[aria-expanded]').evaluateAll(nodes=>nodes.map(node=>node.dataset.path).filter(relative=>!relative.includes('/')));
const source=editor=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
async function startDrag(relative){
 // Hover retries if a save/status update replaces a virtual row, and waits for inert to clear.
 await expect.poll(()=>page.locator('#app').evaluate(element=>element.inert)).toBe(false);
 const entry=row(relative);await entry.hover();const box=await entry.boundingBox();expect(box).not.toBeNull();
 await page.mouse.move(box.x+70,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+82,box.y+box.height/2,{steps:3});
}
async function point(target,position){
 const element=target===''?page.locator('#workspace-name'):row(target),box=await element.boundingBox();expect(box).not.toBeNull();
 await page.mouse.move(box.x+85,box.y+(position==='before'?3:position==='after'?box.height-3:box.height/2),{steps:8});
 return element;
}
async function drag(source,target,position){await startDrag(source);await point(target,position);await page.mouse.up();}
async function confirmMove(source,destination){
 const dialog=page.locator('dialog:not(.folder-destination)');await expect(dialog).toBeVisible();await expect(dialog).toContainText(source);await expect(dialog).toContainText(destination);await expect(dialog).toContainText('相对链接');await expect(dialog).toContainText('图片');
 await dialog.getByRole('button',{name:'移动文件夹',exact:true}).click();await expect(dialog).toHaveCount(0);
}
async function action(fields){const order=await invoke('folder_order');return invoke('arrange_folder',{action:{root:order.root,revision:order.revision,...fields}});}
async function orderRecord(){
 const root=(await invoke('get_settings')).root.replaceAll('\\','/').toLowerCase();
 for(const name of await readdir(path.join(data,'tree-order'))){const full=path.join(data,'tree-order',name);if(name.endsWith('.json')&&JSON.parse(await readFile(full,'utf8')).root===root)return full;}
 throw new Error('Missing root-specific folder preference file.');
}

try{
 await start();expect((await invoke('get_settings')).root).toBe(notes);await expect(page.locator('.note-pane')).toHaveCount(1);
 results.hashes.initial=await hashes(notes);await startDrag('C');await point('A','before');await expect(row('A')).toHaveAttribute('data-folder-drop','before');await expect(page.locator('.drag-ghost')).toContainText('调整同级顺序');
 await shot('folder-native-insert.png');await page.mouse.up();await expect.poll(rootFolders).toEqual(['C','A','B','归档','项目']);
 await page.locator('#refresh').click();await expect.poll(rootFolders).toEqual(['C','A','B','归档','项目']);expect(await hashes(notes)).toEqual(results.hashes.initial);
 const stored=JSON.parse(await readFile(await orderRecord(),'utf8'));expect(stored.parents['']).toEqual(['C','A','B','归档','项目']);
 check('Native insertion feedback and same-parent sorting persist outside the note library without changing file bytes');

 await page.getByRole('link',{name:'打开资料',exact:true}).click();await expect(page.locator('.note-pane')).toHaveCount(2);
 await page.locator('.note-pane').nth(1).getByRole('link',{name:'继续阅读',exact:true}).click();
 const panes=page.locator('.note-pane');await expect(panes.nth(0).locator('.note-title strong')).toHaveText('A');await expect(panes.nth(1).locator('.note-title strong')).toHaveText('B');
 for(let index=0;index<2;index++){
  const pane=panes.nth(index);await pane.getByRole('button',{name:'编辑模式',exact:true}).click();const editor=pane.locator('.cm-content');
  await editor.click();await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially(index===0?'Left marker':'Right marker');await editor.press('Control+s');
 }
 await expect(panes.locator('.save-state')).toHaveText(['已保存到本地','已保存到本地']);results.hashes.beforeMove=await hashes(path.join(notes,'项目/资料'));
 await startDrag('项目/资料');await point('归档','inside');await expect(row('归档')).toHaveAttribute('data-folder-drop','inside');await expect(page.locator('.drag-ghost')).toContainText('移动到 归档');
 await shot('folder-native-inside.png');await page.mouse.up();await confirmMove('项目/资料','归档/资料');
 await expect(row('归档/资料')).toBeVisible();expect(await exists(path.join(notes,'项目/资料'))).toBe(false);results.hashes.afterMove=await hashes(path.join(notes,'归档/资料'));expect(results.hashes.afterMove).toEqual(results.hashes.beforeMove);
 await expect(panes.nth(0).locator('.note-title small')).toContainText('归档/资料');await expect(panes.nth(1).locator('.note-title small')).toContainText('归档/资料/子目录');await shot('folder-native-split.png');
 for(let index=0;index<2;index++){
  const editor=panes.nth(index).locator('.cm-content'),marker=index===0?'Left marker':'Right marker';
  await editor.focus();await editor.press('Control+z');expect(await source(editor)).not.toContain(marker);await editor.press('Control+y');expect(await source(editor)).toContain(marker);
  await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially('New path');await editor.press('Control+s');
 }
 await expect(panes.locator('.save-state')).toHaveText(['已保存到本地','已保存到本地']);
 const leftBytes=await readFile(path.join(notes,'归档/资料/A.md'),'utf8');expect(leftBytes).toContain('Left marker\r\nNew path');expect(leftBytes.startsWith('\uFEFF')).toBe(true);expect(leftBytes.replace(/\r\n/g,'')).not.toContain('\n');expect(await readFile(path.join(notes,'归档/资料/子目录/B.md'),'utf8')).toContain('Right marker\nNew path');
 check('Real subtree move preserves non-Markdown bytes, BOM/CRLF, two pane identities, undo/redo and subsequent saves only at new paths');

 results.hashes.beforeFurtherMoves=await hashes(path.join(notes,'归档/资料'));
 await drag('归档/资料','','inside');await confirmMove('归档/资料','资料');await expect(row('资料')).toBeVisible();
 expect((await invoke('folder_order')).parents[''].at(-1)).toBe('资料');
 await drag('资料','项目','inside');await confirmMove('资料','项目/资料');await expect(row('项目/资料')).toBeVisible();
 await drag('项目/资料','归档','before');await confirmMove('项目/资料','资料');await expect(row('资料')).toBeVisible();
 expect((await invoke('folder_order')).parents['']).toEqual(['C','A','B','资料','归档','项目']);results.hashes.afterFurtherMoves=await hashes(path.join(notes,'资料'));expect(results.hashes.afterFurtherMoves).toEqual(results.hashes.beforeFurtherMoves);
 await expect.poll(async()=>(await invoke('get_settings')).session.panes.map(pane=>pane.path)).toEqual(['资料/A.md','资料/子目录/B.md']);
 await stop();await start();await expect(page.locator('.note-pane .cm-content')).toHaveCount(2);await expect(page.locator('.note-pane').nth(0).locator('.cm-content')).toContainText('Left marker');await expect(page.locator('.note-pane').nth(1).locator('.cm-content')).toContainText('Right marker');
 await expect.poll(rootFolders).toEqual(['C','A','B','资料','归档','项目']);expect(await exists(path.join(notes,'项目/资料'))).toBe(false);
 check('Move back to root, cross-parent anchored insertion and native process restart preserve order and both new session paths');

 const firstPane=page.locator('.note-pane').nth(0);await firstPane.locator('.cm-content').fill('本地未保存修改');await writeFile(path.join(notes,'资料/A.md'),'外部程序修改');
 await drag('资料','归档','inside');await confirmMove('资料','归档/资料');await expect(firstPane.locator('.save-state')).toHaveText('保存需要处理');await expect(firstPane.locator('.cm-content')).toContainText('本地未保存修改');
 expect(await exists(path.join(notes,'资料'))).toBe(true);expect(await exists(path.join(notes,'归档/资料'))).toBe(false);expect(await readFile(path.join(notes,'资料/A.md'),'utf8')).toBe('外部程序修改');
 await firstPane.locator('.save-state').click();await page.getByRole('button',{name:'从磁盘重新载入',exact:true}).click();await page.getByRole('button',{name:'重新载入',exact:true}).click();await expect(firstPane.locator('.cm-content')).toHaveText('外部程序修改');
 check('A real external save conflict blocks a UI folder move and preserves both the dirty buffer and disk contents until explicit reload');

 await mkdir(path.join(notes,'Z-new'));await rename(path.join(notes,'A'),path.join(notes,'AA'));await rmdir(path.join(notes,'B'));
 await page.locator('#refresh').click();await expect.poll(rootFolders).toEqual(['C','资料','归档','项目','AA','Z-new']);
 const firstRootOrder=(await invoke('folder_order')).parents[''];
 await invoke('set_workspace',{root:otherNotes});await page.reload();await expect.poll(rootFolders).toEqual(['A','B','C']);await action({source:'B',parent:'',anchor:'A',placement:'before'});await page.locator('#refresh').click();await expect.poll(rootFolders).toEqual(['B','A','C']);
 await invoke('set_workspace',{root:notes});await page.reload();await expect.poll(rootFolders).toEqual(firstRootOrder);
 check('External add/delete/rename appends newly observed folders, and two actual note roots keep independent preferences');

 for(const directory of ['故障/A','故障/B','故障/C','故障/B/冲突','故障/冲突','故障/锚点'])await mkdir(path.join(notes,directory),{recursive:true});
 await writeFile(path.join(notes,'故障/A/payload.dat'),Buffer.from([0,255,13,10,42]));await writeFile(path.join(notes,'故障/B/冲突/保护.txt'),'禁止覆盖');
 await invoke('list_entries',{parent:''});await action({source:'故障/C',parent:'故障',anchor:'故障/A',placement:'before'});
 await expect(action({source:'故障/冲突',parent:'故障/B',placement:'inside'})).rejects.toMatchObject({code:'exists'});
 await expect(action({source:'故障',parent:'故障/A',placement:'inside'})).rejects.toMatchObject({code:'boundary'});
 await expect(action({source:'',parent:'故障/B',placement:'inside'})).rejects.toMatchObject({code:'boundary'});
 const oldOrder=await invoke('folder_order');await rmdir(path.join(notes,'故障/锚点'));
 await expect(invoke('arrange_folder',{action:{root:oldOrder.root,revision:oldOrder.revision,source:'故障/A',parent:'故障',anchor:'故障/锚点',placement:'before'}})).rejects.toMatchObject({code:'missing'});
 expect(await readFile(path.join(notes,'故障/B/冲突/保护.txt'),'utf8')).toBe('禁止覆盖');expect(await exists(path.join(notes,'故障/A'))).toBe(true);
 check('Native backend rejects collisions, root/descendant moves and an externally removed insertion anchor without moving or overwriting data');

 readonlyRecord=await orderRecord();const originalRecord=await readFile(readonlyRecord),beforeFailure=await invoke('folder_order');await chmod(readonlyRecord,0o444);
 await expect(action({source:'故障/B',parent:'故障',anchor:'故障/C',placement:'before'})).rejects.toBeDefined();
 expect((await invoke('folder_order')).parents).toEqual(beforeFailure.parents);expect((await invoke('folder_order')).revision).toBe(beforeFailure.revision);expect(await readFile(readonlyRecord)).toEqual(originalRecord);
 results.hashes.beforePartialMove=await hashes(path.join(notes,'故障/A'));const partial=await action({source:'故障/A',parent:'故障/B',placement:'inside'});
 expect(partial).toMatchObject({path:'故障/B/A',moved:true,warning:expect.any(String)});expect(await exists(path.join(notes,'故障/A'))).toBe(false);results.hashes.afterPartialMove=await hashes(path.join(notes,'故障/B/A'));expect(results.hashes.afterPartialMove).toEqual(results.hashes.beforePartialMove);expect(await readFile(readonlyRecord)).toEqual(originalRecord);
 await page.locator('#refresh').click();await shot('folder-native-partial.png');await chmod(readonlyRecord,0o666);readonlyRecord=undefined;
 const retried=await invoke('retry_folder_order',{root:partial.order.root});expect(retried.warning).toBeUndefined();expect(JSON.parse(await readFile(await orderRecord(),'utf8')).parents).toEqual(retried.parents);
 results.partialSuccess={path:partial.path,warning:partial.warning,retrySaved:true};
 check('Read-only preference file rolls back pure sorting but preserves a completed disk move and retries metadata without reversing the move');
 results.hashes.final=await hashes(notes);results.status='passed';
}catch(error){results.status='failed';results.error=String(error?.stack||error);throw error;}
finally{
 if(readonlyRecord)await chmod(readonlyRecord,0o666).catch(()=>{});
 if(page&&child?.exitCode===null)await invoke('exit_app').catch(()=>{});
 if(child?.exitCode===null){await wait(500);if(child.exitCode===null)child.kill();}
 await writeFile(reportPath,JSON.stringify(results,null,2));await browser?.close().catch(()=>{});
}
