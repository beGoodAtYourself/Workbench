// Small release WebView2 editing checks. No original file is opened or saved.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(workspace,process.argv.slice(2).find(value=>value.endsWith('.exe'))??'src-tauri/target/text-editor/qa/shiye-text-qa.exe');
const inside=(root,target)=>{const relative=path.relative(root,path.resolve(target));return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
if(!inside(path.join(workspace,'src-tauri','target'),source))throw new Error('Only a QA executable inside this workspace target is allowed.');
const binary=await readFile(source),hash=value=>createHash('sha256').update(value).digest('hex');
if(!binary.includes(Buffer.from('local.shiye.workbench.textqa')))throw new Error('The isolated textqa application identity is required.');
const data=path.join(workspace,'.qa','text-editor-native-'+Date.now()),fixtures=path.join(data,'empty-file-fixtures'),executable=path.join(data,'app','shiye-text-qa.exe');
const reportPath=path.join(workspace,'docs','verification','raw','text-editor-editing.json');
for(const directory of [fixtures,path.dirname(executable),path.dirname(reportPath)])await mkdir(directory,{recursive:true});await copyFile(source,executable);
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:null,shortcut:'Control+Alt+F10',floating:false,session:{module:'text',panes:[],expanded:[]}}));
const listener=createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const report={startedAt:new Date().toISOString(),source,sha256:hash(binary),executable,data,fixtures,port,scope:'Isolated textqa release WebView2, genuine keyboard/mouse editing, code menus and keyboard-operated tab ordering with two untitled drafts. No file picker, original file, user notes or system clipboard mutation.',checks:[],pageErrors:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(name,details){report.checks.push({name,pass:true,...(details===undefined?{}:{details})});console.log(name);}
async function command(program,args){const child=spawn(program,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});if(code!==0)throw new Error(program+' failed ('+code+'): '+stderr);return stdout.trim();}
const existing=await command('powershell.exe',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance Win32_Process -Filter \"Name='shiye-text-qa.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"]),instances=existing?JSON.parse(existing):[],running=Array.isArray(instances)?instances:instances?[instances]:[];
if(running.length){report.status='blocked';report.existingInstances=running;report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));throw new Error('Another textqa owner is running; refusing to attach, wake or terminate it.');}

let owner,browser,page;
async function connect(){let last;for(let attempt=0;attempt<100;attempt++){
 if(owner.exitCode!==null)throw new Error('The isolated QA launcher exited before its own WebView2 became ready.');
 try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});page=browser.contexts()[0].pages()[0];if(!page)throw new Error('No WebView page yet.');page.setDefaultTimeout(12000);page.on('pageerror',error=>report.pageErrors.push(error.message));await page.locator('#text-workspace').waitFor();await expect(page.getByRole('button',{name:'新建文本',exact:true})).toBeEnabled();return;}
 catch(error){last=error;await browser?.close().catch(()=>{});browser=undefined;await delay(150);}
}throw new Error('Cannot attach to the isolated WebView2: '+last);}
async function invoke(command,args={}){const result=await page.evaluate(async([command,args])=>{try{return {ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return {ok:false,error:{code:error?.code,message:error?.message??String(error)}};}},[command,args]);if(!result.ok)throw result.error;return result.value;}
async function ready(){await expect.poll(async()=>{const status=await invoke('profile_text_status');return status.lifecycleReady&&status.generation===status.confirmedGeneration;},{timeout:15000}).toBe(true);}
const editor=()=>page.locator('#text-workspace .cm-content');
const text=()=>editor().locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
async function menu(action,keyboard=false){const summary=page.getByLabel('更多文本操作',{exact:true}),button=page.locator('[data-text-action="'+action+'"]');if(keyboard){await summary.focus();await summary.press('Enter');await button.focus();await button.press('Enter');}else{await summary.click();await button.click();}}
async function stop(){
 if(owner?.exitCode===null){
  try{
   await ready();let transportClosed;
   try{await invoke('exit_app');}catch(error){if(!(error instanceof Error)||!/page\.evaluate: Target (?:page, context or browser has been closed|closed)/.test(error.message))throw error;transportClosed=String(error);}
   await expect.poll(()=>owner.exitCode,{timeout:10000}).not.toBeNull();assert.equal(owner.exitCode,0);report.exitMode='normal';if(transportClosed)report.exitTransportClosed=transportClosed;
  }catch(error){report.normalExitError=String(error);assert.equal(path.resolve(owner.spawnfile).toLowerCase(),executable.toLowerCase());if(owner.exitCode===null)await command('taskkill.exe',['/PID',String(owner.pid),'/T','/F']);await expect.poll(()=>owner.exitCode,{timeout:10000}).not.toBeNull();report.exitMode='forced-cleanup';}
 }else if(owner&&report.status==='passed')throw new Error('The owner exited before the harness requested a normal exit.');
 await browser?.close().catch(()=>{});
}

try{
 const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',SHIYE_TEXT_TEST_ROOT:fixtures,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};owner=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});report.ownerPid=owner.pid;await connect();await page.getByRole('button',{name:'新建文本',exact:true}).click();await expect(editor()).toBeVisible();
 await editor().fill('first\nsecond');await editor().press('Control+Home');await editor().press('End');const line=await editor().locator('.cm-line').nth(1).boundingBox();assert.ok(line);
 await page.keyboard.down('Alt');try{await page.mouse.click(line.x+2,line.y+line.height/2);}finally{await page.keyboard.up('Alt');}await page.keyboard.insertText('X');assert.equal(await text(),'firstX\nXsecond');await editor().press('Control+z');assert.equal(await text(),'first\nsecond');
 check('Real Alt+mouse adds two editable cursors and one undo restores both simultaneous insertions');

 await editor().press('Escape');const scoped='cat cat\ncat cat\ncat cat';await editor().fill(scoped);await editor().press('Control+Home');await editor().press('ArrowDown');await editor().press('Home');await editor().press('Shift+End');await editor().press('Control+h');
 await page.getByLabel('查找内容',{exact:true}).fill('cat');await page.getByRole('checkbox',{name:'仅选区',exact:true}).check();await page.getByLabel('替换内容',{exact:true}).fill('小猫');await expect(page.locator('.text-search-result')).toHaveText('2 处匹配');await page.getByRole('button',{name:'全部替换',exact:true}).click();await expect.poll(text).toBe('cat cat\n小猫 小猫\ncat cat');
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();assert.equal(await text(),scoped);await page.getByRole('button',{name:'关闭查找',exact:true}).click();await expect.poll(()=>page.workers().length).toBe(0);
 check('A captured continuous selection alone is batch-replaced and one undo restores all replacements without changing outside text');

 await editor().fill('中😀\tX\n第二行');await editor().press('Control+g');const dialog=page.getByRole('dialog',{name:'跳转行列'});await dialog.locator('[name="line"]').fill('1');await dialog.locator('[name="column"]').fill('4');await dialog.getByRole('button',{name:'跳转',exact:true}).click();await expect(page.locator('.text-position')).toHaveText('行 1，列 4');await page.keyboard.insertText('|');const unicode='中😀\t|X\n第二行';assert.equal(await text(),unicode);
 check('Unicode line/column navigation counts emoji and Tab as one character each and inserts at the expected position');

 await page.getByLabel('文本编码',{exact:true}).selectOption('utf16be');await page.getByLabel('文件换行',{exact:true}).selectOption('lf');await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(page.getByLabel('文件换行',{exact:true})).toHaveValue('crlf');await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf16be');
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf8');await page.getByRole('button',{name:'重做文本编辑',exact:true}).click();await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf16be');await page.getByRole('button',{name:'重做文本编辑',exact:true}).click();await expect(page.getByLabel('文件换行',{exact:true})).toHaveValue('lf');assert.equal(await text(),unicode);await ready();
 const snapshot=await invoke('text_restore');assert.equal(snapshot.documents.length,1);const doc=snapshot.documents[0];assert.equal(doc.path,null);assert.equal(doc.encoding,'utf16be');assert.equal(doc.eol,'lf');assert.equal(await invoke('text_recover',{id:doc.id}),unicode);assert.deepEqual(await readdir(fixtures),[]);await expect(page.locator('.cm-editor')).toHaveCount(1);assert.equal(report.pageErrors.length,0,report.pageErrors.join('\n'));
 check('Encoding and EOL metadata undo/redo independently while preserving exact Unicode body and a recoverable untitled-only draft',{documentId:doc.id,bodySha256:hash(unicode),encoding:doc.encoding,eol:doc.eol});

 const javascript='function sum(a, b) {\n  return a + b;\n}';await page.getByRole('button',{name:'新建文本',exact:true}).click();await editor().fill(javascript);await page.getByLabel('代码语言',{exact:true}).selectOption('javascript');await expect(editor().locator('[class*="tok-"]').first()).toBeVisible();await editor().press('Control+Home');await editor().press('ArrowDown');await editor().press('Home');
 await menu('indent');const indented=(await text()).split('\n');assert.equal(indented[0],javascript.split('\n')[0]);assert.equal(indented[1].trim(),'return a + b;');assert.ok(indented[1].match(/^\s*/)[0].length>2);await menu('outdent');assert.equal(await text(),javascript);
 await menu('comment');assert.match(await text(),/^\s*\/\/\s*return a \+ b;/m);await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();assert.equal(await text(),javascript);await editor().press('Control+Home');await menu('fold');await expect(editor().locator('.cm-foldPlaceholder')).toBeVisible();await menu('unfold');await expect(editor().locator('.cm-foldPlaceholder')).toHaveCount(0);assert.equal(await text(),javascript);
 check('Actual code menus indent/outdent, comment with undo, and fold/unfold JavaScript while preserving its complete body');

 await ready();const beforeOrder=await invoke('text_restore');assert.equal(beforeOrder.documents.length,2);const second=beforeOrder.documents.find(item=>item.id!==doc.id);assert.ok(second);assert.equal(await invoke('text_recover',{id:second.id}),javascript);
 await menu('move-left',true);await expect.poll(()=>page.getByRole('tab').allTextContents()).toEqual(['未命名 2','未命名 1']);await editor().press('Control+Tab');await expect(page.getByRole('tab',{name:/未命名 1$/})).toHaveAttribute('aria-selected','true');assert.equal(await text(),unicode);await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf16be');await expect(page.getByLabel('文件换行',{exact:true})).toHaveValue('lf');
 await editor().press('Control+Shift+Tab');await expect(page.getByRole('tab',{name:/未命名 2$/})).toHaveAttribute('aria-selected','true');assert.equal(await text(),javascript);await expect(page.getByLabel('代码语言',{exact:true})).toHaveValue('javascript');await ready();const afterOrder=await invoke('text_restore');assert.deepEqual(afterOrder.documents.map(item=>item.id),[second.id,doc.id]);assert.ok(afterOrder.documents.every(item=>item.path===null));assert.equal(await invoke('text_recover',{id:doc.id}),unicode);assert.equal(await invoke('text_recover',{id:second.id}),javascript);assert.deepEqual(await readdir(fixtures),[]);
 check('Keyboard-operated real tab-order menu reorders two drafts; Ctrl+Tab and Ctrl+Shift+Tab preserve both exact bodies and per-document settings',{documentIds:afterOrder.documents.map(item=>item.id),bodySha256:{[doc.id]:hash(unicode),[second.id]:hash(javascript)}});
 assert.equal(report.pageErrors.length,0,report.pageErrors.join('\n'));await page.screenshot({path:path.join(workspace,'docs','verification','text-editor-editing-native.png')});report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack??JSON.stringify(error));throw error;}
finally{await stop().catch(error=>{report.cleanupError=String(error);report.status='failed';process.exitCode=1;});if(report.normalExitError){report.status='failed';process.exitCode=1;}report.ownerExited=!!owner&&owner.exitCode!==null;report.ownerExitCode=owner?.exitCode??null;report.completedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));}
