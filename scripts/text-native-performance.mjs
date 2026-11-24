// Full, isolated Windows WebView2 measurements. Run only when other QA work/builds are quiet.
// --quick is an instrument smoke test and explicitly cannot pass PERF-06 acceptance.
import {chromium,expect} from '@playwright/test';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const options=new Set(process.argv.slice(2));
const quick=options.has('--quick');
const resume=options.has('--resume');
const phase=[...options].find(value=>value.startsWith('--phase='))?.slice(8)||'all';
if(!['all','memory','wake','loops','stress'].includes(phase))throw new Error('Unknown --phase; use all, memory, wake, loops, or stress.');
const executable=path.resolve(workspace,[...options].find(value=>value.startsWith('--exe='))?.slice(6)||'src-tauri/target/text-editor/release/shiye-text-qa.exe');
if(!executable.startsWith(path.join(workspace,'src-tauri','target')+path.sep))throw new Error('QA executable must be inside the workspace target directory.');
const binary=await readFile(executable);
if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('The binary must carry the independent textqa application identifier.');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-performance'+(quick?'-quick':'')+(phase==='all'?'':'-'+phase)+'.json');
const sha256=createHash('sha256').update(binary).digest('hex');
const previous=await readFile(reportPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(resume&&(!previous||previous.sha256!==sha256||previous.phase!==phase||previous.quick!==quick))throw new Error('--resume requires an existing report with the identical executable SHA256, phase, and quick mode; do not combine builds.');
if(previous&&!resume){
 const archive=reportPath.replace(/\.json$/,`-history-${previous.sha256.slice(0,12)}-${Date.now()}.json`);
 await copyFile(reportPath,archive);console.log('Preserved previous report: '+archive);
}
const runRoot=resume?previous.runRoot:path.join(workspace,'.qa','text-perf-'+Date.now());
if(!path.resolve(runRoot).startsWith(path.join(workspace,'.qa','text-perf-')))throw new Error('Recovery report runRoot is outside the isolated QA directory.');
const fixtures=path.join(runRoot,'fixtures'),notes=path.join(fixtures,'notes');
await mkdir(notes,{recursive:true});await mkdir(path.dirname(reportPath),{recursive:true});
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const log=message=>console.log(new Date().toISOString(),message);
const rounds=quick?1:3,samples=quick?3:30,stableMs=quick?500:10000,loopStableMs=quick?500:60000,wakeCount=quick?2:30,cycles=quick?2:100;
const warmupCycles=quick?2:10;
const p95=values=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]:null;
const MiB=1024*1024;
function content(bytes,kind='txt'){
 if(kind==='json')return '{"fixture":"'+ 'v'.repeat(bytes-15)+'"}\n';
 const line=kind==='ts'?'// fixture text line; const value = 1234567890;\n':'fixture text 0123456789 abcdefghijklmnopqrstuvwxyz\n';
 return (line.repeat(Math.ceil(bytes/line.length))).slice(0,bytes-1)+'\n';
}
const files=[];
for(let index=0;index<12;index++){
 const kind=index===1?'json':index===2?'ts':'txt',filename='T'+String(index+1).padStart(2,'0')+'.'+kind;
 const full=path.join(fixtures,filename),text=content(100*1024,kind);
 if(Buffer.byteLength(text)!==100*1024)throw new Error('Invalid fixture byte size: '+filename);
 if(resume){if(!(await readFile(full)).equals(Buffer.from(text)))throw new Error('Resume fixture changed: '+filename);}else await writeFile(full,text);files.push(full);
}
for(const filename of ['N1.md','N2.md']){const full=path.join(notes,filename),text=content(100*1024);if(resume){if(!(await readFile(full)).equals(Buffer.from(text)))throw new Error('Resume note fixture changed: '+filename);}else await writeFile(full,text);}
const report=resume?previous:{schema:2,status:'running',phase,quick,startedAt:new Date().toISOString(),executable,sha256,runRoot,
 environment:{platform:os.platform(),release:os.release(),architecture:os.arch(),cpus:os.cpus().length,cpu:os.cpus()[0]?.model,totalMemoryBytes:os.totalmem(),node:process.version},
 instrumentation:{memory:'Toolhelp recursive owner/descendants, QueryWorkingSet Shared=0 resident pages, PROCESS_MEMORY_COUNTERS_EX.PrivateUsage',webview:'CDP on ephemeral localhost port; independent textqa identifier; SHIYE_DATA_DIR; double-gated profile fixture selection',idle:'profile_unload simulates expiry for performance only; the separate functional smoke verifies real 60-second expiry',wakeEndpoint:'Budget uses native show to frontend_ready, matching the existing native-benchmark.mjs method; launcher-to-editable is separately reported',rounds,samples,intervalMs:1000,stableMs,loopStableMs,wakeCount,cycles,warmupCycles},
 fixtures:files.map(full=>({path:full,bytes:100*1024})),memory:[],wake:[],loops:[],stress:[],acceptance:{complete:false,passed:false},sessions:[]};
report.resumptions??=[];report.instrumentationFailures??=[];report.wakeAttempts??=[];report.loopAttempts??=[];report.sampleGroups??=[];report.instrumentationAttempts??=[];
if(resume){
 if(report.error&&!report.instrumentationFailures.some(item=>item.error===report.error))report.instrumentationFailures.push({at:report.completedAt,attempt:report.resumptions.length+1,stage:report.activeStage,error:report.error,importedFromPriorReport:true});
 report.resumptions.push({at:new Date().toISOString(),previousStatus:report.status,previousCompletedAt:report.completedAt,sha256});delete report.error;delete report.completedAt;report.status='running';
}
report.instrumentation.harnessSha256=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
report.instrumentation.memoryProbeSha256=createHash('sha256').update(await readFile(path.join(workspace,'scripts','text-memory-probe.ps1'))).digest('hex');
const attemptNumber=report.resumptions.length+1;
report.instrumentationAttempts.push({attempt:attemptNumber,at:new Date().toISOString(),harnessSha256:report.instrumentation.harnessSha256,memoryProbeSha256:report.instrumentation.memoryProbeSha256,executableSha256:sha256});
report.instrumentation.fixtureIntegrity='Normal 100 KiB scenes require clean revision-zero text, unchanged length and recovery body hash equal to the original file version. Dirty-tab guards abort unexpected edits; interrupted attempts remain in the report.';
function effectiveMemory(){const effective=new Map();for(const item of report.memory){const key=item.round+':'+item.name,old=effective.get(key);if(!old||!old.raw.complete)effective.set(key,item);}return [...effective.values()];}
function effectiveLoops(){const effective=new Map();for(const item of report.loops){const old=effective.get(item.round);if(!old||!old.baseline.complete||!old.after.complete)effective.set(item.round,item);}return [...effective.values()];}
function effectiveStress(){return report.stress.find(item=>item.raw.complete)??report.stress.at(-1);}
async function stage(value){report.activeStage=value;await persist();}
async function persist(){await writeFile(reportPath,JSON.stringify(report,null,2));}
let current;
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function start(name){
 const data=path.join(runRoot,name+'-attempt-'+attemptNumber);await mkdir(data,{recursive:true});
 await writeFile(path.join(data,'settings.json'),JSON.stringify({root:notes,shortcut:'Control+Alt+F9',floating:true,session:{module:'text',expanded:[],panes:[]}}));
 const port=await freePort();const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
 delete env.SHIYE_AUTOSTART_QA;
 const owner=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});const session={name,data,port,env,owner,browser:null,page:null};current=session;
 log('session '+name+': owner PID '+owner.pid);
 const record={name,data,port,ownerPid:owner.pid};report.sessions.push(record);await connect(session);await invoke(session,'profile_text_status');
 record.browserVersion=session.browser.version();record.viewport=await session.page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height}));await persist();return session;
}
async function connect(session){
 for(let attempt=0;attempt<120;attempt++){
  if(session.owner.exitCode!==null)throw new Error('QA owner exited: '+session.owner.exitCode);
  try{
   session.browser=await chromium.connectOverCDP('http://127.0.0.1:'+session.port,{timeout:1000});
   session.page=session.browser.contexts()[0].pages()[0];
   if(session.page){session.page.setDefaultTimeout(15000);await session.page.locator('#nav-text').waitFor();await expect(session.page.locator('#app')).not.toHaveAttribute('inert','');return;}
  }catch{}
  await delay(100);
 }
 throw new Error('Cannot attach to isolated textqa WebView2.');
}
async function invoke(session,command,args={}){
 const result=await session.page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message||String(error)}};}},[command,args]);
 if(!result.ok)throw Object.assign(new Error(result.error.message),result.error);return result.value;
}
async function open(session,paths,count,waitForRecovery=true){
 await invoke(session,'profile_text_queue_open',{paths});
 await session.page.locator('.text-toolbar [data-text-action="open"]').click();
 await expect(session.page.locator('.text-tabs [role="tab"]')).toHaveCount(count);await visibleEditors(session);if(waitForRecovery)await ready(session);
}
async function ready(session){
 try {await expect.poll(async()=>(await invoke(session,'profile_text_status')).lifecycleReady,{timeout:20000,intervals:[50,100,200]}).toBe(true);}
 catch(error){report.lastReadinessError={session:session.name,status:await invoke(session,'profile_text_status').catch(()=>null),ui:await session.page.locator('.text-global-error').textContent().catch(()=>null),toast:await session.page.locator('#toast').textContent({timeout:1000}).catch(()=>null)};throw error;}
}
async function visibleEditors(session){
 const count=await session.page.locator('.cm-editor').count();if(count>2)throw new Error('More than two editor views mounted: '+count);
 await expect(session.page.locator('.text-pane.active .cm-content')).toHaveAttribute('contenteditable','true');
 await expect.poll(()=>session.page.locator('#app').evaluate(el=>el.inert)).toBe(false);
}
async function fixtureIntegrity(session,stage){
 const dirtyTabs=session.page&&!session.page.isClosed()?await session.page.locator('.text-tabs .text-dirty-dot').count():0;
 const {snapshot,blobs}=JSON.parse(await readFile(path.join(session.data,'text-recovery','manifest.json'),'utf8'));
 const changed=snapshot.documents.filter(doc=>doc.length!==100*1024||doc.revision!==0||doc.savedRevision!==0||blobs[doc.id]?.hash!==doc.version).map(doc=>({id:doc.id,name:doc.name,length:doc.length,revision:doc.revision,savedRevision:doc.savedRevision}));
 if(dirtyTabs||changed.length){
  report.fixtureIntegrityFailures??=[];report.fixtureIntegrityFailures.push({at:new Date().toISOString(),session:session.name,stage,dirtyTabs,changed});await persist();
  throw new Error('Unexpected edits invalidated the synthetic fixture during '+stage+'; no result from this attempt may pass acceptance.');
 }
}
async function dual(session,enabled){
 const count=await session.page.locator('.text-pane').count();if((count===2)!==enabled)await session.page.locator('.text-toolbar [data-text-action="split"]').click();
 await expect(session.page.locator('.text-pane')).toHaveCount(enabled?2:1);await visibleEditors(session);
}
async function full(session){
 await open(session,files,12);await dual(session,true);
 await ready(session);
 await invoke(session,'save_snapshot',{snapshot:{module:'text',expanded:[],panes:['N1.md','N2.md'].map(path=>({path,mode:'edit',cursor:0,scroll:0}))}});
 await session.page.reload();await session.page.locator('.text-pane.active .cm-content').waitFor();await visibleEditors(session);await ready(session);
 for(let index=0;index<12;index++){await session.page.locator('.text-tabs [role="tab"]').nth(index).click();await visibleEditors(session);}
 await canonicalLayout(session);
 if((await invoke(session,'get_settings')).session.panes.length!==2)throw new Error('Full fixture did not retain two saved note sessions.');
}
async function canonicalLayout(session){
 await session.page.locator('.text-tabs [role="tab"]').first().click();await dual(session,false);await dual(session,true);await session.page.locator('.text-tabs [role="tab"]').first().click();await ready(session);
}
async function sample(session,name,count=samples){
 const output=path.join(session.data,name+'.json');
 await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(workspace,'scripts','text-memory-probe.ps1'),'-AppPid',String(session.owner.pid),'-Samples',String(count),'-IntervalMs','1000','-OutputPath',output],{cwd:workspace,maxBuffer:1024*1024,windowsHide:true});
 const raw=JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,''));
 if(!raw.complete)log(name+': incomplete process coverage; no acceptance claim');
 log(name+': '+raw.p95MiB?.toFixed(2)+' MiB private WS, '+raw.privateBytesP95MiB?.toFixed(2)+' MiB Private Bytes');return raw;
}
async function coveredSample(session,name,count=samples){
 for(let retry=0;retry<3;retry++){
  const measurement=name+(retry?'-coverage-retry-'+retry:'');
  const raw=await sample(session,measurement,count);
  report.sampleGroups.push({session:session.name,data:session.data,name,attempt:attemptNumber,coverageRetry:retry,reason:retry?'Previous whole sample group had incomplete process coverage; all groups retained.':undefined,raw});await persist();
  if(raw.complete||retry===2)return raw;
 }
}
async function hide(session){
 await session.page.locator('#hide').click();await ready(session);
 // PERF-02 permits at most two paused views until the real idle unload. The
 // parked state must be hidden and non-editable; no extra editor is allowed.
 const parked=await session.page.evaluate(()=>({count:document.querySelectorAll('.cm-editor').length,hidden:document.querySelector('#text-workspace')?.hasAttribute('hidden'),readonly:[...document.querySelectorAll('.cm-editor .cm-content')].every(content=>content.getAttribute('contenteditable')==='false')}));
 expect(parked.count).toBeLessThanOrEqual(2);expect(parked.hidden).toBe(true);expect(parked.readonly).toBe(true);
 await expect.poll(async()=>(await invoke(session,'profile_text_status')).windowVisible,{timeout:10000}).toBe(false);
}
function completeJsonLines(text){const end=text.lastIndexOf('\n');return end<0?[]:text.slice(0,end).split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));}
// Host writeln! may append a JSON line in multiple writes. Only a terminating
// newline commits a record; malformed committed records still fail loudly.
async function wakeLines(session){return completeJsonLines(await readFile(path.join(session.data,'wake.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}));}
async function show(session,cold=false){
 const before=(await wakeLines(session)).length,started=performance.now();
 const launcher=spawn(executable,[],{env:session.env,windowsHide:true,stdio:'ignore'});launcher.unref();
 if(cold){await connect(session);}
 await expect.poll(async()=>(await wakeLines(session)).length,{timeout:20000,intervals:[10,15,25]}).toBeGreaterThan(before);
 await visibleEditors(session);
 const elapsed=performance.now()-started,latest=(await wakeLines(session)).at(-1);
 expect(latest.cold).toBe(cold);
 return {timestamp:new Date().toISOString(),ownerPid:session.owner.pid,launcherPid:launcher.pid,launcherToEditableMs:elapsed,nativeToReadyMs:latest.elapsedMs,cold:latest.cold};
}
async function unload(session){
 const closed=session.page.waitForEvent('close',{timeout:10000});await invoke(session,'profile_unload').catch(error=>{if(!/closed|destroyed|Target/.test(String(error)))throw error;});await closed;
 await session.browser?.close().catch(()=>{});session.browser=null;session.page=null;await delay(1000);
}
async function stop(session){
 if(!session)return;
 if(session.page&&!session.page.isClosed()&&session.owner.exitCode===null){await hide(session).catch(()=>{});await invoke(session,'exit_app').catch(()=>{});}
 if(session.owner.exitCode===null){await delay(500);if(session.owner.exitCode===null)session.owner.kill();}
 if(session.owner.exitCode===null)await new Promise(resolve=>{session.owner.once('exit',resolve);setTimeout(resolve,2000).unref();});
 await session.browser?.close().catch(()=>{});if(current===session)current=null;
}
async function exerciseCycle(session){
 if(await session.page.locator('.text-tabs .text-dirty-dot').count())await fixtureIntegrity(session,'before-cycle');
 await session.page.locator('.text-tabs [role="tab"]').last().click();
 await session.page.locator('.text-tabs .text-tab-close').last().click();await expect(session.page.locator('.text-tabs [role="tab"]')).toHaveCount(11);
 await open(session,[files.at(-1)],12,false);
 await session.page.locator('.text-toolbar [data-text-action="find"]').click();await session.page.getByRole('textbox',{name:'查找内容',exact:true}).fill('fixture');
 await session.page.getByRole('textbox',{name:'查找内容',exact:true}).press('Enter');await session.page.locator('[data-search="close"]').click();
 await dual(session,false);await dual(session,true);await hide(session);await show(session,false);
}
try{
 if(phase==='all'||phase==='memory')for(let round=1;round<=rounds;round++){
  if(['single','dual','full','hidden-unloaded'].every(name=>report.memory.some(item=>item.round===round&&item.name===name)))continue;
  await stage({phase:'memory',round});
  const session=await start('memory-'+round);
  await open(session,[files[0]],1);
  for(const [name,budget,prepare] of [
   ['single',200,async()=>{}],['dual',260,async()=>{await session.page.locator('.text-tabs .text-tab-close').first().click();await expect(session.page.locator('.text-tabs [role="tab"]')).toHaveCount(0);await open(session,[files[1],files[2]],2);await dual(session,true);} ],
   ['full',320,async()=>{await full(session);} ],['hidden-unloaded',120,async()=>{await hide(session);await unload(session);} ]
  ]){
   await prepare();if(report.memory.some(item=>item.round===round&&item.name===name))continue;
   log('memory '+name+' round '+round+': stabilize '+stableMs+' ms');await delay(stableMs);await fixtureIntegrity(session,'memory-before-'+name);
   const raw=await sample(session,name);await fixtureIntegrity(session,'memory-after-'+name);report.memory.push({id:`${round}:${name}:${attemptNumber}:0`,name,round,budgetMiB:budget,pass:raw.complete&&raw.p95MiB<=budget,raw});await persist();
  }
  await stop(session);
 }
 if((phase==='all'||phase==='wake')&&report.wake.length<2){
  await stage({phase:'wake'});
  const session=await start('wake');await full(session);await delay(stableMs);
  for(const [name,cold,budget] of [['retained',false,300],['unloaded',true,1000]]){
   if(report.wake.some(item=>item.name===name&&item.sampleCount===wakeCount))continue;
   const measurements=[],attempt={name,attempt:attemptNumber,session:session.name,data:session.data,measurements,completed:false};report.wakeAttempts.push(attempt);
   for(let index=0;index<wakeCount;index++){
    await hide(session);if(cold)await unload(session);const value=await show(session,cold);measurements.push(value);
    if((index+1)%10===0)log(name+' wake '+(index+1)+'/'+wakeCount);await stage({phase:'wake',name,completedSamples:index+1});
   }
   await fixtureIntegrity(session,'wake-after-'+name);
   const value={name,budgetMs:budget,sampleCount:measurements.length,p95Ms:p95(measurements.map(v=>v.nativeToReadyMs)),nativeP95Ms:p95(measurements.map(v=>v.nativeToReadyMs)),launcherP95Ms:p95(measurements.map(v=>v.launcherToEditableMs)),measurements};value.pass=value.nativeP95Ms<=budget;attempt.completed=true;report.wake.push(value);await persist();
  }
  await stop(session);
 }
 if(phase==='all'||phase==='loops')for(let round=1;round<=rounds;round++){
  if(report.loops.some(item=>item.round===round&&item.cycles===cycles&&item.baseline.complete&&item.after.complete))continue;
  await stage({phase:'loops',round,completedCycles:0});
  const session=await start('loops-'+round);await full(session);
  const attempt={round,attempt:attemptNumber,data:session.data,completedCycles:0,completed:false};report.loopAttempts.push(attempt);
  log('loop round '+round+': '+warmupCycles+' complete cycles before baseline');
  for(let index=0;index<warmupCycles;index++)await exerciseCycle(session);
  await canonicalLayout(session);await delay(stableMs);
  const baseline=await coveredSample(session,'baseline');await fixtureIntegrity(session,'loop-baseline-'+round);attempt.baseline=baseline;await persist();log('loop round '+round+': '+cycles+' close/reopen + cancel search + split + hidden/restored cycles');
  const started=performance.now();
  for(let index=0;index<cycles;index++){
   await exerciseCycle(session);
   attempt.completedCycles=index+1;if((index+1)%10===0){log('loop round '+round+': '+(index+1)+'/'+cycles);await stage({phase:'loops',round,completedCycles:index+1});}
  }
  await canonicalLayout(session);
  log('loop round '+round+': settle '+loopStableMs+' ms');await delay(loopStableMs);const after=await coveredSample(session,'after');await fixtureIntegrity(session,'loop-after-'+round);
  const wsGrowthMiB=after.p95MiB-baseline.p95MiB,privateGrowthMiB=after.privateBytesP95MiB-baseline.privateBytesP95MiB;
  attempt.after=after;attempt.completed=true;report.loops.push({id:`loops:${round}:${attemptNumber}`,round,cycles,warmupCycles,elapsedMs:performance.now()-started,baseline,after,privateWorkingSetGrowthMiB:wsGrowthMiB,privateBytesGrowthMiB:privateGrowthMiB,budgetGrowthMiB:20,pass:baseline.complete&&after.complete&&wsGrowthMiB<=20&&privateGrowthMiB<=20});await persist();await stop(session);
 }
 if((phase==='all'||phase==='stress')&&!effectiveStress()?.raw.complete){
  await stage({phase:'stress'});
  const session=await start('stress');const stressRoot=path.join(fixtures,'stress');await mkdir(stressRoot,{recursive:true});
  const stressFiles=[];
  for(let index=0;index<12;index++){const full=path.join(stressRoot,'S'+String(index).padStart(2,'0')+'.txt');const bytes=index===0?16*MiB-11*64:64;await writeFile(full,content(bytes));stressFiles.push(full);}
  const oversize=path.join(stressRoot,'oversize.txt');await writeFile(oversize,'a'.repeat(16*MiB+1));const refused=await invoke(session,'profile_text_open',{paths:[oversize]});expect(refused.files).toHaveLength(0);expect(refused.errors.length).toBeGreaterThan(0);
  expect(refused.errors[0].code).toBe('large-limit');
  await open(session,stressFiles,12);await dual(session,true);await ready(session);
  const total=await invoke(session,'text_restore');expect(total.documents.reduce((sum,d)=>sum+d.length,0)).toBe(16*MiB);
  await session.page.locator('.text-tabs [role="tab"]').first().click();const editor=session.page.locator('.text-pane.active .cm-content');await editor.press('Control+End');await editor.press('X');
  await expect(session.page.locator('#toast')).toContainText(/超过|上限/);
  await ready(session);expect((await invoke(session,'text_restore')).documents.reduce((sum,d)=>sum+d.length,0)).toBe(16*MiB);
  await editor.press('Control+Home');await editor.press('Shift+ArrowRight');await editor.press('Z');await session.page.locator('.text-toolbar [data-text-action="save"]').click();
  await expect(session.page.locator('.text-document-state')).toContainText('已保存到原文件');await ready(session);
  const saved=await readFile(stressFiles[0]);expect(saved.length).toBe(16*MiB-11*64);expect(saved[0]).toBe('Z'.charCodeAt(0));
  const before=await coveredSample(session,'maximum-body',quick?1:5);await hide(session);await unload(session);await show(session,true);await expect(session.page.locator('.text-tabs [role="tab"]')).toHaveCount(12);
  report.stress.push({totalUtf16Units:16*MiB,singleFileBytes:16*MiB-11*64,documents:12,boundaryRejectedWithoutTruncation:true,inLimitEditAndSave:true,unloadedAndRecovered:true,raw:before,note:'Maximum-body stress is separate from 100 KiB fixture budgets; profile fixture selection bypasses only native dialogs.'});await persist();await stop(session);
 }
 // Incomplete process coverage is an instrumentation failure, not a memory
 // budget result. Preserve it and repeat the full scene (at most three times).
 if(phase==='all'||phase==='memory')for(const original of effectiveMemory().filter(item=>!item.raw.complete)){
  for(let retry=1;retry<=3;retry++){
   await stage({phase:'memory-replacement',name:original.name,round:original.round,retry,replaces:original.id??`${original.round}:${original.name}:legacy`});
   const session=await start(`memory-replacement-${original.round}-${original.name}-${retry}`);
   if(original.name==='single')await open(session,[files[0]],1);
   else if(original.name==='dual'){await open(session,[files[1],files[2]],2);await dual(session,true);}
   else {await full(session);if(original.name==='hidden-unloaded'){await hide(session);await unload(session);}}
   await delay(stableMs);const raw=await sample(session,original.name);
   report.memory.push({id:`${original.round}:${original.name}:${attemptNumber}:${retry}`,name:original.name,round:original.round,budgetMiB:original.budgetMiB,pass:raw.complete&&raw.p95MiB<=original.budgetMiB,raw,replaces:original.id??`${original.round}:${original.name}:legacy`,replacementReason:'Original scene had incomplete process coverage; original samples retained unchanged.'});await persist();await stop(session);
   if(raw.complete)break;
  }
 }
 const memory=effectiveMemory(),loops=effectiveLoops(),stress=effectiveStress(),measured=[...memory,...report.wake,...loops];
 const requestedComplete=phase==='all'&&!quick&&memory.length===12&&memory.every(value=>value.raw.complete)&&report.wake.length===2&&loops.length===3&&loops.every(value=>value.baseline.complete&&value.after.complete)&&stress?.raw.complete===true;
 report.acceptance={complete:requestedComplete,passed:requestedComplete&&measured.every(value=>value.pass),effectiveMemoryIds:memory.map(value=>value.id??`${value.round}:${value.name}:legacy`),effectiveLoopIds:loops.map(value=>value.id??`loops:${value.round}:legacy`),reason:quick?'Instrumentation smoke only; reduced counts are not PERF-06 acceptance.':phase!=='all'?'Partial phase run; use all for complete acceptance.':undefined};
 report.status=report.acceptance.complete?(report.acceptance.passed?'passed':'budget-failed'):'partial';delete report.activeStage;
 if(!quick&&((phase==='all'&&!requestedComplete)||measured.some(value=>!value.pass)))process.exitCode=1;
}catch(error){report.status='failed';report.error=String(error?.stack||error);report.instrumentationFailures.push({at:new Date().toISOString(),attempt:attemptNumber,stage:report.activeStage,error:report.error});log(report.error);process.exitCode=1;}
finally{await stop(current).catch(error=>{report.cleanupError=String(error);});report.completedAt=new Date().toISOString();await persist();console.log(JSON.stringify({status:report.status,reportPath,acceptance:report.acceptance}));}
