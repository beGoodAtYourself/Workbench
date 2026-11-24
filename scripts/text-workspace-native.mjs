// Real release UI checks on synthetic files only. Run after the performance harness releases textqa.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(workspace,process.argv.slice(2).find(value=>value.endsWith('.exe'))??'src-tauri/target/text-editor/qa/shiye-text-qa.exe');
const nativeRootPicker=process.argv.includes('--native-root-picker');
const inside=(root,target)=>{const relative=path.relative(root,path.resolve(target));return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
if(!inside(path.join(workspace,'src-tauri','target'),source))throw new Error('Only a QA binary in this workspace target directory is allowed.');
const binary=await readFile(source),hash=value=>createHash('sha256').update(value).digest('hex');
if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('An isolated textqa application identity is required.');
const data=path.join(workspace,'.qa','text-workspace-native-'+Date.now()),fixtures=path.join(data,'files'),runningExecutable=path.join(data,'app','shiye-text-qa.exe');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-workspace.json'),coordinationPath=path.join(workspace,'.qa','text-workspace-current.json');
for(const directory of [fixtures,path.dirname(runningExecutable),path.dirname(reportPath),path.join(fixtures,'父'),path.join(fixtures,'另一个'),path.join(fixtures,'目标')])await mkdir(directory,{recursive:true});
await copyFile(source,runningExecutable);
const fixtureContent={
 '入口.md':'# 原生工作区入口\n\n[打开共享笔记](父/共享.md)\n',
 '父/共享.md':'# 共享笔记\n\n跨模块只保留一份可写正文。\n',
 'code.xml':'<?xml version="1.0"?>\n<root id="1">中文 XML</root>\n',
 'config.json':'{\n  "native": true,\n  "value": 1\n}\n'
};
for(const [name,text] of Object.entries(fixtureContent))await writeFile(path.join(fixtures,name),text);
const invalidName='拒绝损坏UTF8.txt',invalidBytes=Buffer.from([0xc3,0x28]);await writeFile(path.join(fixtures,invalidName),invalidBytes);
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:fixtures,shortcut:'Control+Alt+F10',floating:false,session:{module:'notes',panes:[{path:'入口.md',mode:'preview',cursor:0,scroll:0}],expanded:['父']}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const report={startedAt:new Date().toISOString(),source,sha256:hash(binary),executable:runningExecutable,data,fixtures,port,scope:'Isolated textqa release WebView2; real visible controls and dedicated search workers; only synthetic files. QA queue selects exact fixture files then runs the normal text-open command. No mock file writes or fabricated folder-picker result.',checks:[],pendingChecks:[],pageErrors:[],workerEvents:[],resourceRequests:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(name,details){report.checks.push({name,pass:true,...(details===undefined?{}:{details})});console.log(name);}
async function command(executable,args){const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)throw new Error(executable+' failed ('+code+'): '+stderr);return stdout.trim();}
const existing=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='shiye-text-qa.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"]),instances=existing?JSON.parse(existing):[],running=Array.isArray(instances)?instances:instances?[instances]:[];
if(running.length){report.status='blocked';report.existingInstances=running;report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));throw new Error('Another textqa owner is running; this harness will not attach to it or terminate it.');}

let owner,browser,page,coordination;
async function connect(){
 let last;
 for(let attempt=0;attempt<100;attempt++){
  if(owner.exitCode!==null)throw new Error('The harness launcher exited before its own WebView2 became ready.');
  try{
   browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});page=browser.contexts()[0].pages()[0];if(!page)throw new Error('No WebView page yet.');page.setDefaultTimeout(12000);
   page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('worker',worker=>{report.workerEvents.push({event:'created',url:worker.url(),at:new Date().toISOString()});worker.on('close',()=>report.workerEvents.push({event:'closed',url:worker.url(),at:new Date().toISOString()}));});
   page.on('request',request=>{if(request.resourceType()==='script')report.resourceRequests.push(request.url());});
   await expect(page.getByRole('heading',{name:'原生工作区入口',exact:true})).toBeVisible();return;
  }catch(error){last=error;await browser?.close().catch(()=>{});browser=undefined;await delay(150);}
 }
 throw new Error('Cannot attach to the isolated WebView2: '+last);
}
async function invoke(command,args={}){const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message??String(error)}};}},[command,args]);if(!result.ok)throw result.error;return result.value;}
async function ready(){await expect.poll(async()=>{const status=await invoke('profile_text_status');return status.lifecycleReady&&status.generation===status.confirmedGeneration;},{timeout:15000}).toBe(true);}
const content=()=>page.locator('#text-workspace .cm-content').first();
const tab=name=>page.getByRole('tab',{name:new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')});
async function queueOpen(names){await invoke('profile_text_queue_open',{paths:names.map(name=>path.join(fixtures,name))});await page.getByRole('button',{name:'打开文本文件',exact:true}).click();}
async function fixtureHashes(){return Object.fromEntries(await Promise.all([...Object.keys(fixtureContent),invalidName].map(async name=>[name,hash(await readFile(path.join(fixtures,name)))])));}
async function savedBodies(){const snapshot=await invoke('text_restore');return {snapshot,hashes:Object.fromEntries(await Promise.all(snapshot.documents.map(async doc=>[doc.id,hash(await invoke('text_recover',{id:doc.id}))])))};}
async function stop(){
 if(owner?.exitCode===null){
  try{await ready();let transportError;try{await invoke('exit_app');}catch(error){transportError=error;}await expect.poll(()=>owner.exitCode,{timeout:10000}).toBe(0);if(transportError){assert.match(String(transportError),/Target page, context or browser has been closed/);report.exitConnectionClosed=String(transportError);}}
  catch(error){if(owner.exitCode===null){assert.equal(path.resolve(owner.spawnfile).toLowerCase(),runningExecutable.toLowerCase());await command('taskkill.exe',['/PID',String(owner.pid),'/T','/F']);await expect.poll(()=>owner.exitCode,{timeout:10000}).not.toBeNull();}throw error;}
 }
 await browser?.close().catch(()=>{});
}

try{
 const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
 owner=spawn(runningExecutable,[],{env,windowsHide:true,stdio:'ignore'});report.ownerPid=owner.pid;await connect();const initialHashes=await fixtureHashes();
 await page.getByRole('link',{name:'打开共享笔记',exact:true}).click();await expect(page.locator('.note-pane')).toHaveCount(2);await expect(page.locator('.note-pane').nth(1).getByRole('heading',{name:'共享笔记',exact:true})).toBeVisible();
 await page.locator('#nav-text').click();await queueOpen(['父/共享.md']);await expect(page.locator('#panes')).toBeVisible();await expect(page.locator('#text-workspace')).toBeHidden();await expect(page.locator('.note-pane')).toHaveCount(2);assert.equal((await invoke('text_restore')).documents.length,0);
 check('Opening an already-owned note through normal text-open activates its notes owner without another text buffer');
 await page.getByRole('button',{name:'关闭右窗格',exact:true}).click();await expect(page.locator('.note-pane')).toHaveCount(1);await page.locator('#nav-text').click();await queueOpen(['父/共享.md']);await expect(tab('共享.md')).toBeVisible();await expect(content()).toContainText('共享笔记');
 await content().fill('# 本地未保存的共享草稿\n\n原文件必须保持。\n');await page.locator('#nav-notes').click();await page.locator('.tree-row[data-path="父/共享.md"]').click();await expect(page.locator('#text-workspace')).toBeVisible();await expect(tab('共享.md')).toHaveAttribute('aria-selected','true');await expect(content()).toContainText('本地未保存的共享草稿');assert.equal((await invoke('text_restore')).documents.length,1);assert.deepEqual(await fixtureHashes(),initialHashes);
 check('Closing the note owner allows text ownership; a notes-tree click reactivates that same dirty text buffer without saving its original');

 await assert.rejects(invoke('rename_entry',{path:'父',name:'不得改名'}),{code:'text-owned'});await assert.rejects(invoke('recycle_entry',{path:'父'}),{code:'text-owned'});
 const order=await invoke('folder_order');await assert.rejects(invoke('arrange_folder',{action:{root:fixtures,revision:order.revision,source:'父',parent:'目标',placement:'inside'}}),{code:'text-owned'});assert.ok((await stat(path.join(fixtures,'父'))).isDirectory());assert.deepEqual(await fixtureHashes(),initialHashes);
 check('The host rejects ancestor rename, cross-folder move and recycle while text owns a descendant; source bytes and paths remain intact');
 await page.locator('#nav-notes').click();await page.locator('.tree-row[data-path="父"]').click({button:'right'});await page.locator('.context-menu').getByRole('button',{name:'上移',exact:true}).click();
 await expect.poll(async()=>{const value=await invoke('folder_order'),items=value.parents['']??[];return items.indexOf('父')>=0&&items.indexOf('父')<items.indexOf('另一个');}).toBe(true);assert.deepEqual(await fixtureHashes(),initialHashes);
 check('The actual notes-tree same-parent ordering menu remains usable while a text descendant is open');

 await page.locator('#nav-text').click();await queueOpen(['code.xml',invalidName,'config.json']);await expect(tab('config.json')).toHaveAttribute('aria-selected','true');await expect(page.locator('#toast')).toContainText('UTF-8');await expect(page.getByRole('tab')).toHaveCount(3);await expect(tab(invalidName)).toHaveCount(0);await ready();
 const partialOpen=await invoke('text_restore');assert.equal(partialOpen.documents.length,3);assert.ok(!partialOpen.documents.some(doc=>doc.name===invalidName));assert.deepEqual(await readFile(path.join(fixtures,invalidName)),invalidBytes);
 const grants=JSON.parse(await readFile(path.join(data,'text-recovery','grants.json'),'utf8'));assert.equal(Object.keys(grants.records).length,3);assert.ok(!Object.values(grants.records).some(grant=>path.resolve(grant.path).toLowerCase()===path.join(fixtures,invalidName).toLowerCase()));
 check('A partial multi-open failure keeps valid XML/JSON documents, reports invalid UTF-8, and creates no bad-file tab or authorization',{openedNames:partialOpen.documents.map(doc=>doc.name),invalidFileSha256:hash(invalidBytes),grants:Object.keys(grants.records).length});
 await expect(page.getByLabel('代码语言',{exact:true})).toHaveValue('json');await expect(content().locator('[class*="tok-"]').first()).toBeVisible();
 await tab('code.xml').click();await expect(page.getByLabel('代码语言',{exact:true})).toHaveValue('xml');await expect(content().locator('[class*="tok-"]').first()).toBeVisible();assert.deepEqual(await fixtureHashes(),initialHashes);
 const externalScripts=report.resourceRequests.filter(url=>{try{const address=new URL(url);return ['http:','https:'].includes(address.protocol)&&!['tauri.localhost','asset.localhost','ipc.localhost','localhost','127.0.0.1'].includes(address.hostname);}catch{return false;}});assert.deepEqual(externalScripts,[]);
 check('Release JSON and XML languages are selected by extension and visibly colored using local bundled script resources',{scriptRequests:[...new Set(report.resourceRequests)]});

 await page.getByRole('button',{name:'新建文本',exact:true}).click();await content().fill('a'.repeat(32)+'!');await content().press('Control+f');await page.getByRole('checkbox',{name:'正则表达式',exact:true}).check();await page.getByLabel('查找内容',{exact:true}).fill('(a+)+$');await expect(page.locator('.text-search-result')).toContainText('1,500',{timeout:6000});
 await page.getByRole('button',{name:'关闭查找',exact:true}).click();await content().press('Control+End');await page.keyboard.insertText('超时后继续输入');await expect(content()).toContainText('超时后继续输入');await expect.poll(()=>page.workers().length).toBe(0);
 check('A real catastrophic regex worker times out while the release UI stays usable and accepts subsequent text input');
 await content().press('Control+f');await page.getByRole('checkbox',{name:'正则表达式',exact:true}).check();await page.getByLabel('查找内容',{exact:true}).fill('(a+)+$');await expect(page.locator('.text-search-result')).toHaveText('正在查找…');await expect.poll(()=>page.workers().length,{timeout:1200}).toBeGreaterThan(0);
 const cancelledAt=performance.now();await page.getByRole('button',{name:'关闭查找',exact:true}).click();await expect(page.locator('.text-search')).toBeHidden();await expect.poll(()=>page.workers().length).toBe(0);await content().press('Control+End');await page.keyboard.insertText('取消后继续输入');await expect(content()).toContainText('取消后继续输入');
 check('Closing active search terminates its real dedicated worker and prevents late task UI from blocking further editing',{releaseMs:performance.now()-cancelledAt});

 for(let index=1;index<=8;index++){await page.getByRole('button',{name:'新建文本',exact:true}).click();await content().fill('原生保留草稿 '+index);}
 await expect(page.getByRole('tab')).toHaveCount(12);await ready();const beforeThirteen=await savedBodies();assert.equal(beforeThirteen.snapshot.documents.length,12);await page.getByRole('button',{name:'新建文本',exact:true}).click();await expect(page.locator('#toast')).toContainText('12');await expect(page.getByRole('tab')).toHaveCount(12);await expect(content()).toContainText('原生保留草稿 8');
 const afterThirteen=await savedBodies();assert.deepEqual(afterThirteen.snapshot.documents.map(doc=>doc.id),beforeThirteen.snapshot.documents.map(doc=>doc.id));assert.deepEqual(afterThirteen.hashes,beforeThirteen.hashes);
 await tab('共享.md').click();await expect(content()).toContainText('本地未保存的共享草稿');await page.getByRole('button',{name:'双视图',exact:true}).click();await expect(page.locator('.text-pane')).toHaveCount(2);const visibleIds=await page.locator('.text-pane').evaluateAll(nodes=>nodes.map(node=>node.dataset.document));assert.equal(new Set(visibleIds).size,2);await expect(page.locator('.cm-editor')).toHaveCount(2);await expect(page.getByRole('tab')).toHaveCount(12);await ready();assert.deepEqual(await fixtureHashes(),initialHashes);
 check('Twelve native tabs and two distinct visible editors retain all buffers; a thirteenth tab is rejected without eviction or source-file writes',{documentIds:afterThirteen.snapshot.documents.map(doc=>doc.id),bodySha256:afterThirteen.hashes,visibleIds});
 await page.screenshot({path:path.join(workspace,'docs','verification','text-editor-workspace-native.png')});

 if(nativeRootPicker){
  const targetDirectory=path.join(data,'更换后的独立笔记库');await mkdir(targetDirectory);await ready();const beforePicker=await savedBodies();assert.equal(beforePicker.snapshot.documents.length,12);
  await page.locator('#nav-notes').click();await expect(page.locator('#panes')).toBeVisible();await ready();
  coordination={status:'awaiting-native-root-picker',executable:runningExecutable,source,sha256:report.sha256,pid:owner.pid,port,data,fixtures,targetDirectory,reportPath,documentIds:beforePicker.snapshot.documents.map(doc=>doc.id),bodySha256:beforePicker.hashes,generation:beforePicker.snapshot.generation,timeoutMs:120000,waitStartedAt:new Date().toISOString()};
  await writeFile(coordinationPath,JSON.stringify(coordination,null,2));console.log('NATIVE_ROOT_PICKER_WAIT: Root must use the real Windows directory picker; this script does not open it or fabricate its result.');console.log(JSON.stringify({coordinationPath,pid:owner.pid,port,targetDirectory,timeoutMs:120000}));
  await expect.poll(async()=>{const settings=await invoke('get_settings');return typeof settings.root==='string'&&path.resolve(settings.root).toLowerCase()===path.resolve(targetDirectory).toLowerCase();},{timeout:120000,intervals:[250,500,1000],message:'Waiting for the human-operated native folder picker to commit this exact synthetic target.'}).toBe(true);
  await expect.poll(()=>page.locator('#nav-text').evaluate(element=>!element.closest('[inert]'))).toBe(true);const afterPicker=await savedBodies();assert.deepEqual(afterPicker.snapshot.documents.map(doc=>doc.id),beforePicker.snapshot.documents.map(doc=>doc.id));assert.deepEqual(afterPicker.hashes,beforePicker.hashes);assert.deepEqual(await fixtureHashes(),initialHashes);
  await page.locator('#nav-text').click();await expect(page.getByRole('tab')).toHaveCount(12);await tab('共享.md').click();await expect(content()).toContainText('本地未保存的共享草稿');await expect(page.locator('.text-document-state')).toContainText('未保存到原文件');await content().press('Control+End');await page.keyboard.insertText('\n换库后继续输入');await expect(content()).toContainText('换库后继续输入');await ready();assert.deepEqual(await fixtureHashes(),initialHashes);
  const shared=afterPicker.snapshot.documents.find(doc=>doc.name==='共享.md');assert.ok(shared);const continuedBody=await invoke('text_recover',{id:shared.id});assert.ok(continuedBody.endsWith('换库后继续输入'));
  check('A human-operated native notes-directory picker changes the library while all twelve text IDs/bodies survive and a dirty buffer remains editable',{fromRoot:fixtures,toRoot:targetDirectory,documentIds:afterPicker.snapshot.documents.map(doc=>doc.id),bodySha256:afterPicker.hashes,continuedDocumentId:shared.id,continuedBodySha256:hash(continuedBody)});
  coordination.status='completed';coordination.completedAt=new Date().toISOString();await writeFile(coordinationPath,JSON.stringify(coordination,null,2));
 }else report.pendingChecks.push({name:'Change notes library through the actual native directory picker while keeping text tabs',reason:'Run with --native-root-picker to pause for a human-operated Windows folder picker. Without that flag, this harness does not fabricate a result or substitute direct set_workspace IPC for UI coverage.'});
 assert.equal(report.pageErrors.length,0,report.pageErrors.join('\n'));report.status=report.pendingChecks.length?'partial':'passed';
}catch(error){report.status='failed';report.error=String(error?.stack??JSON.stringify(error));if(coordination){coordination.status='failed';coordination.error=report.error;}throw error;}
finally{await stop().catch(error=>{report.cleanupError=String(error);report.status='failed';process.exitCode=1;});report.completedAt=new Date().toISOString();if(coordination){coordination.ownerExited=owner?.exitCode!==null;coordination.harnessCompletedAt=report.completedAt;await writeFile(coordinationPath,JSON.stringify(coordination,null,2));}await writeFile(reportPath,JSON.stringify(report,null,2));}
