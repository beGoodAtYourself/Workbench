// This harness only uses the startupqa identity and its fixed, disposable Run value.
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,rename,rmdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(workspace,process.argv[2]||'src-tauri/target/startup/qa/shiye-startup-qa.exe');
if(!source.startsWith(path.join(workspace,'src-tauri','target')+path.sep))throw new Error('The QA source must be inside this workspace target directory.');
const binary=await readFile(source);
if(!binary.includes(Buffer.from('local.shiye.workbench.startupqa')))throw new Error('An isolated startupqa build is required.');
const data=path.join(workspace,'.qa','startup-native-'+Date.now());
const exe=path.join(data,'中文 空格','shiye-startup-qa.exe'),otherExe=path.join(data,'另一副本','shiye-startup-qa.exe');
const notes=path.join(data,'notes'),settingsPath=path.join(data,'settings.json');
const output=path.join(workspace,'docs','verification'),reportPath=path.join(output,'raw','startup-native.json');
for(const directory of [path.dirname(exe),path.dirname(otherExe),notes,path.dirname(reportPath)])await mkdir(directory,{recursive:true});
await copyFile(source,exe);await copyFile(source,otherExe);
await writeFile(path.join(notes,'登录恢复.md'),'# 登录恢复\n\n此文档只用于隔离验收。\n');
const initialSettings={root:notes,shortcut:'Control+Alt+F11',floating:false,session:{module:'notes',expanded:[],panes:[{path:'登录恢复.md',mode:'preview',cursor:0,scroll:0}]}};
await writeFile(settingsPath,JSON.stringify(initialSettings));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_AUTOSTART_QA:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={date:new Date().toISOString(),source,sha256:hash(binary),executable:exe,data,checks:[],configuration:'Release code and assets with isolated startupqa identifier, fixed startupqa Run value, and synthetic note library. Simulated login arguments and real WebView2; this does not replace an actual sign-out/sign-in acceptance.'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Win32 library message targets carry WS_VISIBLE but are not application surfaces.
const visibleSurface=item=>item.visible&&item.width>0&&item.height>0&&!['local.shiye.workbench.startupqa-sic','Tao Thread Event Target'].includes(item.className);
async function probe(action,fields={}){
 const args=['-NoProfile','-File',path.join(workspace,'scripts','startup-native-probe.ps1'),'-Action',action];
 for(const [key,value] of Object.entries(fields))args.push('-'+key,String(value));
 const task=spawn('powershell.exe',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 task.stdout.setEncoding('utf8');task.stdout.on('data',value=>stdout+=value);task.stderr.setEncoding('utf8');task.stderr.on('data',value=>stderr+=value);
 const code=await new Promise((resolve,reject)=>{task.on('error',reject);task.on('exit',resolve);});
 if(code!==0)throw new Error('Native probe failed: '+stderr);return stdout.trim()?JSON.parse(stdout.trim()):null;
}
function launch(background=false){
 const child=spawn(exe,background?['--autostart']:[],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});
 child.stderr.setEncoding('utf8');child.stderr.on('data',value=>{report.stderr=(report.stderr||'')+value;});return child;
}
function check(name,details){report.checks.push({name,pass:true,...(details?{details}:{})});console.log(name);}
let owner,browser,page,initialRegistry,settingsBackup;
async function connect(){
 for(let attempt=0;attempt<100;attempt++){
  if(owner.exitCode!==null)throw new Error('QA owner exited before its WebView was ready.');
  try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});page=browser.contexts()[0].pages()[0];if(page){page.setDefaultTimeout(12000);await page.locator('#tree').waitFor();return;}}catch{}
  await delay(150);
 }
 throw new Error('Cannot attach to the QA WebView2.');
}
async function invoke(command,args={}){
 const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error};}},[command,args]);
 if(!result.ok)throw result.error;return result.value;
}
async function expectSecondary(background){const child=launch(background);await expect.poll(()=>child.exitCode,{timeout:12000}).toBe(0);expect(owner.exitCode).toBeNull();return child.pid;}
async function exit(){await invoke('exit_app');await expect.poll(()=>owner.exitCode).toBe(0);await browser?.close().catch(()=>{});browser=undefined;page=undefined;}
async function settings(){await page.locator('#settings').click();await expect(page.locator('dialog')).toBeVisible();return page.locator('dialog');}
try{
 initialRegistry=await probe('read');if(initialRegistry.qa!==null)throw new Error('The disposable startupqa Run value already exists; refusing to overwrite it.');
 owner=launch(true);report.ownerPid=owner.pid;await delay(2000);expect(owner.exitCode).toBeNull();
 const background=await probe('process',{OwnerProcessId:owner.pid});report.background=background;
 expect(background.children.some(item=>item.name.toLowerCase().includes('msedgewebview2'))).toBe(false);expect(background.windows.some(visibleSurface)).toBe(false);
 expect(await probe('read')).toEqual(initialRegistry);check('Automatic launch creates no visible owner window or WebView2 children and does not register itself');
 report.repeatBackgroundPid=await expectSecondary(true);const repeated=await probe('process',{OwnerProcessId:owner.pid});expect(repeated.windows.some(visibleSurface)).toBe(false);expect(repeated.children.some(item=>item.name.toLowerCase().includes('msedgewebview2'))).toBe(false);
 check('A repeated automatic launch exits without opening the owning host');
 report.manualLauncherPid=await expectSecondary(false);report.manualWake=await probe('process',{OwnerProcessId:owner.pid});await connect();await expect(page.locator('.article')).toContainText('此文档只用于隔离验收');check('A manual second launch wakes the same owner and restores its previous note');
 let dialog=await settings();await expect(dialog.getByLabel('开机自启动',{exact:true})).not.toBeChecked();await dialog.getByLabel('开机自启动',{exact:true}).check();await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog).toHaveCount(0);
 let status=await invoke('get_autostart_status');expect(status.state).toBe('enabled');expect(status.target.toLowerCase()).toBe(exe.toLowerCase());const enabledRegistry=await probe('read');expect(enabledRegistry.qa).toBe('"'+exe+'" --autostart');expect(enabledRegistry.formal).toBe(initialRegistry.formal);
 check('Enabling registers the quoted Chinese/space executable path in the isolated Run value');
 dialog=await settings();await expect(dialog.getByLabel('开机自启动',{exact:true})).toBeChecked();await page.screenshot({path:path.join(output,'startup-native-settings.png')});await dialog.getByLabel('开机自启动',{exact:true}).uncheck();await dialog.getByRole('button',{name:'取消',exact:true}).click();expect((await probe('read')).qa).toBe(enabledRegistry.qa);check('Cancel leaves the registered login command unchanged');
 const otherCommand='"'+otherExe+'" --autostart';await probe('write',{Value:otherCommand});
 await expect(invoke('update_settings',{shortcut:initialSettings.shortcut,floating:false,autostart:{enabled:false,revision:status.revision}})).rejects.toHaveProperty('code','autostart-conflict');expect((await probe('read')).qa).toBe(otherCommand);
 status=await invoke('get_autostart_status');expect(status.state).toBe('other');
 await invoke('update_settings',{shortcut:initialSettings.shortcut,floating:false,autostart:{enabled:false,revision:status.revision}});expect((await probe('read')).qa).toBe(otherCommand);
 dialog=await settings();await expect(dialog.getByLabel('开机自启动',{exact:true})).not.toBeChecked();await expect(dialog).toContainText('另一');await dialog.getByLabel('开机自启动',{exact:true}).check();await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog).toHaveCount(0);status=await invoke('get_autostart_status');expect(status.state).toBe('enabled');
 check('Stale revisions are rejected, disabling preserves another copy, and explicit enable switches to the current copy');
 settingsBackup=settingsPath+'.backup';await rename(settingsPath,settingsBackup);await mkdir(settingsPath);
 try{
  await expect(invoke('update_settings',{shortcut:'Control+Alt+F10',floating:true,autostart:{enabled:false,revision:status.revision}})).rejects.toHaveProperty('message');
  expect((await probe('read')).qa).toBe(enabledRegistry.qa);const restored=await invoke('get_settings');expect(restored.shortcut).toBe(initialSettings.shortcut);expect(restored.floating).toBe(false);
 }finally{await rmdir(settingsPath);await rename(settingsBackup,settingsPath);settingsBackup=undefined;}
 check('A real settings-file replacement failure restores the original Run value and in-memory preferences');
 await probe('delete');dialog=await settings();await expect(dialog.getByLabel('开机自启动',{exact:true})).not.toBeChecked();await dialog.getByRole('button',{name:'保存设置',exact:true}).click();expect((await probe('read')).qa).toBeNull();check('External removal refreshes the checkbox; saving unchanged preferences does not recreate the value');
 status=await invoke('get_autostart_status');await invoke('update_settings',{shortcut:initialSettings.shortcut,floating:false,autostart:{enabled:true,revision:status.revision}});
 const visibleBefore=await probe('process',{OwnerProcessId:owner.pid});await expectSecondary(true);const visibleAfter=await probe('process',{OwnerProcessId:owner.pid});expect(visibleAfter.windows.filter(item=>item.visible).map(item=>item.title)).toEqual(visibleBefore.windows.filter(item=>item.visible).map(item=>item.title));
 check('Repeated automatic startup preserves an already visible main window');
 const oldPage=page,closed=oldPage.waitForEvent('close',{timeout:75000});const start=performance.now();await page.locator('#hide').click();console.log('Waiting for the real 60-second hidden WebView unload.');await closed;report.hiddenUnloadMs=performance.now()-start;expect(report.hiddenUnloadMs).toBeGreaterThanOrEqual(59000);expect(owner.exitCode).toBeNull();await browser?.close().catch(()=>{});browser=undefined;page=undefined;
 await expectSecondary(true);const unloaded=await probe('process',{OwnerProcessId:owner.pid});expect(unloaded.windows.some(visibleSurface)).toBe(false);await expectSecondary(false);await connect();await expect(page.locator('.article')).toContainText('此文档只用于隔离验收');check('The real 60-second unload remains functional; automatic repeats stay hidden and manual launch restores the note');
 await exit();expect((await probe('read')).qa).toBe(enabledRegistry.qa);await delay(600);expect(owner.exitCode).toBe(0);check('Explicit exit releases the owner while retaining login registration');
 owner=launch(true);await delay(1500);expect(owner.exitCode).toBeNull();const restarted=await probe('process',{OwnerProcessId:owner.pid});expect(restarted.windows.some(visibleSurface)).toBe(false);expect(restarted.children.some(item=>item.name.toLowerCase().includes('msedgewebview2'))).toBe(false);await expectSecondary(false);await connect();check('A subsequent registered background launch remains lazy and can be woken manually');
 status=await invoke('get_autostart_status');await invoke('update_settings',{shortcut:initialSettings.shortcut,floating:false,autostart:{enabled:false,revision:status.revision}});expect((await probe('read')).qa).toBeNull();await exit();check('Disabling removes only the QA registration and explicit exit completes');
 const invalidSettings=JSON.parse(await readFile(settingsPath,'utf8'));invalidSettings.shortcut='NotAKey';await writeFile(settingsPath,JSON.stringify(invalidSettings));
 owner=launch(true);await delay(1500);const invalidBackground=await probe('process',{OwnerProcessId:owner.pid});expect(invalidBackground.windows.some(visibleSurface)).toBe(false);await expectSecondary(false);await connect();await expect(page.locator('#toast')).toContainText('快捷键注册失败');
 await invoke('update_settings',{shortcut:initialSettings.shortcut,floating:false,autostart:null});expect((await invoke('get_settings')).startupError).toBeNull();await exit();check('A background shortcut failure is deferred to first wake and can be repaired through settings');
 report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack||JSON.stringify(error));throw error;}
finally{
 if(page&&!page.isClosed()&&owner?.exitCode===null)await invoke('exit_app').catch(()=>{});
 if(owner?.exitCode===null){await delay(400);if(owner.exitCode===null)owner.kill();}await browser?.close().catch(()=>{});
 if(initialRegistry?.qa===null)await probe('delete').catch(error=>{report.cleanupError=String(error);});
 if(initialRegistry) {report.registryAfter=await probe('read').catch(error=>({error:String(error)}));if(report.registryAfter.formal!==initialRegistry.formal)report.formalRegistrationChanged=true;}
 report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));
}
