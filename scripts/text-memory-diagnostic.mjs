// Diagnostic only: forced-GC results must never replace PERF-06 acceptance data.
// UI operations mirror text-native-performance.mjs; reports and fixtures are isolated.
import {chromium,expect} from '@playwright/test';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=path.resolve(workspace,process.argv.find(value=>value.startsWith('--exe='))?.slice(6)||'src-tauri/target/text-editor/qa/shiye-text-qa.exe');
if(!executable.startsWith(path.join(workspace,'src-tauri','target')+path.sep))throw new Error('QA binary must be in workspace target.');
const binary=await readFile(executable);
if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('Independent textqa identifier required.');
const execute=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const log=value=>console.log(new Date().toISOString(),value);
const owners=await execute('powershell.exe',['-NoProfile','-Command',"@(Get-Process -Name shiye-text-qa -ErrorAction SilentlyContinue | ForEach-Object Id) | ConvertTo-Json -Compress"],{windowsHide:true});
const live=owners.stdout.trim()?JSON.parse(owners.stdout):[];
if((Array.isArray(live)?live:[live]).length)throw new Error('Exclusive QA guard: existing textqa owner(s) '+JSON.stringify(live));
const runRoot=path.join(workspace,'.qa','text-memory-diagnostic-'+Date.now()),fixtures=path.join(runRoot,'fixtures'),notes=path.join(fixtures,'notes');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-memory-diagnostic.json');
await mkdir(notes,{recursive:true});await mkdir(path.dirname(reportPath),{recursive:true});
const previous=await readFile(reportPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
if(previous)await copyFile(reportPath,reportPath.replace(/\.json$/,`-history-${previous.sha256.slice(0,12)}-${Date.now()}.json`));
function content(bytes,kind='txt'){
 if(kind==='json')return '{"fixture":"'+'v'.repeat(bytes-15)+'"}\n';
 const line=kind==='ts'?'// fixture text line; const value = 1234567890;\n':'fixture text 0123456789 abcdefghijklmnopqrstuvwxyz\n';
 return line.repeat(Math.ceil(bytes/line.length)).slice(0,bytes-1)+'\n';
}
const files=[];
for(let index=0;index<12;index++){const kind=index===1?'json':index===2?'ts':'txt',full=path.join(fixtures,'T'+String(index+1).padStart(2,'0')+'.'+kind);await writeFile(full,content(100*1024,kind));files.push(full);}
for(const name of ['N1.md','N2.md'])await writeFile(path.join(notes,name),content(100*1024));
const report={schema:1,kind:'diagnostic',status:'diagnostic-running',acceptance:false,notice:'Diagnostic CDP observations and forced GC are excluded from all PERF-06 acceptance results.',startedAt:new Date().toISOString(),executable,sha256:createHash('sha256').update(binary).digest('hex'),runRoot,
 protocol:{fixture:'12 files of 100 KiB, two fixed canonical document views, two saved 100 KiB note sessions; same content and layout as full acceptance fixture',warmupCycles:10,cycles:100,stableBeforeMs:10000,stableAfterMs:60000,osSamplesPerGroup:3,intervalMs:1000,countsEveryCycles:10,forcedGC:'Only after normal baseline, 100 cycles, 60 second settle and normal after measurement'},
 references:['https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage','https://chromedevtools.github.io/devtools-protocol/tot/Memory/#method-getDOMCounters','https://chromedevtools.github.io/devtools-protocol/tot/Performance/#method-getMetrics','https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-getTargets','https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-collectGarbage','https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-takeHeapSnapshot'],counts:[],completedCycles:0};
report.harnessSha256=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
async function persist(){await writeFile(reportPath,JSON.stringify(report,null,2));}
let session;
async function invoke(command,args={}){
 const result=await session.page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message||String(error)}};}},[command,args]);
 if(!result.ok)throw Object.assign(new Error(result.error.message),result.error);return result.value;
}
async function ready(){await expect.poll(async()=>(await invoke('profile_text_status')).lifecycleReady,{timeout:20000,intervals:[50,100,200]}).toBe(true);}
async function visibleEditors(){if(await session.page.locator('.cm-editor').count()>2)throw new Error('More than two editor views');await expect(session.page.locator('.text-pane.active .cm-content')).toHaveAttribute('contenteditable','true');await expect.poll(()=>session.page.locator('#app').evaluate(el=>el.inert)).toBe(false);}
async function open(paths,count,wait=true){await invoke('profile_text_queue_open',{paths});await session.page.locator('.text-toolbar [data-text-action="open"]').click();await expect(session.page.locator('.text-tabs [role="tab"]')).toHaveCount(count);await visibleEditors();if(wait)await ready();}
async function dual(enabled){const count=await session.page.locator('.text-pane').count();if((count===2)!==enabled)await session.page.locator('.text-toolbar [data-text-action="split"]').click();await expect(session.page.locator('.text-pane')).toHaveCount(enabled?2:1);await visibleEditors();}
async function canonical(){await session.page.locator('.text-tabs [role="tab"]').first().click();await dual(false);await dual(true);await session.page.locator('.text-tabs [role="tab"]').first().click();await ready();}
async function full(){
 await open(files,12);await dual(true);await ready();
 await invoke('save_snapshot',{snapshot:{module:'text',expanded:[],panes:['N1.md','N2.md'].map(path=>({path,mode:'edit',cursor:0,scroll:0}))}});
 await session.page.reload();await session.page.locator('.text-pane.active .cm-content').waitFor();await visibleEditors();await ready();
 for(let index=0;index<12;index++){await session.page.locator('.text-tabs [role="tab"]').nth(index).click();await visibleEditors();}await canonical();
}
async function hide(){await session.page.locator('#hide').click();await ready();const parked=await session.page.evaluate(()=>({count:document.querySelectorAll('.cm-editor').length,hidden:document.querySelector('#text-workspace')?.hasAttribute('hidden'),readonly:[...document.querySelectorAll('.cm-editor .cm-content')].every(content=>content.getAttribute('contenteditable')==='false')}));expect(parked.count).toBeLessThanOrEqual(2);expect(parked.hidden).toBe(true);expect(parked.readonly).toBe(true);await expect.poll(async()=>(await invoke('profile_text_status')).windowVisible).toBe(false);}
async function wakeLines(){const text=await readFile(path.join(session.data,'wake.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});const end=text.lastIndexOf('\n');return end<0?[]:text.slice(0,end).split('\n').filter(line=>line.trim()).map(JSON.parse);}
async function show(){const before=(await wakeLines()).length;const launcher=spawn(executable,[],{env:session.env,windowsHide:true,stdio:'ignore'});launcher.unref();await expect.poll(async()=>(await wakeLines()).length,{timeout:20000,intervals:[10,15,25]}).toBeGreaterThan(before);await visibleEditors();}
async function exercise(){
 await session.page.locator('.text-tabs [role="tab"]').last().click();await session.page.locator('.text-tabs .text-tab-close').last().click();await expect(session.page.locator('.text-tabs [role="tab"]')).toHaveCount(11);await open([files.at(-1)],12,false);
 await session.page.locator('.text-toolbar [data-text-action="find"]').click();await session.page.getByRole('textbox',{name:'查找内容',exact:true}).fill('fixture');await session.page.getByRole('textbox',{name:'查找内容',exact:true}).press('Enter');await session.page.locator('[data-search="close"]').click();await dual(false);await dual(true);await hide();await show();
}
async function osSample(name){const output=path.join(session.data,name+'.json');await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(workspace,'scripts','text-memory-probe.ps1'),'-AppPid',String(session.owner.pid),'-Samples','3','-IntervalMs','1000','-OutputPath',output],{cwd:workspace,maxBuffer:1024*1024,windowsHide:true});return JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,''));}
async function counts(label,cyclesCompleted){
 const result={label,cyclesCompleted,timestamp:new Date().toISOString()};
 for(const [key,method] of [['heap','Runtime.getHeapUsage'],['dom','Memory.getDOMCounters'],['performance','Performance.getMetrics'],['targets','Target.getTargets']]){
  try{result[key]=await session.cdp.send(method);}catch(error){result[key]={error:String(error)};}
 }
 if(result.targets.targetInfos)result.workerTargets=result.targets.targetInfos.filter(target=>/worker/.test(target.type));
 report.counts.push(result);await persist();return result;
}
async function heapSnapshot(){
 const output=path.join(runRoot,'after-gc.heapsnapshot'),stream=createWriteStream(output);let streamError;
 stream.on('error',error=>{streamError=error;});const receive=({chunk})=>stream.write(chunk);session.cdp.on('HeapProfiler.addHeapSnapshotChunk',receive);
 try{await session.cdp.send('HeapProfiler.takeHeapSnapshot',{reportProgress:false});await new Promise((resolve,reject)=>{if(streamError)return reject(streamError);stream.end(()=>streamError?reject(streamError):resolve());});}
 finally{session.cdp.off('HeapProfiler.addHeapSnapshotChunk',receive);if(!stream.writableEnded)stream.destroy();}
 return {path:output,bytes:(await stat(output)).size};
}
try{
 const data=path.join(runRoot,'owner');await mkdir(data,{recursive:true});await writeFile(path.join(data,'settings.json'),JSON.stringify({root:notes,shortcut:'Control+Alt+F9',floating:true,session:{module:'text',expanded:[],panes:[]}}));
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};delete env.SHIYE_AUTOSTART_QA;
 const owner=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});session={data,env,owner};report.ownerPid=owner.pid;report.port=port;await persist();log('diagnostic owner PID '+owner.pid);
 for(let attempt=0;attempt<120;attempt++){
  if(owner.exitCode!==null)throw new Error('Exclusive QA owner exited before attach: '+owner.exitCode);
  try{session.browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});session.page=session.browser.contexts()[0].pages()[0];if(session.page){session.page.setDefaultTimeout(15000);await session.page.locator('#nav-text').waitFor();await expect(session.page.locator('#app')).not.toHaveAttribute('inert','');break;}}catch{}await delay(100);
 }
 if(!session.page)throw new Error('Cannot attach isolated WebView2');await invoke('profile_text_status');await full();
 session.cdp=await session.page.context().newCDPSession(session.page);await session.cdp.send('Performance.enable');
 log('10 full warmup cycles');for(let index=0;index<10;index++)await exercise();await canonical();await delay(10000);
 report.normalBaseline=await osSample('baseline-normal');const baseline=await counts('baseline',0);log('baseline '+JSON.stringify({heap:baseline.heap,dom:baseline.dom}));
 for(let index=0;index<100;index++){await exercise();report.completedCycles=index+1;if((index+1)%10===0){const value=await counts('cycle-'+(index+1),index+1);log((index+1)+'/100 '+JSON.stringify({heap:value.heap,dom:value.dom,workers:value.workerTargets?.length}));}}
 await canonical();log('normal 60 second settle');await delay(60000);report.normalAfter=await osSample('after-normal');const beforeGC=await counts('after-before-forced-gc',100);
 await session.cdp.send('HeapProfiler.enable');report.forcedGC={requestedAt:new Date().toISOString()};await session.cdp.send('HeapProfiler.collectGarbage');report.forcedGC.completedAt=new Date().toISOString();await delay(1000);
 const afterGC=await counts('after-forced-gc',100);report.afterForcedGC=await osSample('after-forced-gc');
 const heapGrowth=(beforeGC.heap.usedSize??0)-(baseline.heap.usedSize??0),nodeGrowth=(beforeGC.dom.nodes??0)-(baseline.dom.nodes??0);
 if(heapGrowth>1024*1024||nodeGrowth>100){log('Writing diagnostic heap snapshot after explicit GC');report.heapSnapshot=await heapSnapshot();}
 report.deltas={heapUsedBeforeGcBytes:heapGrowth,nodesBeforeGc:nodeGrowth,heapUsedAfterGcBytes:(afterGC.heap.usedSize??0)-(baseline.heap.usedSize??0),nodesAfterGc:(afterGC.dom.nodes??0)-(baseline.dom.nodes??0),normalPrivateWorkingSetMiB:report.normalAfter.p95MiB-report.normalBaseline.p95MiB,normalPrivateBytesMiB:report.normalAfter.privateBytesP95MiB-report.normalBaseline.privateBytesP95MiB};report.status='diagnostic-complete';
}catch(error){report.status='diagnostic-failed';report.error=String(error?.stack||error);log(report.error);process.exitCode=1;}
finally{
 if(session?.page&&!session.page.isClosed()&&session.owner.exitCode===null){await hide().catch(()=>{});await invoke('exit_app').catch(()=>{});}
 if(session?.owner.exitCode===null){await delay(500);if(session.owner.exitCode===null)session.owner.kill();}
 if(session?.owner.exitCode===null)await new Promise(resolve=>{session.owner.once('exit',resolve);setTimeout(resolve,2000).unref();});
 await session?.browser?.close().catch(()=>{});report.completedAt=new Date().toISOString();await persist();console.log(JSON.stringify({status:report.status,reportPath,acceptance:false}));
}
