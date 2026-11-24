// Headless allocation diagnostic only. This is never native PERF-06 acceptance.
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)??'diagnostic';
if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid diagnostic label');
const output=path.join(root,'docs','verification','raw','text-editor-browser-churn-'+label+'.json');
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={kind:'headless-diagnostic',acceptance:false,label,startedAt:new Date().toISOString(),
 notice:'Two 100 KiB demo documents, 100 short hide/restore cycles in headless Edge. Counts quantify allocations, not native private working set or PERF-06 compliance.',
 sourceHashes:Object.fromEntries(await Promise.all(['src/main.ts','src/text-editor.ts','src/text-workspace.ts'].map(async file=>[file,hash(await readFile(path.join(root,file)))])))};
const server=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1437','--strictPort'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let serverLog='',browser;server.stdout.on('data',value=>serverLog+=value);server.stderr.on('data',value=>serverLog+=value);
try{
 await expect.poll(()=>serverLog,{timeout:20000}).toContain('1437');
 browser=await chromium.launch({channel:'msedge',headless:true});report.browserVersion=browser.version();
 const page=await browser.newPage({viewport:{width:1280,height:850}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const body=('fixture text 0123456789 abcdefghijklmnopqrstuvwxyz\n'.repeat(2200)).slice(0,102399)+'\n';assert.equal(body.length,102400);
 await page.addInitScript(body=>localStorage.setItem('shiye-demo-text-files-v1',JSON.stringify(['demo-config','demo-readme'].map((id,index)=>({id,path:'fixtures/T'+index+'.txt',name:'T'+index+'.txt',text:body,version:'1',size:body.length,encoding:'utf8',eol:'lf',readonly:false})))),body);
 await page.goto('http://127.0.0.1:1437/?empty');await expect(page.locator('#app')).not.toHaveAttribute('inert','');
 await page.locator('#nav-text').click();await page.getByRole('button',{name:'打开文本文件',exact:true}).click();await expect(page.getByRole('tab')).toHaveCount(2);
 await page.getByRole('button',{name:'双视图',exact:true}).click();await expect(page.locator('.text-pane .cm-editor')).toHaveCount(2);
 await page.evaluate(()=>{
  const seen=new WeakSet(),counts={createdEditors:0};
  const inspect=node=>{if(!(node instanceof Element))return;for(const element of [...(node.matches('.cm-editor')?[node]:[]),...node.querySelectorAll('.cm-editor')])if(!seen.has(element)){seen.add(element);counts.createdEditors++;}};
  document.querySelectorAll('.cm-editor').forEach(node=>seen.add(node));
  const observer=new MutationObserver(records=>{for(const record of records)record.addedNodes.forEach(inspect);});observer.observe(document.getElementById('text-workspace'),{childList:true,subtree:true});
  Object.assign(window,{__churn:{counts,observer}});
 });
 const cdp=await page.context().newCDPSession(page);
 report.before={heap:await cdp.send('Runtime.getHeapUsage'),dom:await cdp.send('Memory.getDOMCounters')};
 for(let index=0;index<100;index++){
  await page.locator('#hide').click();await expect(page.locator('#app')).not.toHaveAttribute('inert','');await expect(page.locator('.text-pane .cm-content')).toHaveCount(2);
  if((index+1)%25===0)console.log(label+': '+(index+1)+'/100 short hide/restore cycles');
 }
 await page.waitForTimeout(1000);
 report.after={heap:await cdp.send('Runtime.getHeapUsage'),dom:await cdp.send('Memory.getDOMCounters')};
 report.createdEditors=await page.evaluate(()=>window.__churn.counts.createdEditors);
 const documents=await page.evaluate(()=>{const snapshot=JSON.parse(localStorage.getItem('shiye-demo-text-session-v1'));return snapshot.documents.map(doc=>({id:doc.id,text:localStorage.getItem(doc.blob),revision:doc.revision,savedRevision:doc.savedRevision}));});
 assert.equal(documents.length,2);assert.ok(documents.every(doc=>doc.text===body&&doc.revision===0&&doc.savedRevision===0));assert.deepEqual(errors,[]);
 report.fixture={documents:2,bytesEach:102400,bodySha256:hash(body),unchanged:true};report.status='diagnostic-complete';report.pageErrors=errors;
 console.log(JSON.stringify({label,createdEditors:report.createdEditors,fixtureUnchanged:true,acceptance:false}));
}catch(error){report.status='diagnostic-failed';report.error=String(error.stack??error);process.exitCode=1;}
finally{await browser?.close();server.kill();await mkdir(path.dirname(output),{recursive:true});report.completedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2));}
