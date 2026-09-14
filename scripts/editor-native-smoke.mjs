// Run with a QA identifier build, never the user's running application.
// Example: node scripts/editor-native-smoke.mjs src-tauri/target/editor-improvements/release/shiye.exe
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {codeSamples} from '../tests/fixtures/code-samples.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const exe=path.resolve(root,process.argv[2]||'src-tauri/target/editor-improvements/release/shiye.exe');
if(!exe.startsWith(path.join(root,'src-tauri','target')+path.sep))throw new Error('QA executable must be in this workspace target directory.');
const executableBytes=await readFile(exe);
if(!executableBytes.includes(Buffer.from('local.shiye.workbench.editorqa')))throw new Error('Build with scripts/editor-native-config.json first. This harness must not start a production-identity executable.');
const data=path.join(root,'.qa','editor-native-'+Date.now()),notes=path.join(data,'notes');
const output=path.join(root,'docs','verification'),reportPath=path.join(output,'raw','editor-formatting-native.json');
await mkdir(notes,{recursive:true});await mkdir(path.dirname(reportPath),{recursive:true});
await writeFile(path.join(notes,'A.md'),'\uFEFF测试标题\r\n第一行\r\n第二行\r\n\r\n[打开 B](B.md)\r\n');
await writeFile(path.join(notes,'B.md'),'# 右侧笔记\n\n右边的内容。\n');
await writeFile(path.join(data,'settings.json'),JSON.stringify({root:notes,shortcut:'Control+Alt+F11',floating:false,session:{module:'notes',expanded:[],panes:[{path:'A.md',mode:'edit',cursor:0,scroll:0}]}}));
const portServer=createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const env={...process.env,SHIYE_DATA_DIR:data,SHIYE_PROFILE:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port};
let child,browser,page;
const assetNames=['index.html',...(await readdir(path.join(root,'dist','assets'))).map(name=>'assets/'+name)].sort();
const assets=Object.fromEntries(await Promise.all(assetNames.map(async name=>[name,createHash('sha256').update(await readFile(path.join(root,'dist',name))).digest('hex')])));
const results={date:new Date().toISOString(),executable:exe,sha256:createHash('sha256').update(executableBytes).digest('hex'),assets,configuration:'Production code/assets with isolated identifier local.shiye.workbench.editorqa; SHIYE_DATA_DIR fixture; WebView2 CDP automation, not physical input.',data,checks:[],screenshots:[]};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function connect(){
 for(let attempt=0;attempt<100;attempt++){
  if(child.exitCode!==null)throw new Error('QA app exited before WebView2 was ready. Use the isolated QA identifier build.');
  try{
   browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1500});page=browser.contexts()[0].pages()[0];
   if(page){page.setDefaultTimeout(10000);await page.locator('.cm-content').waitFor();return;}
  }catch{}
  await wait(150);
 }
 throw new Error('Cannot attach to the isolated WebView2 fixture.');
}
const invoke=(command,args={})=>page.evaluate(([command,args])=>window.__TAURI_INTERNALS__.invoke(command,args),[command,args]);
async function shot(name){await page.screenshot({path:path.join(output,name)});results.screenshots.push(name);}
function check(name){results.checks.push({name,pass:true});console.log(name);}
async function firstLine(editor){await editor.click();await editor.press('Control+Home');await editor.press('Shift+End');}
try{
 child=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});results.pid=child.pid;await connect();
 expect((await invoke('get_settings')).root).toBe(notes);
 const requests=[];page.on('request',request=>requests.push(request.url()));
 const editor=page.locator('.cm-content');await firstLine(editor);await page.getByLabel('段落格式').selectOption('h2');await page.getByRole('button',{name:'加粗（Ctrl+B）',exact:true}).click();
 await expect(editor.locator('.cm-line').first()).toHaveText('## **测试标题**');
 await page.getByRole('button',{name:'撤销（Ctrl+Z）',exact:true}).click();await expect(editor.locator('.cm-line').first()).toHaveText('## 测试标题');
 await page.getByRole('button',{name:'重做（Ctrl+Y）',exact:true}).click();await editor.press('Control+s');await expect(page.locator('.save-state')).toHaveText('已保存到本地');
 const disk=await readFile(path.join(notes,'A.md'),'utf8');expect(disk).toContain('\uFEFF## **测试标题**\r\n第一行\r\n第二行');expect(disk.replace(/\r\n/g,'')).not.toContain('\n');
 await firstLine(editor);await shot('editor-formatting-native-selection.png');check('Toolbar focus, heading then bold, single-step undo/redo, visible selection and real BOM/CRLF file save');
 await page.getByRole('button',{name:'显示模式',exact:true}).click();await expect(page.locator('.article h2 strong')).toHaveText('测试标题');await expect(page.locator('.article p').first().locator('br')).toHaveCount(1);check('Preview retains ordinary line breaks and formatted heading');
 await page.getByRole('link',{name:'打开 B',exact:true}).click();await expect(page.locator('.note-pane')).toHaveCount(2);
 for(let index=0;index<2;index++){const pane=page.locator('.note-pane').nth(index);await pane.getByRole('button',{name:'编辑模式',exact:true}).click();await firstLine(pane.locator('.cm-content'));}
 for(let index=0;index<2;index++)await expect(page.locator('.note-pane').nth(index).locator('.cm-selectionBackground').first()).toBeVisible();
 await shot('editor-formatting-native-split.png');check('Independent selections and wrapping toolbars in two native panes');
 await page.getByRole('button',{name:'关闭右窗格',exact:true}).click();await expect(page.locator('.cm-content')).toHaveCount(1);
 for(const [id,code] of Object.entries(codeSamples)){
  await editor.fill('```'+id+'\n'+code+'\n```');await expect(editor.locator('.cm-line:not(:first-child):not(:last-child) [class*="tok-"]').first(),id+' editor').toBeVisible();
  await page.getByRole('button',{name:'显示模式',exact:true}).click();await expect(page.locator('.article code [class*="tok-"]').first(),id+' preview').toBeVisible();await expect(page.locator('.article pre code')).toHaveText(code);
  if(id==='python')await shot('editor-formatting-native-code.png');
  await page.getByRole('button',{name:'编辑模式',exact:true}).click();
 }
 check('All 18 language choices highlight in native editing and preview using packaged local chunks');
 await editor.fill('const value = "```";');await firstLine(editor);await page.getByRole('button',{name:'代码块与语言',exact:true}).click();await page.getByLabel('代码语言').selectOption('javascript');await page.getByRole('button',{name:'应用',exact:true}).click();
 await expect(editor.locator('.cm-line').first()).toHaveText('````javascript');await page.getByRole('button',{name:'代码块与语言',exact:true}).click();await page.getByLabel('代码语言').selectOption('typescript');await page.getByRole('button',{name:'应用',exact:true}).click();await expect(editor.locator('.cm-line').first()).toHaveText('````typescript');
 check('Native code-language dialog creates safe fences and updates existing code blocks');
 const finalText='第一行\n第二行\n\n```powershell\n$name = "保存后恢复"\n```';await editor.fill(finalText);await editor.press('Control+s');await expect(page.locator('.save-state')).toHaveText('已保存到本地');
 await invoke('save_snapshot',{snapshot:{module:'notes',expanded:[],panes:[{path:'A.md',mode:'edit',cursor:0,scroll:0}]}});
 await invoke('exit_app').catch(()=>{});await expect.poll(()=>child.exitCode).toBe(0);
 child=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});await connect();await expect(page.locator('.cm-content')).toContainText('保存后恢复');
 expect(await readFile(path.join(notes,'A.md'),'utf8')).toBe('\uFEFF'+finalText.replace(/\n/g,'\r\n'));check('Native exit/restart restores saved file and editor session');
 const external=requests.filter(url=>/^https?:/.test(url)&&!['tauri.localhost','ipc.localhost','localhost','127.0.0.1'].includes(new URL(url).hostname));expect(external).toEqual([]);check('No external network requests for highlighting');
 results.status='passed';
}catch(error){results.status='failed';results.error=String(error?.stack||error);throw error;}
finally{
 if(page&&child?.exitCode===null)await invoke('exit_app').catch(()=>{});
 if(child?.exitCode===null){await wait(500);if(child.exitCode===null)child.kill();}
 await writeFile(reportPath,JSON.stringify(results,null,2));
 await browser?.close().catch(()=>{});
}
