// Manual Sky handshakes supply the real shortcut and floating-window input. This script never injects Win32 input.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skipNativeInput=process.argv.includes('--skip-native-input');
const source=path.resolve(workspace,process.argv.slice(2).find(value=>value.endsWith('.exe'))??'src-tauri/target/text-editor/qa/shiye-text-qa.exe');
const inside=(root,target)=>{const relative=path.relative(root,path.resolve(target));return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
if(!inside(path.join(workspace,'src-tauri','target'),source))throw new Error('Only a QA executable inside this workspace target is allowed.');
const binary=await readFile(source),hash=value=>createHash('sha256').update(value).digest('hex');
if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('An isolated textqa application identity is required.');
const data=path.join(workspace,'.qa','text-shell-native-'+Date.now()),fixtures=path.join(data,'files'),executable=path.join(data,'app','shiye-text-qa.exe');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-shell.json'),coordinationPath=path.join(workspace,'.qa','text-shell-current.json');
for(const directory of [fixtures,path.dirname(executable),path.dirname(reportPath)])await mkdir(directory,{recursive:true});await copyFile(source,executable);
const note='# 系统入口隔离验收\n\n只用于本次合成测试，没有个人资料。\n';await writeFile(path.join(fixtures,'验收笔记.md'),note);
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:fixtures,shortcut:'Control+Alt+F10',floating:true,session:{module:'text',panes:[{path:'验收笔记.md',mode:'edit',cursor:0,scroll:0}],expanded:[]}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const report={startedAt:new Date().toISOString(),source,sha256:hash(binary),executable,data,fixtures,port,nativeInputSkipped:skipNativeInput,scope:'Isolated textqa release WebView2 and synthetic notes/drafts. '+(skipNativeInput?'Native hotkey/floating input is explicitly skipped because of recorded Sky tool restrictions; only module switches, settings saves and normal exit are exercised.':'Root must use Sky for the real Control+Alt+F10 and the floating window belonging to ownerPid.')+' No raw Win32 input injection, autostart changes, personal notes or system clipboard reads.',checks:[],skippedChecks:[{name:'Live system clipboard entry, listener pause and DOM disposal after leaving clipboard',reason:'Intentionally not opened because the native module would read the personal system clipboard. Only its unused DOM is checked empty; browser-demo regressions and source review cover the separate listener/disposal paths.'}],pageErrors:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),HANDSHAKE_TIMEOUT=55000;
function check(name,details){report.checks.push({name,pass:true,...(details===undefined?{}:{details})});console.log(name);}
async function command(program,args){const child=spawn(program,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)throw new Error(program+' failed ('+code+'): '+stderr);return stdout.trim();}
const existing=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='shiye-text-qa.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"]),instances=existing?JSON.parse(existing):[],running=Array.isArray(instances)?instances:instances?[instances]:[];
if(running.length){report.status='blocked';report.existingInstances=running;report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));throw new Error('Another textqa owner is running. Refusing to launch, attach or terminate any existing owner.');}

let owner,browser,page,coordination;
async function connect(){let last;for(let attempt=0;attempt<100;attempt++){
 if(owner.exitCode!==null)throw new Error('The isolated launcher exited before its own WebView2 attached.');
 try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});page=browser.contexts()[0].pages()[0];if(!page)throw new Error('No WebView page yet.');page.setDefaultTimeout(12000);page.on('pageerror',error=>report.pageErrors.push(error.message));await page.locator('#text-workspace').waitFor();await expect(page.getByRole('button',{name:'新建文本',exact:true})).toBeEnabled();return;}
 catch(error){last=error;await browser?.close().catch(()=>{});browser=undefined;await delay(150);}
}throw new Error('Cannot attach to the isolated WebView2: '+last);}
async function invoke(command,args={}){const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message??String(error)}};}},[command,args]);if(!result.ok)throw result.error;return result.value;}
async function ready(){await expect.poll(async()=>{const status=await invoke('profile_text_status');return status.lifecycleReady&&status.generation===status.confirmedGeneration;},{timeout:15000}).toBe(true);}
async function bodies(){const snapshot=await invoke('text_restore');return {snapshot,hashes:Object.fromEntries(await Promise.all(snapshot.documents.map(async doc=>[doc.id,hash(await invoke('text_recover',{id:doc.id}))])))};}
async function settings(){await page.locator('#settings').click();await expect(page.getByRole('dialog')).toBeVisible();return page.getByRole('dialog');}
async function updateSettings(shortcut,floating){const dialog=await settings();await dialog.getByLabel('全局快捷键',{exact:true}).fill(shortcut);await dialog.getByLabel('显示桌面悬浮入口',{exact:true}).setChecked(floating);await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog).toHaveCount(0);const actual=await invoke('get_settings');assert.equal(actual.shortcut,shortcut);assert.equal(actual.floating,floating);return actual;}
async function hideAndWait(stage,baseline){
 await ready();await page.locator('#hide').click();await expect.poll(async()=>(await invoke('profile_text_status')).windowVisible).toBe(false);
 const started=Date.now();report.status=stage;coordination={status:stage,ownerPid:owner.pid,pid:owner.pid,executable,source,sha256:report.sha256,data,fixtures,port,reportPath,shortcut:'Control+Alt+F10',timeoutMs:HANDSHAKE_TIMEOUT,waitStartedAt:new Date(started).toISOString(),deadline:new Date(started+HANDSHAKE_TIMEOUT).toISOString(),documentIds:baseline.snapshot.documents.map(doc=>doc.id),bodySha256:baseline.hashes,instructions:stage==='awaiting-native-hotkey'?'Root: press the real Control+Alt+F10 with Sky. Do not show the app by CDP or another launch.':'Root: click the real floating window belonging only to ownerPid with Sky. Do not use a different app copy.'};
 await writeFile(coordinationPath,JSON.stringify(coordination,null,2));await writeFile(reportPath,JSON.stringify(report,null,2));console.log((stage==='awaiting-native-hotkey'?'NATIVE_HOTKEY_WAIT ':'NATIVE_FLOATING_WAIT ')+JSON.stringify(coordination));
 // This test intentionally keeps each handshake below the production 60-second idle unload.
 // It does not reset the idle timer or call a show/wake command on the operator's behalf.
 await expect.poll(async()=>(await invoke('profile_text_status')).windowVisible,{timeout:HANDSHAKE_TIMEOUT,intervals:[200,500,1000],message:'Waiting for the real Sky input before the production 60-second idle deadline.'}).toBe(true);
 await expect(page.locator('#text-workspace')).toBeVisible();await expect(page.locator('.text-pane')).toHaveCount(2);await expect(page.locator('.text-panes')).toContainText('入口草稿 A');await expect(page.locator('.text-panes')).toContainText('入口草稿 B');await expect(page.locator('.cm-editor')).toHaveCount(2);await ready();
 const restored=await bodies();assert.deepEqual(restored.snapshot.documents.map(doc=>doc.id),baseline.snapshot.documents.map(doc=>doc.id));assert.deepEqual(restored.hashes,baseline.hashes);assert.equal(owner.exitCode,null);assert.equal(await readFile(path.join(fixtures,'验收笔记.md'),'utf8'),note);coordination.status=stage+'-completed';coordination.completedAt=new Date().toISOString();await writeFile(coordinationPath,JSON.stringify(coordination,null,2));
 check(stage==='awaiting-native-hotkey'?'A real global shortcut wakes the hidden owner and preserves both complete dirty drafts':'A real click on the owned floating window wakes the hidden owner and preserves both complete dirty drafts',{ownerPid:owner.pid,wakeMs:Date.now()-started,documentIds:restored.snapshot.documents.map(doc=>doc.id),bodySha256:restored.hashes});
}
const transportClosed=error=>error instanceof Error&&/(?:page\.evaluate|locator\.click): Target (?:page, context or browser has been closed|closed)/.test(error.message);
async function cleanup(){
 if(owner?.exitCode===null){
  try{
   await ready();try{await invoke('exit_app');}catch(error){if(!transportClosed(error))throw error;report.cleanupTransportClosed=String(error);}
   await expect.poll(()=>owner.exitCode,{timeout:10000}).not.toBeNull();assert.equal(owner.exitCode,0);report.cleanupMode='normal-after-failure';
  }catch(error){report.cleanupExitError=String(error);assert.equal(path.resolve(owner.spawnfile).toLowerCase(),executable.toLowerCase());if(owner.exitCode===null)await command('taskkill.exe',['/PID',String(owner.pid),'/T','/F']);await expect.poll(()=>owner.exitCode,{timeout:10000}).not.toBeNull();report.cleanupMode='forced-own-process';report.status='failed';process.exitCode=1;}
 }
 await browser?.close().catch(()=>{});
}

try{
 const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};owner=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});report.ownerPid=owner.pid;await connect();
 for(const label of ['入口草稿 A 中文 😀','入口草稿 B 未保存']){await page.getByRole('button',{name:'新建文本',exact:true}).click();await page.locator('#text-workspace .cm-content').fill(label);}await page.getByRole('button',{name:'双视图',exact:true}).click();await expect(page.locator('.cm-editor')).toHaveCount(2);await ready();const baseline=await bodies();assert.equal(baseline.snapshot.documents.length,2);assert.ok(baseline.snapshot.documents.every(doc=>doc.path===null&&doc.revision!==doc.savedRevision));
 await page.locator('#nav-notes').click();await expect(page.locator('.note-pane .cm-editor')).toHaveCount(1);await expect(page.locator('.cm-editor')).toHaveCount(1);await page.locator('#nav-text').click();await expect(page.locator('.text-pane .cm-editor')).toHaveCount(2);await expect(page.locator('.cm-editor')).toHaveCount(2);assert.equal(await page.locator('#clipboard').evaluate(element=>element.childElementCount),0);
 check('Text and notes module switches mount only their active editors (two and one); the never-opened clipboard DOM remains empty',{textEditors:2,noteEditors:1,clipboardOpened:false});
 const interim=await updateSettings('Control+Shift+F11',false),active=await updateSettings('Control+Alt+F10',true);check('Real settings saves update floating/shortcut preferences and restore the exact bindings used for Sky handshakes',{interim:{shortcut:interim.shortcut,floating:interim.floating},active:{shortcut:active.shortcut,floating:active.floating}});
 if(skipNativeInput){
  report.skippedChecks.push({name:'A real global shortcut wakes the hidden owner and preserves both complete dirty drafts',reason:'Explicit --skip-native-input: the previous Sky input did not complete; selecting the neutral Calculator target then failed with Computer Use app approval timed out. No actual global-key input is confirmed. The failed attempt is retained as text-editor-shell-sky-timeout-339eb9.json.'},{name:'A real click on the owned floating window wakes the hidden owner and preserves both complete dirty drafts',reason:'Explicit --skip-native-input: Sky list_apps/list_windows did not expose the native tool/no-activate floating window. The supported API has no include-tool-window option or desktop-coordinate input. No Window is fabricated and no click is claimed.'});
  coordination={status:'native-input-skipped',ownerPid:owner.pid,pid:owner.pid,executable,source,sha256:report.sha256,data,fixtures,port,nativeInputSkipped:true};await writeFile(coordinationPath,JSON.stringify(coordination,null,2));
 }else{await hideAndWait('awaiting-native-hotkey',baseline);await hideAndWait('awaiting-native-floating',baseline);}
 const exitDialog=await settings();let exitClickError;try{await exitDialog.locator('#settings-exit').click();}catch(error){if(!transportClosed(error))throw error;exitClickError=String(error);}await expect.poll(()=>owner.exitCode,{timeout:15000}).not.toBeNull();assert.equal(owner.exitCode,0);report.normalExit=true;if(exitClickError)report.exitConnectionClosed=exitClickError;
 const processOutput=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@(Get-CimInstance Win32_Process -Filter 'ProcessId=${owner.pid}' | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`]),processes=processOutput?JSON.parse(processOutput):[],entries=Array.isArray(processes)?processes:processes?[processes]:[];assert.ok(!entries.some(item=>typeof item.ExecutablePath==='string'&&path.resolve(item.ExecutablePath).toLowerCase()===executable.toLowerCase()));
 check('Settings Exit ends the isolated floating/shortcut owner normally; that owned process no longer exists',{ownerPid:owner.pid,exitCode:owner.exitCode});assert.equal(report.pageErrors.length,0,report.pageErrors.join('\n'));report.status=skipNativeInput?'partial':'passed';
}catch(error){report.status='failed';report.error=String(error?.stack??JSON.stringify(error));throw error;}
finally{await cleanup().catch(error=>{report.cleanupError=String(error);report.status='failed';process.exitCode=1;});report.ownerExited=!!owner&&owner.exitCode!==null;report.ownerExitCode=owner?.exitCode??null;report.completedAt=new Date().toISOString();if(coordination){coordination.status=report.status;coordination.ownerExited=report.ownerExited;coordination.harnessCompletedAt=report.completedAt;await writeFile(coordinationPath,JSON.stringify(coordination,null,2));}await writeFile(reportPath,JSON.stringify(report,null,2));}
