// Run only after the performance harness releases textqa. Synthetic files and real UI only.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(workspace,process.argv.slice(2).find(value=>value.endsWith('.exe'))??'src-tauri/target/text-editor/qa/shiye-text-qa.exe');
const inside=(root,target)=>{const relative=path.relative(root,path.resolve(target));return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
if(!inside(path.join(workspace,'src-tauri','target'),source))throw new Error('Only a QA executable within this workspace target is allowed.');
const binary=await readFile(source),hash=value=>createHash('sha256').update(value).digest('hex');
if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('The isolated textqa application identity is required.');
const data=path.join(workspace,'.qa','text-links-native-'+Date.now()),fixtures=path.join(data,'files'),notes=path.join(fixtures,'notes'),outside=path.join(fixtures,'other','Outside.md'),executable=path.join(data,'app','shiye-text-qa.exe');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-links.json');
for(const directory of [notes,path.dirname(outside),path.dirname(executable),path.dirname(reportPath)])await mkdir(directory,{recursive:true});
await copyFile(source,executable);
const fixtureContent={
 'notes/A.md':'# 原生链接 A\n\n[打开 B](B.md)\n',
 'notes/B.md':'# 原生链接 B\n\n[打开 C](C.md)\n\n[越出笔记库](../other/Outside.md)\n\n[非笔记类型](config.txt)\n\n[不支持的协议]('+pathToFileURL(outside).href+')\n',
 'notes/C.md':'# C 原文件\n\n打开文本模块不会改变原始字节。\n',
 'notes/config.txt':'This authorized text file must not open through a Markdown link.\n',
 'other/Outside.md':'# 已授权的库外文本\n\n文本授权不会扩大笔记链接边界。\n'
};
for(const [name,text] of Object.entries(fixtureContent))await writeFile(path.join(fixtures,name),text);
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:notes,shortcut:'Control+Alt+F10',floating:false,session:{module:'notes',panes:[{path:'A.md',mode:'preview',cursor:0,scroll:0}],expanded:[]}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const report={startedAt:new Date().toISOString(),source,sha256:hash(binary),executable,data,fixtures,notes,port,scope:'Isolated textqa release WebView2 with synthetic A/B/C notes and authorized synthetic outside/non-Markdown files. Normal Open uses the double-gated fixture queue; links use real preview and editor mouse gestures. No production source changes, user notes, clipboard or Run-key modifications.',checks:[],pageErrors:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(name,details){report.checks.push({name,pass:true,...(details===undefined?{}:{details})});console.log(name);}
async function command(program,args){const child=spawn(program,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)throw new Error(program+' failed ('+code+'): '+stderr);return stdout.trim();}
const existing=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='shiye-text-qa.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"]),instances=existing?JSON.parse(existing):[],running=Array.isArray(instances)?instances:instances?[instances]:[];
if(running.length){report.status='blocked';report.existingInstances=running;report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));throw new Error('Another textqa owner is running; refusing to attach, wake or terminate it.');}

let owner,browser,page;
async function connect(){let last;for(let attempt=0;attempt<100;attempt++){
 if(owner.exitCode!==null)throw new Error('The isolated launcher exited before its own WebView2 became ready.');
 try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});page=browser.contexts()[0].pages()[0];if(!page)throw new Error('No WebView page yet.');page.setDefaultTimeout(12000);page.on('pageerror',error=>report.pageErrors.push(error.message));await expect(page.getByRole('heading',{name:'原生链接 A',exact:true})).toBeVisible();await expect(page.locator('#app')).toHaveJSProperty('inert',false);return;}
 catch(error){last=error;await browser?.close().catch(()=>{});browser=undefined;await delay(150);}
}throw new Error('Cannot attach to the isolated WebView2: '+last);}
async function invoke(command,args={}){const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message??String(error)}};}},[command,args]);if(!result.ok)throw result.error;return result.value;}
async function ready(){await expect.poll(async()=>{const status=await invoke('profile_text_status');return status.lifecycleReady&&status.generation===status.confirmedGeneration;},{timeout:15000}).toBe(true);}
async function fixtureHashes(){return Object.fromEntries(await Promise.all(Object.keys(fixtureContent).map(async name=>[name,hash(await readFile(path.join(fixtures,name)))])));}
const editor=()=>page.locator('#text-workspace .cm-content').first();
const text=()=>editor().locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
const titles=()=>page.locator('.note-pane .note-title strong').allTextContents();
async function notesLayout(){await expect(page.locator('#panes')).toBeVisible();await expect(page.locator('.note-pane')).toHaveCount(2);assert.deepEqual(await titles(),['A','B']);}
async function queueOpen(names){await invoke('profile_text_queue_open',{paths:names.map(name=>path.join(fixtures,name))});await page.getByRole('button',{name:'打开文本文件',exact:true}).click();await expect(page.getByRole('tab')).toHaveCount(names.length);}
async function assertTextOwner(id,ids,body){await expect(page.locator('#text-workspace')).toBeVisible();await expect(page.getByRole('tab',{name:/C\.md$/})).toHaveAttribute('aria-selected','true');assert.equal(await text(),body);await expect(page.locator('.text-document-state')).toContainText('未保存到原文件');await ready();const value=await invoke('text_restore');assert.deepEqual(value.documents.map(doc=>doc.id),ids);const doc=value.documents.find(doc=>doc.id===id);assert.ok(doc&&doc.revision!==doc.savedRevision);assert.equal(await invoke('text_recover',{id}),body);}
async function stop(){if(owner?.exitCode===null){try{await ready();let transportError;try{await invoke('exit_app');}catch(error){transportError=error;}await expect.poll(()=>owner.exitCode,{timeout:10000}).toBe(0);if(transportError){assert.match(String(transportError),/Target page, context or browser has been closed/);report.exitConnectionClosure={ownerPid:owner.pid,exitCode:owner.exitCode,error:String(transportError)};}report.exitMode='normal';}catch(error){report.normalExitError=String(error);assert.equal(path.resolve(owner.spawnfile).toLowerCase(),executable.toLowerCase());if(owner.exitCode===null)await command('taskkill.exe',['/PID',String(owner.pid),'/T','/F']);await expect.poll(()=>owner.exitCode,{timeout:10000}).not.toBeNull();report.exitMode='forced-cleanup';}}else if(owner)assert.equal(owner.exitCode,0);await browser?.close().catch(()=>{});}

try{
 const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};owner=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});report.ownerPid=owner.pid;await connect();const initialHashes=await fixtureHashes();
 await page.locator('#nav-text').click();await queueOpen(['notes/C.md','other/Outside.md','notes/config.txt']);await page.getByRole('tab',{name:/C\.md$/}).click();const dirtyBody='# C 尚未保存的文本\n\n跨模块链接必须复用这份正文。';await editor().fill(dirtyBody);await ready();const before=await invoke('text_restore'),c=before.documents.find(doc=>doc.name==='C.md'),ids=before.documents.map(doc=>doc.id);assert.ok(c);assert.deepEqual(await fixtureHashes(),initialHashes);
 const probed=await invoke('text_read',{id:c.id,knownVersion:c.version});assert.equal(probed.kind,'unchanged');assert.equal(probed.id,c.id);assert.equal(probed.version,c.version);assert.equal('text' in probed,false);assert.equal('file' in probed,false);const legacy=await invoke('text_read',{id:c.id});assert.equal('kind' in legacy,false);assert.equal(legacy.text,fixtureContent['notes/C.md']);assert.equal(legacy.version,c.version);check('Real Tauri text_read accepts optional knownVersion, omits an unchanged original body, and preserves the legacy full TextFile wire shape');
 await page.locator('#nav-notes').click();await page.getByRole('link',{name:'打开 B',exact:true}).click();await notesLayout();
 await page.locator('.note-pane').nth(1).getByRole('link',{name:'打开 C',exact:true}).click();await assertTextOwner(c.id,ids,dirtyBody);await page.locator('#nav-notes').click();await notesLayout();assert.deepEqual(await fixtureHashes(),initialHashes);
 check('A real preview-link click activates the existing dirty C text owner, preserves all text IDs and original bytes, and returns to the unchanged A | B notes layout',{textDocumentId:c.id,textDocumentIds:ids,sourcePaths:['A.md','B.md'],originalHashes:initialHashes});

 const sourcePane=page.locator('.note-pane').nth(1);await sourcePane.getByRole('button',{name:'编辑模式',exact:true}).click();const sourceLink=sourcePane.locator('.cm-line').getByText('打开 C',{exact:true});await sourceLink.click();await notesLayout();await expect(page.locator('#text-workspace')).toBeHidden();
 check('An ordinary editor-link click only positions the cursor and leaves the A | B notes module active');
 await sourceLink.click({modifiers:['Control']});await assertTextOwner(c.id,ids,dirtyBody);await page.locator('#nav-notes').click();await notesLayout();await expect(page.locator('.note-pane').nth(1).locator('.cm-content')).toContainText('[打开 C](C.md)');assert.deepEqual(await fixtureHashes(),initialHashes);
 check('A real Ctrl+click activates the same dirty C text owner and returning preserves the source B editor mode and A | B layout');

 await page.locator('.note-pane').nth(1).getByRole('button',{name:'显示模式',exact:true}).click();
 for(const [name,message] of [['越出笔记库','超出'],['非笔记类型','Markdown'],['不支持的协议','不支持']]){
  await page.locator('.note-pane').nth(1).getByRole('link',{name,exact:true}).click();await expect(page.locator('#toast')).toContainText(message);await notesLayout();await expect(page.locator('#text-workspace')).toBeHidden();assert.deepEqual((await invoke('text_restore')).documents.map(doc=>doc.id),ids);assert.deepEqual(await fixtureHashes(),initialHashes);
  check('The '+name+' note link is refused without widening the boundary despite existing text authorization');
 }
 assert.equal(report.pageErrors.length,0,report.pageErrors.join('\n'));report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack??JSON.stringify(error));process.exitCode=1;}
finally{await stop().catch(error=>{report.cleanupError=String(error);report.status='failed';process.exitCode=1;});if(report.normalExitError){report.status='failed';process.exitCode=1;}report.ownerExited=!!owner&&owner.exitCode!==null;report.ownerExitCode=owner?.exitCode??null;report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));}
