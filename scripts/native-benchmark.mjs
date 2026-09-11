// Runs against this project's release build and generated fixtures only.
// WEBVIEW2 remote debugging and SHIYE_PROFILE are enabled only by this harness.
import { chromium, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2] || 'all';
const data = path.join(root, '.qa', 'benchmark-' + phase);
const output = path.join(root, 'docs', 'verification', 'raw');
await mkdir(data, { recursive: true }); await mkdir(output, { recursive: true });
if(['all','edges'].includes(phase))await unlink(path.join(root,'.qa','notes','QA-copy.md')).catch(e=>{if(e.code!=='ENOENT')throw e;});
const exe = phase==='install'?path.join(root,'.qa','installed','shiye.exe'):path.join(data, 'shiye.exe');
if(phase!=='install')await copyFile(path.join(root, 'src-tauri', 'target', 'release', 'shiye.exe'), exe);
await writeFile(path.join(data, 'wake.jsonl'), '');
await writeFile(path.join(data, 'settings.json'), JSON.stringify({root:path.join(root,'.qa','notes'),floating:true,session:{module:'notes',expanded:[],panes:[{path:'A.md',mode:'edit',cursor:0,scroll:0}]}}));
const env = {...process.env, SHIYE_DATA_DIR:data, SHIYE_PROFILE:'1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9223'};
let child = spawn(exe, [], {env, windowsHide:true, stdio:'ignore'});
await writeFile(path.join(data, 'pid.txt'), String(child.pid));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const log = (message) => console.log(new Date().toISOString(), message);
let browser,page;
const invoke = async (command,args={}) => {
 let timer;
 try{const reply=await Promise.race([page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args).then(value=>({value}),fault=>({fault})),[command,args]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('IPC timeout: '+command)),15000);})]);
 if('fault' in reply)throw reply.fault;return reply.value;}finally{clearTimeout(timer);}
};
async function connect(){
 for(let attempt=0;attempt<100;attempt++){
  try{browser=await chromium.connectOverCDP('http://127.0.0.1:9223',{timeout:2000});page=browser.contexts()[0].pages()[0];if(page){page.setDefaultTimeout(15000);await page.locator('#app .app-header').waitFor({timeout:10000});return;}}catch{}
  await sleep(100);
 }
 throw new Error('Cannot attach to the fixture WebView2. Close other QA copies first.');
}
async function show(){spawn(exe,[],{env,windowsHide:true,stdio:'ignore'}).unref();}
async function hide(){await page.locator('#hide').click();await expect.poll(async()=>invoke('get_settings').then(s=>s.session.panes.length)).toBeGreaterThan(0);await sleep(100);}
async function state(mode='edit',dual=false){
 await invoke('save_snapshot',{snapshot:{module:'notes',expanded:[],panes:(dual?['A.md','B.md']:['A.md']).map(path=>({path,mode,cursor:0,scroll:0}))}});
 await page.reload();await expect(page.locator('.note-pane')).toHaveCount(dual?2:1);await expect(page.locator(mode==='edit'?'.cm-content':'.article')).toHaveCount(dual?2:1);
}
async function sample(name,count=30){
 const file=path.join(output,name+'.json');
 await exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','measure-memory-pdh.ps1'),'-AppPid',String(child.pid),'-Samples',String(count),'-OutputPath',file],{cwd:root,maxBuffer:1024*1024});
 const report=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));log(name+': '+report.p95MiB+' MiB');return report;
}
const results={phase,started:new Date().toISOString(),pid:child.pid,sha256:createHash('sha256').update(await readFile(exe)).digest('hex'),instrumentation:'WebView2 CDP on localhost:9223; SHIYE_PROFILE=1; full descendant process counters',measurements:[],checks:[]};
async function fixture(mode,held=false){
 const helper=spawn('python',[path.join(root,'scripts','windows-fixture.py'),mode],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 await new Promise((resolve,reject)=>{helper.stdout.once('data',data=>String(data).includes('READY')?resolve():reject(new Error('Fixture failed')));helper.once('error',reject);helper.once('exit',code=>{if(code)reject(new Error('Fixture exit '+code));});});
 if(!held)helper.stdin.end();return ()=>helper.stdin.end();
}
try{
 await connect();await expect(page.locator('.cm-content')).toHaveCount(1);
 expect((await invoke('get_settings')).root.toLowerCase()).toBe(path.join(root,'.qa','notes').toLowerCase());
 if(phase==='install'){
  await page.context().route('**/*',route=>{const url=new URL(route.request().url());return ['tauri.localhost','ipc.localhost','localhost'].includes(url.hostname)?route.continue():route.abort();});
  const created=await invoke('create_entry',{parent:'',name:'installer-check-'+Date.now(),folder:false});
  const note=await invoke('read_note',{path:created,allowLarge:false});await invoke('save_note',{path:created,text:'# 安装验收\n\n离线保存与退出重开。',version:note.version});
  await invoke('save_snapshot',{snapshot:{module:'notes',expanded:[],panes:[{path:created,mode:'preview',cursor:0,scroll:0}]}});
  await invoke('exit_app').catch(()=>{});await expect.poll(()=>child.exitCode).toBe(0);
  child=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});results.restartedPid=child.pid;await connect();await expect(page.locator('.article')).toContainText('离线保存与退出重开。');
  await invoke('recycle_entry',{path:created});await expect(invoke('read_note',{path:created,allowLarge:false})).rejects.toMatchObject({code:'missing'});
  results.checks.push({name:'Installed executable launches from installation directory, saves with external networking blocked, exits, reopens persisted session and recycles its fixture',pass:true});
 }
 if(['all','edges'].includes(phase)){
  const check=name=>{results.checks.push({name,pass:true});log(name);};
  const original=await invoke('get_settings');
  await expect(invoke('set_workspace',{root:path.join(data,'does-not-exist')})).rejects.toMatchObject({code:'missing'});
  expect((await invoke('get_settings')).root).toBe(original.root);check('invalid root preserves configured workspace');
  const release=await fixture('hotkey',true);
  try{await expect(invoke('update_settings',{shortcut:'Control+Alt+F12',floating:true})).rejects.toMatchObject({code:'shortcut'});expect((await invoke('get_settings')).shortcut).toBe(original.shortcut);check('native hotkey conflict preserves previous shortcut');}finally{release();}
  await page.locator('#nav-clipboard').click();
  await fixture('text');await expect(page.locator('#clip-text')).toHaveText('剪贴板验收 Shiye 2026');check('Windows clipboard listener displays current text');
  await fixture('large');await sleep(150);await page.locator('#clip-refresh').click();
  try{await expect(page.locator('#clip-status')).toContainText('前 1 MiB');}catch(e){log('clipboard error: '+(await page.locator('#clip-text').textContent()).slice(0,160));throw e;}
  const clip=await invoke('read_clipboard');expect(Buffer.byteLength(clip.text)).toBeLessThanOrEqual(1048576);expect(clip.text).not.toContain('\uFFFD');expect(clip.truncated).toBe(true);check('large Unicode clipboard bounded to 1 MiB without broken characters');
  await sample('large-clipboard',5);
  await fixture('nontext');await expect.poll(()=>invoke('read_clipboard').then(c=>c.status)).toBe('unsupported');await expect(page.locator('#clip-text')).not.toContainText('剪贴板验收 Shiye');
  await fixture('empty');await expect(page.locator('#clip-text')).toContainText('空');check('non-text and empty clipboard replace previous text');
  await fixture('text');const unlock=await fixture('busy',true);
  try{await page.locator('#clip-refresh').click();await expect(page.locator('#clip-status')).toContainText('读取失败');check('busy clipboard reports failure');}finally{unlock();}
  await sleep(200);await page.locator('#clip-refresh').click();await expect(page.locator('#clip-text')).toHaveText('剪贴板验收 Shiye 2026');
  await page.locator('#nav-notes').click();await expect(page.locator('#clip-text')).toHaveCount(0);check('leaving clipboard releases displayed snapshot');
  await writeFile(path.join(root,'.qa','notes','QA.md'),'# 验收\n\n[打开 B](B.md)\n');
  await invoke('save_snapshot',{snapshot:{module:'notes',expanded:[],panes:[{path:'QA.md',mode:'edit',cursor:0,scroll:0}]}});await page.reload();
  const editor=page.locator('.cm-content');await editor.fill('# 中文验收\n\n保存以后重开。');await editor.press('Control+s');await expect(page.locator('.save-state')).toHaveText('已保存到本地');
  await page.reload();await expect(editor).toContainText('保存以后重开。');check('Chinese edit save and reload use actual local file');
  await editor.fill('# 未保存的本地修改');await writeFile(path.join(root,'.qa','notes','QA.md'),'# 外部修改');await editor.press('Control+s');await expect(page.locator('.note-error')).toBeVisible();
  await page.locator('#hide').click();await expect(editor).toContainText('未保存的本地修改');expect(await readFile(path.join(root,'.qa','notes','QA.md'),'utf8')).toBe('# 外部修改');check('conflict blocks hide and preserves local buffer plus external file');
  await page.locator('.note-error button').click();await page.getByRole('button',{name:'另存本地副本',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('QA-copy');await page.getByRole('button',{name:'保存副本',exact:true}).click();
  await expect(page.locator('.save-state')).toHaveText('已保存到本地');expect(await readFile(path.join(root,'.qa','notes','QA-copy.md'),'utf8')).toBe('# 未保存的本地修改');check('conflict save-copy preserves both versions');
  await page.getByRole('tree').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.locator('[role="treeitem"][title="large.md"]').click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.locator('.note-title strong')).toHaveText('QA-copy');check('large-file cancel leaves layout intact');
  await page.locator('[role="treeitem"][title="large.md"]').click();await page.getByRole('button',{name:'继续加载',exact:true}).click();await expect(page.locator('.note-title strong')).toHaveText('large');
  await page.getByRole('button',{name:'编辑模式',exact:true}).click();await expect(page.locator('.cm-content')).toBeVisible();await sample('over-two-mib-long-line',5);check('large long-line note loads completely after explicit continuation');
  await page.getByRole('tree').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.locator('[role="treeitem"][title="two-mib.md"]').click();await expect(page.locator('.note-title strong')).toHaveText('two-mib');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'编辑模式',exact:true}).click();expect(await page.locator('.cm-line').count()).toBeLessThan(300);await sample('two-mib-editor',5);check('exact 2 MiB note uses a bounded editor DOM');
  await copyFile(path.join(root,'src-tauri','icons','icon.png'),path.join(root,'.qa','notes','local.png'));await writeFile(path.join(root,'.qa','notes','images.md'),'# 图片验收\n\n![本地](local.png)\n\n![远程](https://example.com/private.png)\n');
  await page.locator('#refresh').click();await page.getByRole('tree').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.locator('[role="treeitem"][title="images.md"]').click();await expect(page.locator('.article img')).toHaveCount(1);await expect(page.locator('.article')).toContainText('远程或库外图片');await sample('local-image',5);check('local image renders while remote image remains a placeholder');
  await page.screenshot({path:path.join(root,'docs','verification','native-edges.png')});
 }
 if(['all','memory'].includes(phase)){
  for(let round=1;round<=3;round++){
   for(const [name,mode,dual,budget] of [['single-edit','edit',false,200],['single-preview','preview',false,200],['dual-edit','edit',true,260],['dual-preview','preview',true,260]]){
    await state(mode,dual);log(name+' stabilization 10 s, round '+round);await sleep(10000);
    const report=await sample(name+'-'+round);results.measurements.push({name,round,p95MiB:report.p95MiB,budget,pass:report.p95MiB<=budget});
   }
   await hide();log('hidden idle unload 65 s, round '+round);await sleep(65000);
   const report=await sample('hidden-'+round);results.measurements.push({name:'hidden',round,p95MiB:report.p95MiB,budget:120,pass:report.p95MiB<=120});
   if(report.samples.some(s=>s.processes.some(p=>/msedgewebview2/i.test(p.Name))))throw new Error('Idle WebView2 did not unload');
   await show();await connect();
  }
 }
 if(['all','stress'].includes(phase)){
  for(let round=1;round<=3;round++){
   await state('edit',true);
   async function operation(){
    const pane=page.locator('.note-pane').first(),editor=pane.locator('.cm-content');
    await editor.click();await editor.press('Control+Home');await editor.press('End');await editor.press('!');await editor.press('Backspace');await editor.press('Control+s');
    await expect(pane.locator('.save-state')).toHaveText('已保存到本地');
    await pane.getByRole('button',{name:'显示模式',exact:true}).click();await pane.getByRole('link',{name:'打开 B',exact:true}).click();
    await page.locator('.note-pane').nth(1).getByRole('button',{name:'显示模式',exact:true}).click();
    await page.locator('.note-pane').nth(1).getByRole('link',{name:'打开 C',exact:true}).click();
    await expect(page.locator('.note-pane').first().locator('.note-title strong')).toHaveText('B');
    await page.getByRole('button',{name:'关闭右窗格'}).click();
    await page.locator('#nav-clipboard').click();await page.locator('#nav-notes').click();
    await hide();await show();await expect(page.locator('.note-pane')).toHaveCount(1);
    // Use the same public snapshot/restore protocol to reset A|B between complete cycles.
    // Reload is deliberately avoided here: keep the same WebView for the entire 100-cycle run.
    await page.getByRole('tree').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    await page.locator('[role="treeitem"][title="A.md"]').click();
    await page.locator('.note-pane').first().getByRole('button',{name:'显示模式',exact:true}).click();
    await page.getByRole('link',{name:'打开 B',exact:true}).click();
    for(let index=0;index<2;index++)await page.locator('.note-pane').nth(index).getByRole('button',{name:'编辑模式',exact:true}).click();
   }
   for(let warmup=0;warmup<10;warmup++)await operation();
   log('stress baseline stabilization 60 s after 10 warmup cycles');await sleep(60000);const before=await sample('stress-before-'+round,5);
   for(let cycle=0;cycle<100;cycle++){await operation();if((cycle+1)%10===0)log('stress round '+round+': '+(cycle+1)+'/100');}
   log('stress settle 60 s');await sleep(60000);const after=await sample('stress-after-'+round,5);
   const average=(report,key)=>report.samples.reduce((sum,s)=>sum+s[key],0)/report.samples.length/1048576;
   const wsDelta=average(after,'privateWorkingSet')-average(before,'privateWorkingSet'),privateDelta=average(after,'privateBytes')-average(before,'privateBytes');
   results.measurements.push({name:'100-cycle-retention',round,wsDelta,privateDelta,budget:20,pass:wsDelta<=20&&privateDelta<=20});
  }
 }
 if(['all','wake'].includes(phase)){
  await state('edit',true);await sleep(1000);await writeFile(path.join(data,'wake.jsonl'),'');
  for(let i=0;i<30;i++){await hide();await show();await expect(page.locator('.cm-content')).toHaveCount(2);await sleep(400);}
  for(let i=0;i<30;i++){
   await hide();await invoke('profile_unload').catch(()=>{});await sleep(150);await show();await connect();await expect(page.locator('.cm-content')).toHaveCount(2);await sleep(400);
   if((i+1)%10===0)log('cold wake '+(i+1)+'/30');
  }
  const samples=(await readFile(path.join(data,'wake.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  await writeFile(path.join(output,'wake-samples.json'),JSON.stringify(samples,null,2));
  for(const cold of [false,true]){const times=samples.filter(s=>s.cold===cold).map(s=>s.elapsedMs).sort((a,b)=>a-b),p95=times[Math.ceil(times.length*0.95)-1],budget=cold?1000:300;results.measurements.push({name:cold?'cold-wake':'warm-wake',samples:times.length,p95,budget,pass:times.length>=30&&p95<=budget});}
 }
 results.completed=new Date().toISOString();await writeFile(path.join(output,phase+'-summary.json'),JSON.stringify(results,null,2));
 log(JSON.stringify(results.measurements));
}finally{
 await writeFile(path.join(output,phase+'-summary.json'),JSON.stringify(results,null,2));
 if(page&&!page.isClosed())await invoke('exit_app').catch(()=>{});
 // The only process created by this harness, never a user's existing workbench.
 if(child.exitCode===null)child.kill();
}
