// Isolated release WebView2 failure checks. Never reads the user's notes or recovery directory.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,readdir,lstat,open,unlink,statfs} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(workspace,process.argv.slice(2).find(value=>value.endsWith('.exe'))??'src-tauri/target/text-editor/release/shiye-text-qa.exe');
const inside=(root,target)=>{const relative=path.relative(root,path.resolve(target));return !!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
if(!inside(path.join(workspace,'src-tauri','target'),source))throw new Error('The executable must be a QA build inside this workspace target directory.');
const binary=await readFile(source),sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('The isolated textqa application identity is required.');
const base=path.join(workspace,'.qa','text-recovery-native-'+Date.now()),runningExecutable=path.join(base,'app','shiye-text-qa.exe');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-recovery.json'),DISK_LIMIT=128*1024*1024;
await mkdir(path.dirname(runningExecutable),{recursive:true});await mkdir(path.dirname(reportPath),{recursive:true});await copyFile(source,runningExecutable);
const report={startedAt:new Date().toISOString(),source,sha256:sha256(binary),executable:runningExecutable,base,configuration:'Isolated textqa release identity, synthetic notes, SHIYE_DATA_DIR and both SHIYE_PROFILE / SHIYE_TEXT_TEST_ROOT gates. Forces only this harness-owned process tree. Quota uses one bounded synthetic file, not real disk exhaustion.',clipboardIsolation:'The harness returns synthetic empty content for read_clipboard and suppresses watch_clipboard(true), so it neither reads nor writes the user clipboard. Clipboard assertions cover module-shell availability, not the native listener.',checks:[],pageErrors:[],scenarios:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(name,details){report.checks.push({name,pass:true,...(details===undefined?{}:{details})});console.log(name);}
async function command(executable,args,options={}){
 const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});let stdout='',stderr='';
 child.stdout?.setEncoding('utf8');child.stdout?.on('data',value=>stdout+=value);child.stderr?.setEncoding('utf8');child.stderr?.on('data',value=>stderr+=value);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 if(code!==0)throw new Error(executable+' failed ('+code+'): '+stderr.trim());return stdout.trim();
}
// Another textqa instance would share the Win32 single-instance identity, regardless of its directory.
const existing=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='shiye-text-qa.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"]);
const instances=existing?JSON.parse(existing):[],running=Array.isArray(instances)?instances:instances?[instances]:[];
if(running.length){report.status='blocked';report.existingInstances=running;report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));throw new Error('Another textqa instance is running. Refusing to reuse or terminate a process not owned by this harness.');}

let current,lockProcess,paddingFile;
async function makeScenario(name){
 const data=path.join(base,name),fixtures=path.join(data,'files'),recovery=path.join(data,'text-recovery');await mkdir(fixtures,{recursive:true});
 await writeFile(path.join(fixtures,'验证笔记.md'),'# 恢复故障隔离笔记\n\n只用于这个验收目录。\n');
 await writeFile(path.join(data,'settings.json'),JSON.stringify({root:fixtures,shortcut:'Control+Alt+F10',floating:false,session:{module:'text',panes:[{path:'验证笔记.md',mode:'preview',cursor:0,scroll:0}],expanded:[]}}));
 const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const scenario={name,data,fixtures,recovery,port,manifest:path.join(recovery,'manifest.json'),pids:[]};report.scenarios.push(scenario);return scenario;
}
async function start(scenario){
 const env={...process.env,SHIYE_DATA_DIR:scenario.data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:scenario.fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+scenario.port};
 const owner=spawn(runningExecutable,[],{env,windowsHide:true,stdio:'ignore'});scenario.pids.push(owner.pid);current={scenario,owner,browser:undefined,page:undefined};
 let lastError;
 for(let attempt=0;attempt<100;attempt++){
  if(owner.exitCode!==null)throw new Error('The isolated QA owner exited before WebView2 attached.');
  try{
   const browser=await chromium.connectOverCDP('http://127.0.0.1:'+scenario.port,{timeout:1000}),page=browser.contexts()[0].pages()[0];
   if(!page){await browser.close();throw new Error('WebView2 has no page yet.');}
   current.browser=browser;current.page=page;page.setDefaultTimeout(12000);page.on('pageerror',error=>report.pageErrors.push({scenario:scenario.name,message:error.message}));
   await page.locator('#nav-text').waitFor();await page.evaluate(()=>{const internals=window.__TAURI_INTERNALS__,original=internals.invoke.bind(internals);internals.invoke=(command,args,...rest)=>{if(command==='read_clipboard')return Promise.resolve({status:'empty',text:'',truncated:false});if(command==='watch_clipboard'&&args?.enabled)return original(command,{...args,enabled:false},...rest);return original(command,args,...rest);};});return current;
  }catch(error){lastError=error;await current.browser?.close().catch(()=>{});current.browser=undefined;await delay(150);}
 }
 throw new Error('Cannot attach to isolated WebView2: '+lastError);
}
async function invoke(command,args={}){
 const result=await current.page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message??String(error)}};}},[command,args]);
 if(!result.ok)throw result.error;return result.value;
}
async function ready(){await expect.poll(async()=>{const status=await invoke('profile_text_status');return status.lifecycleReady&&status.confirmedGeneration===status.generation;},{timeout:15000}).toBe(true);}
const content=()=>current.page.locator('#text-workspace .cm-content').first();
async function createDraft(text){await current.page.locator('#nav-text').click();await current.page.getByRole('button',{name:'新建文本',exact:true}).click();await content().fill(text);await ready();const snapshot=await invoke('text_restore');assert.equal(snapshot.documents.length,1);assert.equal(await invoke('text_recover',{id:snapshot.documents[0].id}),text);return snapshot;}
async function stop(force=false){
 if(!current)return;const {owner,browser}=current;
 if(owner.exitCode===null){
  if(force){
   // This live ChildProcess was spawned from this exact copy; never enumerate or kill by process name.
   assert.equal(path.resolve(owner.spawnfile).toLowerCase(),runningExecutable.toLowerCase());
   await command('taskkill.exe',['/PID',String(owner.pid),'/T','/F']);
  }else{
   let transportError;try{await invoke('exit_app');}catch(error){transportError=error;}
   await expect.poll(()=>owner.exitCode,{timeout:10000}).toBe(0);
   if(transportError){assert.match(String(transportError),/Target page, context or browser has been closed/);(report.exitConnectionClosures??=[]).push({ownerPid:owner.pid,exitCode:owner.exitCode,error:String(transportError)});}
  }
  await expect.poll(()=>owner.exitCode,{timeout:10000}).not.toBeNull();
 }
 await browser?.close().catch(()=>{});current=undefined;
}
async function diskUsage(root){let bytes=0;for(const item of await readdir(root)){const full=path.join(root,item);assert.ok(inside(root,full));const info=await lstat(full);assert.ok(info.isFile()&&!info.isSymbolicLink(),'Only regular files are allowed in the isolated recovery directory.');bytes+=info.size;}return bytes;}
async function acquireManifestLock(target){
 assert.ok(current&&inside(current.scenario.recovery,target));
 const script="$ErrorActionPreference='Stop';$target=[Environment]::GetEnvironmentVariable('SHIYE_QA_LOCK_PATH');$handle=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{[Console]::WriteLine('LOCKED');[Console]::Out.Flush();[Console]::ReadLine() | Out-Null}finally{$handle.Dispose()}";
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,SHIYE_QA_LOCK_PATH:target}});lockProcess=child;child.stdin.on('error',()=>{});
 await new Promise((resolve,reject)=>{let output='',error='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stderr.on('data',value=>error+=value);child.stdout.on('data',value=>{output+=value;if(output.includes('LOCKED'))resolve();});child.once('error',reject);child.once('exit',code=>reject(new Error('Manifest lock helper exited ('+code+'): '+error)));});
}
async function releaseLock(){if(!lockProcess)return;const child=lockProcess;if(child.exitCode===null)child.stdin.end('\n');await expect.poll(()=>child.exitCode,{timeout:5000}).not.toBeNull();lockProcess=undefined;assert.equal(child.exitCode,0);}
async function checkpointFailure(message){await expect(current.page.locator('.text-global-error')).toBeVisible();if(message)await expect(current.page.locator('.text-global-error')).toContainText(message);await assert.rejects(invoke('hide_window'),{code:'text-recovery'});assert.equal(current.owner.exitCode,null);}
async function retryCheckpoint(){await current.page.locator('[data-text-action="checkpoint"]').click();await ready();await expect(current.page.locator('.text-global-error')).toBeHidden();}
async function fullBuffer(){const element=content();await element.focus();await element.press('Control+a');return element.evaluate(node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain').replace(/\r\n/g,'\n');});}

try{
 const crash=await makeScenario('committed-crash');await start(crash);const snapshot=await createDraft('最后完整提交：中文 😀');
 const committed=await readFile(crash.manifest),committedGeneration=snapshot.generation;
 await content().fill('未提交的新输入，应在强制结束后丢失');await stop(true);assert.deepEqual(await readFile(crash.manifest),committed,'The test must terminate before the next one-second checkpoint.');
 await start(crash);await expect(content()).toContainText('最后完整提交');await expect(content()).not.toContainText('未提交的新输入');const restored=await invoke('text_restore');assert.equal(restored.generation,committedGeneration);assert.equal(await invoke('text_recover',{id:snapshot.documents[0].id}),'最后完整提交：中文 😀');
 check('Forced termination restores only the last fully committed generation, without claiming unsaved keystrokes are durable',{generation:committedGeneration,manifestSha256:sha256(committed)});await current.page.locator('#nav-notes').click();await ready();await stop();

 const locked=await makeScenario('locked-manifest');await start(locked);const lockedState=await createDraft('锁定之前的完整草稿'),beforeLock=await readFile(locked.manifest);await acquireManifestLock(locked.manifest);
 await content().fill('清单锁定期间保留在内存的新草稿');await checkpointFailure();await expect(content()).toContainText('清单锁定期间保留在内存的新草稿');
 await releaseLock();assert.deepEqual(await readFile(locked.manifest),beforeLock);await retryCheckpoint();assert.equal(await invoke('text_recover',{id:lockedState.documents[0].id}),'清单锁定期间保留在内存的新草稿');
 check('FileShare.None manifest failure preserves memory and prior manifest, blocks hide, and succeeds after release',{beforeSha256:sha256(beforeLock),afterRetrySha256:sha256(await readFile(locked.manifest))});await stop();

 const quota=await makeScenario('quota-reservation');await start(quota);const quotaState=await createDraft('配额之前的完整草稿'),beforeQuota=await readFile(quota.manifest),usage=await diskUsage(quota.recovery),volume=await statfs(quota.recovery);
 assert.ok(volume.bavail*volume.bsize>4*DISK_LIMIT,'At least 512 MiB free space is required; this test never exhausts the real volume.');
 const paddingBytes=DISK_LIMIT-4096-usage;assert.ok(paddingBytes>0&&paddingBytes<DISK_LIMIT);paddingFile=path.join(quota.recovery,'retained-qa-quota-fill.bin');assert.ok(inside(quota.recovery,paddingFile));
 const handle=await open(paddingFile,'wx');try{await handle.truncate(paddingBytes);}finally{await handle.close();}
 let peak=await diskUsage(quota.recovery),sampling=true;const samples=[];
 const sample=(async()=>{while(sampling){const bytes=await diskUsage(quota.recovery);samples.push({at:new Date().toISOString(),bytes});peak=Math.max(peak,bytes);await delay(20);}})();
 const quotaText='配额拒绝时必须完整保留的输入。'.repeat(3000);
 try{await content().fill(quotaText);await checkpointFailure('128 MiB');assert.deepEqual(await readFile(quota.manifest),beforeQuota);assert.equal(await fullBuffer(),quotaText);}
 finally{sampling=false;await sample;assert.ok(inside(quota.recovery,paddingFile));await unlink(paddingFile);paddingFile=undefined;}
 assert.ok(peak<=DISK_LIMIT,'The recovery directory must never exceed its logical 128 MiB hard limit.');await retryCheckpoint();assert.equal(await invoke('text_recover',{id:quotaState.documents[0].id}),quotaText);
 check('Unknown retained padding participates in quota; reservation rejects atomically below 128 MiB and succeeds after removing only harness padding',{limit:DISK_LIMIT,paddingBytes,peakBytes:peak,beforeManifestSha256:sha256(beforeQuota),samples});
 const beforeMetadata=await readFile(quota.manifest),beforeMetadataStatus=await invoke('profile_text_status');
 const metadataDocuments=Array.from({length:5},(_,index)=>{const prefix='D:/synthetic-metadata-'+index+'/';return {id:'metadata-'+index,path:prefix+'x'.repeat(32760-prefix.length),name:'metadata-'+index+'.txt',text:'',length:0,version:'',encoding:'utf8',eol:'crlf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'plain',tabSize:4,indentWithTabs:false,wrap:false,readonly:false,error:null};});
 const oversizedMetadata={schema:1,generation:beforeMetadataStatus.generation+1,documents:metadataDocuments,views:[metadataDocuments[0].id],active:0},metadataBytes=Buffer.byteLength(JSON.stringify(oversizedMetadata));
 assert.ok(metadataBytes>128*1024);assert.ok(metadataDocuments.every(doc=>Buffer.byteLength(doc.path)===32760));
 await assert.rejects(invoke('text_checkpoint',{value:oversizedMetadata}),{code:'text-recovery',message:/128 KiB/});
 assert.deepEqual(await readFile(quota.manifest),beforeMetadata);const afterMetadataStatus=await invoke('profile_text_status');assert.equal(afterMetadataStatus.generation,beforeMetadataStatus.generation);assert.equal(afterMetadataStatus.confirmedGeneration,beforeMetadataStatus.confirmedGeneration);assert.equal(afterMetadataStatus.lifecycleReady,true);
 check('Aggregate metadata over 128 KiB is rejected before authorization or generation mutation and preserves the committed manifest',{metadataBytes,perPathBytes:32760,documents:5,manifestSha256:sha256(beforeMetadata),generation:afterMetadataStatus.generation,confirmedGeneration:afterMetadataStatus.confirmedGeneration});
 report.secondaryBodyLimit={limitBytes:64*1024*1024,measured:false,reason:'The stronger 16 Mi UTF-16 aggregate input limit allows at most 48 MiB UTF-8 for valid text. A 64 MiB recovery-body generation is therefore unreachable through a valid current session; this run does not claim a measured 64 MiB boundary.'};await stop();

 for(const kind of ['manifest','body']){
  const scenario=await makeScenario('corrupt-'+kind);await start(scenario);const state=await createDraft('被损坏前的完整恢复草稿');await stop();const manifestBytes=await readFile(scenario.manifest);let target=scenario.manifest,broken,originalBody;
  if(kind==='manifest')broken=Buffer.from('{ intentionally broken synthetic manifest');
  else{const metadata=JSON.parse(manifestBytes),name=metadata.blobs[state.documents[0].id].name;assert.match(name,/^[a-f0-9]{64}\.txt$/);target=path.join(scenario.recovery,name);assert.ok(inside(scenario.recovery,target));originalBody=await readFile(target);broken=Buffer.from(originalBody);broken[0]^=0x7f;}
  await writeFile(target,broken);await start(scenario);await expect(current.page.locator('.startup-error')).toHaveCount(0);await expect(current.page.locator('.text-global-error')).toBeVisible();await expect(current.page.locator('.text-global-error')).toContainText('恢复');
  await current.page.locator('#nav-notes').click();await expect(current.page.getByRole('heading',{name:'恢复故障隔离笔记'})).toBeVisible();await current.page.locator('#nav-clipboard').click();await expect(current.page.getByRole('heading',{name:'当前剪贴板'})).toBeVisible();await current.page.locator('#nav-text').click();await expect(current.page.locator('.text-global-error')).toBeVisible();
  assert.deepEqual(await readFile(target),broken);if(kind==='body')assert.deepEqual(await readFile(scenario.manifest),manifestBytes);await expect(current.page.getByRole('button',{name:'新建文本',exact:true})).toBeDisabled();
  check('Corrupt '+kind+' shows a recoverable error, preserves original broken records, and leaves notes and the synthetic-empty clipboard shell usable',{brokenPath:target,brokenSha256:sha256(broken),manifestSha256:sha256(await readFile(scenario.manifest))});
  if(kind==='body'){
   const sameOwner=current.owner.pid;await writeFile(target,originalBody);await current.page.locator('[data-text-action="restore"]').click();await expect(content()).toContainText('被损坏前的完整恢复草稿');await expect(current.page.locator('.text-global-error')).toBeHidden();await ready();assert.equal(current.owner.pid,sameOwner);assert.deepEqual(await readFile(target),originalBody);
   const status=await invoke('profile_text_status');check('Repairing only the exact original body and retrying recovers in the same owner and confirms the latest lifecycle generation',{ownerPid:sameOwner,generation:status.generation,confirmedGeneration:status.confirmedGeneration,bodySha256:sha256(originalBody)});
  }
  await stop();
 }
 assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack??JSON.stringify(error));throw error;}
finally{
 await releaseLock().catch(error=>{report.lockCleanupError=String(error);if(lockProcess?.exitCode===null)lockProcess.kill('SIGKILL');lockProcess=undefined;});
 if(paddingFile){assert.ok(current&&inside(current.scenario.recovery,paddingFile));await unlink(paddingFile).catch(error=>{report.paddingCleanupError=String(error);});paddingFile=undefined;}
 if(current)await stop(false).catch(async()=>{await stop(true).catch(error=>{report.processCleanupError=String(error);});});
 report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));
}
