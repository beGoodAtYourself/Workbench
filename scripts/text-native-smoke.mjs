// Synthetic files and the textqa identity only. Does not modify the user's library or Run keys.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,stat,rename,chmod,unlink,copyFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=path.resolve(workspace,process.argv.slice(2).find(value=>value.endsWith('.exe'))??'src-tauri/target/text-editor/release/shiye-text-qa.exe');
if(!executable.startsWith(path.join(workspace,'src-tauri','target')+path.sep))throw new Error('QA executable must be inside the workspace target.');
const binary=await readFile(executable);if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('An isolated textqa build is required.');
const keepOpen=process.argv.includes('--keep-open'),skipIdle=process.argv.includes('--skip-idle');
const data=path.join(workspace,'.qa','text-native-'+Date.now()),fixtures=path.join(data,'files');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-native.json');
await mkdir(fixtures,{recursive:true});await mkdir(path.dirname(reportPath),{recursive:true});
const runningExecutable=path.join(data,'app','shiye-text-qa.exe');await mkdir(path.dirname(runningExecutable),{recursive:true});await copyFile(executable,runningExecutable);
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:fixtures,shortcut:'Control+Alt+F9',floating:false,session:{module:'text',panes:[],expanded:[]}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
const report={startedAt:new Date().toISOString(),executable,sha256:createHash('sha256').update(binary).digest('hex'),data,fixtures,port,scope:'Real release WebView2, synthetic files, QA-gated file selection; native dialogs verified separately. Real 60-second idle timer unless --skip-idle is recorded.',checks:[],pageErrors:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(name,details)=>{report.checks.push({name,pass:true,...(details===undefined?{}:{details})});console.log(name);};
let owner,browser,page;
const launch=(background=false)=>spawn(runningExecutable,background?['--autostart']:[],{env,windowsHide:true,stdio:'ignore'});
async function connect(){
 for(let attempt=0;attempt<100;attempt++){
  if(owner.exitCode!==null)throw new Error('QA process exited before its WebView was ready.');
  try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});page=browser.contexts()[0].pages()[0];if(page){page.setDefaultTimeout(12000);page.on('pageerror',error=>report.pageErrors.push(error.message));await page.locator('#nav-text').waitFor();await page.locator('.text-workspace').waitFor();return;}}catch(error){report.lastConnectionError=String(error?.message??error);}
  await delay(150);
 }
 throw new Error('Cannot connect to isolated WebView2: '+report.lastConnectionError);
}
async function invoke(command,args={}){
 const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await (window.__qaOriginalInvoke??window.__TAURI_INTERNALS__.invoke)(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message??String(error)}};}},[command,args]);
 if(!result.ok)throw result.error;return result.value;
}
async function openOne(name,bytes){const file=path.join(fixtures,name);await writeFile(file,bytes);const result=await invoke('profile_text_open',{paths:[file]});assert.equal(result.errors.length,0,JSON.stringify(result.errors));assert.equal(result.files.length,1);return result.files[0];}
const value=(file,patch={})=>({id:file.id,text:file.text,version:file.version,encoding:file.encoding,eol:file.eol,...patch});
async function ready(){await expect.poll(async()=>{const status=await invoke('profile_text_status');return status.lifecycleReady;}).toBe(true);}
async function uiHide(){await page.locator('#hide').click();await expect.poll(async()=>{const status=await invoke('profile_text_status');return !status.windowVisible&&status.lifecycleReady;}).toBe(true);}
async function exitHost(){
 await uiHide();let transportError;
 try{await invoke('exit_app');}catch(error){transportError=error;}
 await expect.poll(()=>owner.exitCode,{timeout:10000}).toBe(0);
 if(transportError){assert.match(String(transportError),/Target page, context or browser has been closed/);(report.exitConnectionClosures??=[]).push({ownerPid:owner.pid,exitCode:owner.exitCode,error:String(transportError)});}
}
try{
 owner=launch();report.ownerPid=owner.pid;await connect();
 const text='中文 😊\nsecond line\n';
 const little=Buffer.from(text.replaceAll('\n','\r\n'),'utf16le'),big=Buffer.from(little);big.swap16();
 for(const [name,bytes,encoding,eol] of [
  ['普通 文本.txt',Buffer.from(text),'utf8','lf'],
  ['BOM中文.txt',Buffer.from('\uFEFF'+text.replaceAll('\n','\r\n')),'utf8-bom','crlf'],
  ['UTF16LE.txt',Buffer.concat([Buffer.from([255,254]),little]),'utf16le','crlf'],
  ['UTF16BE.txt',Buffer.concat([Buffer.from([254,255]),big]),'utf16be','crlf']
 ]){
  const file=await openOne(name,bytes);assert.equal(file.text,text);assert.equal(file.encoding,encoding);assert.equal(file.eol,eol);
  const before=await stat(file.path);const saved=await invoke('text_save',{value:value(file)});assert.equal(saved.version,file.version);assert.deepEqual(await readFile(file.path),bytes);assert.equal((await stat(file.path)).mtimeMs,before.mtimeMs);await invoke('text_close',{id:file.id});check('Strict encoding, BOM and no-op byte preservation: '+encoding+'/'+eol);
 }
 const invalid=path.join(fixtures,'invalid.txt');await writeFile(invalid,Buffer.from([0xc3,0x28]));let result=await invoke('profile_text_open',{paths:[invalid]});assert.equal(result.files.length,0);assert.equal(result.errors[0].code,'encoding');assert.deepEqual(await readFile(invalid),Buffer.from([0xc3,0x28]));check('Invalid UTF-8 cannot become a writable replacement-character document');
 const binaryFile=path.join(fixtures,'binary.bin');await writeFile(binaryFile,Buffer.from('MZ\x00\x01'));result=await invoke('profile_text_open',{paths:[binaryFile]});assert.equal(result.files.length,0);check('Binary input is rejected without modifying bytes');
 const huge=path.join(fixtures,'over-limit.log');await writeFile(huge,Buffer.alloc(16*1024*1024+1,97));result=await invoke('profile_text_open',{paths:[huge]});assert.equal(result.files.length,0);assert.equal(result.errors[0].code,'large-limit');check('16 MiB raw input boundary rejects a complete oversized file');
 await assert.rejects(invoke('text_read',{id:'forged-id'}),{code:'authorization'});await assert.rejects(invoke('profile_text_open',{paths:[path.join(workspace,'README.md')]}),{code:'profile'});check('Unknown grant IDs and fixture-root escapes are rejected');
 let file=await openOne('转换.txt',Buffer.from('hello\n中文\n'));const changed=await invoke('text_save',{value:value(file,{text:'修改 😊\n',encoding:'utf16be',eol:'crlf'})});assert.equal(changed.encoding,'utf16be');const expected=Buffer.from('修改 😊\r\n','utf16le');expected.swap16();assert.deepEqual(await readFile(file.path),Buffer.concat([Buffer.from([254,255]),expected]));await invoke('text_close',{id:file.id});check('Explicit UTF-16 BE/CRLF conversion produces exact expected bytes');
 file=await openOne('冲突.txt',Buffer.from('baseline'));await writeFile(file.path,'external writer');await assert.rejects(invoke('text_save',{value:value(file,{text:'local draft'})}),{code:'conflict'});assert.equal(await readFile(file.path,'utf8'),'external writer');await invoke('text_close',{id:file.id});check('External byte changes prevent stale writes and preserve external content');
 file=await openOne('身份.txt',Buffer.from('same bytes'));const replacement=file.path+'.new';await writeFile(replacement,'same bytes');await rename(replacement,file.path);await assert.rejects(invoke('text_read',{id:file.id}),{code:'identity'});await assert.rejects(invoke('text_save',{value:value(file,{text:'overwrite'})}),{code:'identity'});await invoke('text_close',{id:file.id});check('Atomic external replacement invalidates the old file identity');
 file=await openOne('只读.txt',Buffer.from('readonly original'));await chmod(file.path,0o444);try{await assert.rejects(invoke('text_save',{value:value(file,{text:'must fail'})}));assert.equal(await readFile(file.path,'utf8'),'readonly original');}finally{await chmod(file.path,0o666);}await invoke('text_close',{id:file.id});check('Read-only save failure leaves original bytes intact');
 file=await openOne('删除.txt',Buffer.from('exists'));await unlink(file.path);await assert.rejects(invoke('text_save',{value:value(file,{text:'must not recreate'})}));await assert.rejects(stat(file.path),{code:'ENOENT'});await invoke('text_close',{id:file.id});check('Deleted originals are never automatically recreated by save');
 file=await openOne('混合.txt',Buffer.from('a\r\nb\nc\r'));assert.equal(file.eol,'mixed');await assert.rejects(invoke('text_save',{value:value(file,{text:file.text+'d'})}),{code:'eol'});await invoke('text_close',{id:file.id});check('Mixed/CR line endings require explicit normalization before writing');
 const target=path.join(fixtures,'另存 目标.txt');await writeFile(target,'existing');await assert.rejects(invoke('profile_text_save_as',{value:{id:'qa-new',text:'new',version:'',encoding:'utf8',eol:'crlf'},path:target,overwrite:false}),{code:'exists'});assert.equal(await readFile(target,'utf8'),'existing');check('Save As without overwrite approval never replaces an existing target');
 const opened=path.join(fixtures,'UI原文件.json');await writeFile(opened,'{"original":true}\n');await invoke('profile_text_queue_open',{paths:[opened]});await page.getByRole('button',{name:'打开文本文件',exact:true}).click();await expect(page.locator('.text-pane .cm-content')).toContainText('original');
 await page.locator('.text-pane .cm-content').fill('{"draft":"尚未写回"}\n');await ready();assert.equal(await readFile(opened,'utf8'),'{"original":true}\n');check('Real UI edits checkpoint locally without modifying the source file');
 await page.getByRole('button',{name:'保存文本',exact:true}).click();await expect(page.locator('.text-document-state')).toContainText('已保存到原文件');assert.equal(await readFile(opened,'utf8'),'{"draft":"尚未写回"}\n');check('Explicit real UI save writes the full original file');
 await page.locator('.text-pane .cm-content').fill('{"newest":"恢复后仍未保存"}\n');await page.getByRole('button',{name:'新建文本',exact:true}).click();await page.locator('.text-pane .cm-content').fill('未命名草稿：中文 😊\n');await page.getByRole('button',{name:'双视图',exact:true}).click();await ready();
 const before=await invoke('text_restore');assert.equal(before.documents.length,2);assert.equal((await invoke('profile_text_status')).residentBodyBytes,0);
 await page.getByRole('button',{name:'笔记管理',exact:true}).click();await page.getByRole('button',{name:'文本编辑',exact:true}).click();await expect(page.locator('.text-pane')).toHaveCount(2);check('Module switching preserves dirty/untitled sessions and at most two mounted editors');
 await page.screenshot({path:path.join(workspace,'docs','verification','text-editor-native-split.png')});
 const snapshot=await invoke('text_restore');const originalDoc=snapshot.documents.find(doc=>doc.path===opened);assert.ok(originalDoc);await assert.rejects(invoke('rename_entry',{path:path.basename(opened),name:'should-not-move.json'}),{code:'text-owned'});assert.ok(await stat(opened));check('Note file operations cannot rename a path occupied by the text module');
 const current=await invoke('profile_text_status');await invoke('text_invalidate',{generation:current.generation+1});await assert.rejects(invoke('hide_window'),{code:'text-recovery'});await invoke('text_checkpoint',{value:{...snapshot,generation:current.generation+1}});check('The host rejects a stale lifecycle confirmation and accepts a matching complete checkpoint');
 // The UI must learn the host generation used in the deliberate stale-ACK test.
 await page.reload();await expect(page.locator('.text-pane')).toHaveCount(2);await ready();
 if(!skipIdle){
  const old=page,closed=old.waitForEvent('close',{timeout:75000}),start=performance.now();await old.locator('#hide').click();console.log('Waiting for the real 60-second hidden unload.');await closed;report.hiddenUnloadMs=performance.now()-start;assert.ok(report.hiddenUnloadMs>=59000);assert.equal(owner.exitCode,null);await browser.close().catch(()=>{});browser=undefined;
  const wake=launch();await connect();await expect.poll(()=>wake.exitCode).toBe(0);await expect(page.locator('.text-pane')).toHaveCount(2);await expect(page.locator('.text-panes')).toContainText('恢复后仍未保存');await expect(page.locator('.text-panes')).toContainText('未命名草稿');assert.equal(await readFile(opened,'utf8'),'{"draft":"尚未写回"}\n');check('A real 60-second WebView unload and same-host wake restore dirty and untitled drafts without saving originals');
 }else report.idleSkipped=true;
  await exitHost();await browser.close().catch(()=>{});browser=undefined;owner=launch();await connect();await expect(page.locator('.text-panes')).toContainText('未命名草稿');await expect(page.locator('.text-panes')).toContainText('恢复后仍未保存');check('Normal exit and a new host process restore the latest complete recovery generation');
  await exitHost();await browser.close().catch(()=>{});browser=undefined;owner=launch(true);await delay(2000);assert.equal(owner.exitCode,null);
 const inspect=async()=>JSON.parse((await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(workspace,'scripts','startup-native-probe.ps1'),'-Action','process','-OwnerProcessId',String(owner.pid)],{windowsHide:true})).stdout.trim());
 const background=await inspect();assert.equal(background.children.some(item=>item.name.toLowerCase().includes('msedgewebview2')),false);assert.equal(background.windows.some(item=>item.visible&&item.width>200&&item.height>100),false);
 const repeated=launch(true);await expect.poll(()=>repeated.exitCode).toBe(0);const repeatedState=await inspect();assert.equal(repeatedState.children.some(item=>item.name.toLowerCase().includes('msedgewebview2')),false);report.background={ownerPid:owner.pid,initial:background,repeated:repeatedState};check('Background and repeated --autostart launches keep text recovery metadata without creating a main WebView');
 const manual=launch();await expect.poll(()=>manual.exitCode).toBe(0);await connect();await expect(page.locator('.text-pane')).toHaveCount(2);await expect(page.locator('.text-panes')).toContainText('未命名草稿');await expect(page.locator('.text-panes')).toContainText('恢复后仍未保存');assert.equal(await readFile(opened,'utf8'),'{"draft":"尚未写回"}\n');await uiHide();check('A manual second launch wakes the background owner and first restores its dirty and untitled text sessions');
 assert.equal(report.pageErrors.length,0,report.pageErrors.join('\n'));report.status='passed';
 if(keepOpen){await writeFile(path.join(workspace,'.qa','text-native-current.json'),JSON.stringify({executable:runningExecutable,data,fixtures,port,pid:owner.pid,reportPath},null,2));owner.unref();report.keptOpenForDialogs=true;}
}catch(error){report.status='failed';report.error=String(error?.stack??JSON.stringify(error));throw error;}
finally{
 if(!keepOpen||report.status!=='passed'){if(page&&!page.isClosed()&&owner?.exitCode===null)await invoke('exit_app').catch(()=>{});if(owner?.exitCode===null){await delay(300);if(owner.exitCode===null)owner.kill();}}
 await browser?.close().catch(()=>{});report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));
}
