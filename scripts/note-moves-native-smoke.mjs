// Run only against the isolated build from scripts/note-native-config.json.
// node scripts/note-moves-native-smoke.mjs src-tauri/target/note-moves/qa/shiye.exe
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,stat,unlink,chmod} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=path.resolve(workspace,process.argv[2]||'src-tauri/target/note-moves/qa/shiye.exe');
if(!exe.startsWith(path.join(workspace,'src-tauri','target','note-moves')+path.sep))throw new Error('QA executable must be inside this workspace note-moves target directory.');
const executableBytes=await readFile(exe);
if(!executableBytes.includes(Buffer.from('local.shiye.workbench.noteqa')))throw new Error('Build with scripts/note-native-config.json; never run this harness with the production identity.');
const data=path.join(workspace,'.qa','note-moves-native-'+Date.now()),notes=path.join(data,'notes'),otherNotes=path.join(data,'other-notes');
const output=path.join(workspace,'docs','verification'),reportPath=path.join(output,'raw','note-moves-native.json');
await mkdir(path.dirname(reportPath),{recursive:true});
for(const directory of ['Alpha','Beta','归档/子文件夹','项目'])await mkdir(path.join(notes,directory),{recursive:true});
await mkdir(otherNotes,{recursive:true});
const fixture={
 'A.md':'\uFEFF# 笔记 A\r\n\r\n[打开 B](B.md)\r\n\r\n保留原有相对链接。\r\n',
 'B.md':'# 笔记 B\n\n第二个窗格。\n',
 'C.md':'# 笔记 C\n\n中文与空行\n\n保持原样。\n',
 '入口.md':'# 笔记排序与移动\n',
 '项目/M.md':'# 项目 M\n\n不改写内容。\n',
 '项目/N.md':'# 项目 N\n',
 '归档/X.md':'# 归档 X\n',
};
for(const [name,text] of Object.entries(fixture))await writeFile(path.join(notes,name),text);
for(const name of ['A.md','B.md','C.md'])await writeFile(path.join(otherNotes,name),'# '+name);
await writeFile(path.join(notes,'附件.dat'),Buffer.from([0,255,13,10,1,2,128,254]));
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:notes,shortcut:'Control+Alt+F9',floating:false,session:{module:'notes',expanded:['归档','项目'],panes:[{path:'A.md',mode:'preview',cursor:0,scroll:0}]}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const assetNames=['index.html',...(await readdir(path.join(workspace,'dist','assets'))).map(name=>'assets/'+name)].sort();
const assets=Object.fromEntries(await Promise.all(assetNames.map(async name=>[name,sha256(await readFile(path.join(workspace,'dist',name)))])));
const results={date:new Date().toISOString(),executable:exe,sha256:sha256(executableBytes),assets,data,configuration:'Production code/assets with isolated identifier local.shiye.workbench.noteqa; isolated SHIYE_DATA_DIR and fixtures; WebView2 CDP automation, not physical input.',checks:[],screenshots:[],hashes:{}};
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
 throw new Error('Cannot attach to the isolated note-moves WebView2 fixture.');
}
const invoke=async(command,args={})=>{
 const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message||String(error)}};}},[command,args]);
 if(!result.ok)throw result.error;return result.value;
};
async function stop(){await invoke('exit_app').catch(()=>{});await expect.poll(()=>child.exitCode).toBe(0);await browser?.close().catch(()=>{});browser=undefined;page=undefined;}
function check(name,details){results.checks.push({name,pass:true,...(details?{details}:{})});console.log(name);}
async function shot(name){await page.screenshot({path:path.join(output,name)});results.screenshots.push(name);}
async function hashes(directory){
 const result={};async function walk(current){for(const entry of await readdir(current,{withFileTypes:true})){const full=path.join(current,entry.name);if(entry.isDirectory())await walk(full);else if(entry.isFile()){const bytes=await readFile(full);result[path.relative(directory,full).replaceAll('\\','/')]={bytes:bytes.length,sha256:sha256(bytes)};}else throw new Error('Unexpected link in QA fixture.');}}
 await walk(directory);return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
const exists=async full=>{try{await stat(full);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const row=relative=>page.locator('.tree-row[data-path="'+relative+'"]');
const rootPaths=()=>page.locator('.tree-row').evaluateAll(nodes=>nodes.map(node=>node.dataset.path).filter(relative=>!relative.includes('/')));
const source=editor=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
async function startDrag(relative){
 await expect.poll(()=>page.locator('#app').evaluate(element=>element.inert)).toBe(false);await row(relative).hover();const box=await row(relative).boundingBox();expect(box).not.toBeNull();
 await page.mouse.move(box.x+70,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+82,box.y+box.height/2,{steps:3});
}
async function point(target,position){
 const element=target===''?page.locator('#workspace-name'):row(target),box=await element.boundingBox();expect(box).not.toBeNull();
 await page.mouse.move(box.x+85,box.y+(position==='before'?3:position==='after'?box.height-3:box.height/2),{steps:8});return element;
}
async function drag(source,target,position){await startDrag(source);await point(target,position);await page.mouse.up();}
async function confirmMove(source,destination){
 const dialog=page.locator('dialog:not(.folder-destination)');await expect(dialog).toBeVisible();await expect(dialog).toContainText(source);await expect(dialog).toContainText(destination);await expect(dialog).toContainText('相对链接');await expect(dialog).toContainText('图片');
 await dialog.getByRole('button',{name:'移动笔记',exact:true}).click();await expect(dialog).toHaveCount(0);
}
async function action(fields){const order=await invoke('folder_order');return invoke('arrange_folder',{action:{root:order.root,revision:order.revision,...fields}});}
async function orderRecord(){
 const root=(await invoke('get_settings')).root.replaceAll('\\','/').toLowerCase();
 for(const name of await readdir(path.join(data,'tree-order'))){const full=path.join(data,'tree-order',name);if(name.endsWith('.json')&&JSON.parse(await readFile(full,'utf8')).root===root)return full;}
 throw new Error('Missing root-specific tree preference file.');
}

try{
 await start();expect((await invoke('get_settings')).root).toBe(notes);await expect(page.locator('.note-pane')).toHaveCount(1);results.hashes.initial=await hashes(notes);
 await drag('Beta','Alpha','before');await expect.poll(rootPaths).toEqual(['Beta','Alpha','归档','项目','A.md','B.md','C.md','入口.md']);
 await startDrag('C.md');await point('A.md','before');await expect(row('A.md')).toHaveAttribute('data-folder-drop','before');await shot('note-native-insert.png');await page.mouse.up();
 const ordered=['Beta','Alpha','归档','项目','C.md','A.md','B.md','入口.md'];await expect.poll(rootPaths).toEqual(ordered);await page.locator('#refresh').click();await expect.poll(rootPaths).toEqual(ordered);
 expect(await hashes(notes)).toEqual(results.hashes.initial);expect(JSON.parse(await readFile(await orderRecord(),'utf8')).parents['']).toEqual(ordered);
 check('Native folder and Markdown groups sort independently; insertion feedback is visible and persisted order leaves all bytes unchanged');

 await page.getByRole('link',{name:'打开 B',exact:true}).click();const panes=page.locator('.note-pane');await expect(panes).toHaveCount(2);
 for(let index=0;index<2;index++){
  const pane=panes.nth(index);await pane.getByRole('button',{name:'编辑模式',exact:true}).click();const editor=pane.locator('.cm-content');await editor.click();await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially(index?'Right marker':'Left marker');await editor.press('Control+s');
 }
 await expect(panes.locator('.save-state')).toHaveText(['已保存到本地','已保存到本地']);
 results.hashes.beforeMove=await hashes(notes);const aBefore=await readFile(path.join(notes,'A.md')),bBefore=await readFile(path.join(notes,'B.md'));
 await startDrag('A.md');await point('归档','before');await expect(row('归档')).toHaveAttribute('data-folder-drop','inside');await shot('note-native-inside.png');await page.mouse.up();await confirmMove('A.md','归档/A.md');
 await expect(row('归档/A.md')).toBeVisible();expect(await exists(path.join(notes,'A.md'))).toBe(false);expect(await readFile(path.join(notes,'归档/A.md'))).toEqual(aBefore);expect(await readFile(path.join(notes,'B.md'))).toEqual(bBefore);
 await expect(panes.nth(0).locator('.note-title small')).toContainText('归档');await expect(panes.nth(1).locator('.note-title small')).toContainText('我的笔记');await shot('note-native-split.png');
 for(let index=0;index<2;index++){
  const editor=panes.nth(index).locator('.cm-content'),marker=index?'Right marker':'Left marker';await editor.focus();await editor.press('Control+z');expect(await source(editor)).not.toContain(marker);await editor.press('Control+y');expect(await source(editor)).toContain(marker);
  await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially('After move');await editor.press('Control+s');
 }
 await expect(panes.locator('.save-state')).toHaveText(['已保存到本地','已保存到本地']);
 const aAfter=await readFile(path.join(notes,'归档/A.md'),'utf8');expect(aAfter).toContain('Left marker\r\nAfter move');expect(aAfter.startsWith('\uFEFF')).toBe(true);expect(aAfter.replace(/\r\n/g,'')).not.toContain('\n');expect(aAfter).toContain('[打开 B](B.md)');
 expect(await readFile(path.join(notes,'B.md'),'utf8')).toContain('Right marker\nAfter move');expect(await exists(path.join(notes,'A.md'))).toBe(false);
 check('A single Markdown file moves without changing its bytes; both pane histories survive and later saves preserve BOM/CRLF at the correct independent paths');

 const cBefore=await readFile(path.join(notes,'C.md'));await drag('C.md','归档','inside');await confirmMove('C.md','归档/C.md');await expect(row('归档/C.md')).toBeVisible();
 await drag('归档/C.md','','inside');await confirmMove('归档/C.md','C.md');await expect(row('C.md')).toBeVisible();expect(await readFile(path.join(notes,'C.md'))).toEqual(cBefore);
 const mBefore=await readFile(path.join(notes,'项目/M.md'));await drag('项目/M.md','B.md','before');await confirmMove('项目/M.md','M.md');await expect(row('M.md')).toBeVisible();expect(await readFile(path.join(notes,'M.md'))).toEqual(mBefore);
 const sequence=['Beta','Alpha','归档','项目','M.md','B.md','入口.md','C.md'];await expect.poll(rootPaths).toEqual(sequence);
 await expect.poll(async()=>(await invoke('get_settings')).session.panes.map(pane=>pane.path)).toEqual(['归档/A.md','B.md']);
 await stop();await start();await expect(page.locator('.note-pane .cm-content')).toHaveCount(2);await expect(page.locator('.note-pane').nth(0).locator('.cm-content')).toContainText('Left marker');await expect(page.locator('.note-pane').nth(1).locator('.cm-content')).toContainText('Right marker');await expect.poll(rootPaths).toEqual(sequence);
 check('Notes move into folders, back to root, and before a cross-parent note anchor; native restart restores ordering and both session paths');

 await drag('C.md','归档','inside');await expect(page.locator('dialog')).toContainText('归档/C.md');await page.getByRole('button',{name:'取消',exact:true}).click();expect(await readFile(path.join(notes,'C.md'))).toEqual(cBefore);expect(await exists(path.join(notes,'归档/C.md'))).toBe(false);
 await drag('C.md','归档','inside');await expect(page.locator('dialog')).toBeVisible();await writeFile(path.join(notes,'归档/C.md'),'目标必须保留');await confirmMove('C.md','归档/C.md');await expect(page.locator('#toast')).toContainText(/同名|文件已存在/);
 expect(await readFile(path.join(notes,'归档/C.md'),'utf8')).toBe('目标必须保留');expect(await readFile(path.join(notes,'C.md'))).toEqual(cBefore);
 check('Cancelled note moves do nothing, and a real competing filename created during confirmation cannot overwrite either note');

 const right=page.locator('.note-pane').nth(1);await right.locator('.cm-content').fill('本地未保存修改');await writeFile(path.join(notes,'B.md'),'外部修改');
 await drag('B.md','归档','inside');await confirmMove('B.md','归档/B.md');await expect(right.locator('.save-state')).toHaveText('保存需要处理');await expect(right.locator('.cm-content')).toContainText('本地未保存修改');
 expect(await readFile(path.join(notes,'B.md'),'utf8')).toBe('外部修改');expect(await exists(path.join(notes,'归档/B.md'))).toBe(false);
 await right.locator('.save-state').click();await page.getByRole('button',{name:'从磁盘重新载入',exact:true}).click();await page.getByRole('button',{name:'重新载入',exact:true}).click();await expect(right.locator('.cm-content')).toHaveText('外部修改');
 check('A real external save conflict blocks note movement and preserves the dirty buffer until explicit disk reload');

 const originalOrder=(await invoke('folder_order')).parents[''];await invoke('set_workspace',{root:otherNotes});await page.reload();await expect.poll(rootPaths).toEqual(['A.md','B.md','C.md']);
 await action({source:'B.md',parent:'',anchor:'A.md',placement:'before'});await page.locator('#refresh').click();await expect.poll(rootPaths).toEqual(['B.md','A.md','C.md']);
 await invoke('set_workspace',{root:notes});await page.reload();await expect.poll(rootPaths).toEqual(originalOrder);
 await mkdir(path.join(notes,'故障'),{recursive:true});await writeFile(path.join(notes,'故障/A.md'),'A');await writeFile(path.join(notes,'故障/B.md'),'B');await writeFile(path.join(notes,'故障/C.md'),'C');await writeFile(path.join(notes,'故障/plain.txt'),'不是 Markdown');await mkdir(path.join(notes,'故障/目标'));
 await action({source:'故障/C.md',parent:'故障',anchor:'故障/A.md',placement:'before'});
 const stale=await invoke('folder_order');await unlink(path.join(notes,'故障/B.md'));
 await expect(invoke('arrange_folder',{action:{root:stale.root,revision:stale.revision,source:'故障/A.md',parent:'故障',anchor:'故障/B.md',placement:'before'}})).rejects.toMatchObject({code:'missing'});
 await expect(action({source:'故障/A.md',parent:'故障',anchor:'故障/目标',placement:'before'})).rejects.toBeDefined();
 await expect(action({source:'故障/plain.txt',parent:'归档',placement:'inside'})).rejects.toBeDefined();expect(await exists(path.join(notes,'故障/A.md'))).toBe(true);expect(await readFile(path.join(notes,'故障/plain.txt'),'utf8')).toBe('不是 Markdown');
 check('Real roots isolate note preferences; backend rejects removed note anchors, cross-kind sorting anchors and non-Markdown file sources');

 readonlyRecord=await orderRecord();const recordBefore=await readFile(readonlyRecord),orderBefore=await invoke('folder_order');await chmod(readonlyRecord,0o444);
 await expect(action({source:'故障/A.md',parent:'故障',anchor:'故障/C.md',placement:'before'})).rejects.toBeDefined();expect((await invoke('folder_order')).parents).toEqual(orderBefore.parents);expect(await readFile(readonlyRecord)).toEqual(recordBefore);
 const noteBefore=await readFile(path.join(notes,'故障/A.md'));const partial=await action({source:'故障/A.md',parent:'故障/目标',placement:'inside'});
 expect(partial).toMatchObject({path:'故障/目标/A.md',moved:true,warning:expect.any(String)});expect(await exists(path.join(notes,'故障/A.md'))).toBe(false);expect(await readFile(path.join(notes,'故障/目标/A.md'))).toEqual(noteBefore);expect(await readFile(readonlyRecord)).toEqual(recordBefore);
 await page.locator('#refresh').click();await shot('note-native-partial.png');await chmod(readonlyRecord,0o666);readonlyRecord=undefined;
 const retried=await invoke('retry_folder_order',{root:partial.order.root});expect(retried.warning).toBeUndefined();expect(JSON.parse(await readFile(await orderRecord(),'utf8')).parents).toEqual(retried.parents);
 results.partialSuccess={path:partial.path,warning:partial.warning,retrySaved:true,sha256:sha256(noteBefore)};
 check('Read-only preferences reject pure note sorting but preserve a completed file move and allow metadata retry without reversing the move');
 expect((await hashes(notes))['附件.dat']).toEqual(results.hashes.initial['附件.dat']);results.hashes.final=await hashes(notes);results.status='passed';
}catch(error){results.status='failed';results.error=String(error?.stack||error);throw error;}
finally{
 if(readonlyRecord)await chmod(readonlyRecord,0o666).catch(()=>{});
 if(page&&child?.exitCode===null)await invoke('exit_app').catch(()=>{});
 if(child?.exitCode===null){await wait(500);if(child.exitCode===null)child.kill();}
 await writeFile(reportPath,JSON.stringify(results,null,2));await browser?.close().catch(()=>{});
}
