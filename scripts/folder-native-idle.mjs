// Functional idle-unload regression only. This does not measure memory or wake latency budgets.
// Uses the real 60-second timer, never the profiling shortcut.
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=path.resolve(workspace,process.argv[2]||'src-tauri/target/folder-moves/qa/shiye.exe');
if(!executable.startsWith(path.join(workspace,'src-tauri','target')+path.sep))throw new Error('QA executable must be inside this workspace target directory.');
const binary=await readFile(executable);
if(!binary.includes(Buffer.from('local.shiye.workbench.folderqa')))throw new Error('This harness requires the isolated folderqa identifier.');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const data=path.join(workspace,'.qa','folder-idle-'+Date.now()),notes=path.join(data,'notes');
const reportPath=path.join(workspace,'docs','verification','raw','folder-moves-idle.json');
await mkdir(path.dirname(reportPath),{recursive:true});
for(const name of ['A','B','C'])await mkdir(path.join(notes,name),{recursive:true});
const content=Buffer.from('\uFEFF# 隐藏恢复\r\n\r\n排序和移动后的笔记应从新路径恢复。\r\n');
await writeFile(path.join(notes,'A','doc.md'),content);
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:notes,shortcut:'Control+Alt+F9',floating:false,session:{module:'notes',expanded:['A'],panes:[{path:'A/doc.md',mode:'edit',cursor:0,scroll:0}]}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const env={...process.env,SHIYE_DATA_DIR:data,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
delete env.SHIYE_PROFILE;
const report={date:new Date().toISOString(),executable,sha256:sha256(binary),data,configuration:'Isolated folderqa application, fresh note fixture and real 60-second hidden idle timer. WebView2 CDP observes page closure; a second application launch wakes the existing host. No profile_unload call; no memory or wake-performance claim.',checks:[],fileSha256Before:sha256(content)};
let owner,wake,browser,page;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(){
 for(let attempt=0;attempt<100;attempt++){
  if(owner.exitCode!==null)throw new Error('The owning QA host exited before reconnection.');
  try{
   browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1500});page=browser.contexts()[0].pages()[0];
   if(page){page.setDefaultTimeout(12000);await page.locator('.cm-content').waitFor();return;}
  }catch{}
  await delay(150);
 }
 throw new Error('Unable to connect to the isolated WebView2.');
}
const invoke=async(command,args={})=>{
 const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message||String(error)}};}},[command,args]);
 if(!result.ok)throw result.error;return result.value;
};
async function arrange(fields){const order=await invoke('folder_order');return invoke('arrange_folder',{action:{root:order.root,revision:order.revision,...fields}});}
function check(name){report.checks.push({name,pass:true});console.log(name);}
try{
 owner=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});report.ownerPid=owner.pid;await connect();
 expect((await invoke('get_settings')).root).toBe(notes);await expect(page.locator('.save-state')).toHaveText('已保存到本地');
 await arrange({source:'C',parent:'',anchor:'A',placement:'before'});
 const moved=await arrange({source:'A',parent:'B',placement:'inside'});expect(moved.path).toBe('B/A');expect(moved.moved).toBe(true);
 const snapshot={module:'notes',expanded:['B','B/A'],panes:[{path:'B/A/doc.md',mode:'edit',cursor:7,scroll:0}]};
 await invoke('save_snapshot',{snapshot});await page.reload();await expect(page.locator('.note-title small')).toContainText('B/A');await expect(page.locator('.cm-content')).toContainText('从新路径恢复');
 const before=await invoke('folder_order');expect(before.parents['']).toEqual(['C','B']);expect(before.parents.B).toEqual(['B/A']);report.orderBefore=before.parents;
 expect(sha256(await readFile(path.join(notes,'B/A/doc.md')))).toBe(report.fileSha256Before);check('Sorted folders and moved document restore at B/A/doc.md before hiding');

 const oldPage=page,closed=oldPage.waitForEvent('close',{timeout:75000});
 const started=performance.now();report.hideStartedAt=new Date().toISOString();
 await oldPage.locator('#hide').click();report.hideClickCompletedAfterMs=performance.now()-started;
 console.log('UI hidden; waiting for the real 60-second idle unload.');
 await closed;report.webviewClosedAt=new Date().toISOString();report.hiddenUntilPageCloseMs=performance.now()-started;
 expect(report.hiddenUntilPageCloseMs).toBeGreaterThanOrEqual(59000);expect(report.hiddenUntilPageCloseMs).toBeLessThan(75000);expect(oldPage.isClosed()).toBe(true);expect(owner.exitCode).toBeNull();
 const persisted=JSON.parse(await readFile(path.join(data,'settings.json'),'utf8'));expect(persisted.session.panes.map(pane=>pane.path)).toEqual(['B/A/doc.md']);report.persistedSession=persisted.session;
 check('The real hidden idle timer closes WebView2 while the same owning host stays alive');
 await browser?.close().catch(()=>{});browser=undefined;page=undefined;

 wake=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});report.wakeLauncherPid=wake.pid;await connect();
 await expect.poll(()=>wake.exitCode).toBe(0);expect(owner.exitCode).toBeNull();report.ownerPidAfterWake=owner.pid;
 await expect(page.locator('.note-title small')).toContainText('B/A');await expect(page.locator('.cm-content')).toContainText('从新路径恢复');await expect(page.locator('.save-state')).toHaveText('已保存到本地');
 const after=await invoke('folder_order');report.orderAfter=after.parents;expect(after.parents).toEqual(before.parents);
 expect((await invoke('get_settings')).session.panes.map(pane=>pane.path)).toEqual(['B/A/doc.md']);
 await expect.poll(()=>page.locator('.tree-row[aria-expanded]').evaluateAll(nodes=>nodes.map(node=>node.dataset.path))).toEqual(['C','B','B/A']);
 report.fileSha256After=sha256(await readFile(path.join(notes,'B/A/doc.md')));expect(report.fileSha256After).toBe(report.fileSha256Before);
 await expect(stat(path.join(notes,'A/doc.md'))).rejects.toMatchObject({code:'ENOENT'});
 check('A second launch wakes the existing host and restores folder order and the new-path session with identical file bytes');
 report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack||error);throw error;}
finally{
 if(page&&!page.isClosed()&&owner?.exitCode===null)await invoke('exit_app').catch(()=>{});
 if(owner?.exitCode===null){await delay(500);if(owner.exitCode===null)owner.kill();}
 if(wake?.exitCode===null)wake.kill();await browser?.close().catch(()=>{});report.completedAt=new Date().toISOString();
 await writeFile(reportPath,JSON.stringify(report,null,2));
}
