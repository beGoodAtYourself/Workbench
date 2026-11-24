// 无窗口分配诊断：仅分析合成会话，不启动原生窗口，也不替代 PERF-06 验收。
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const label=process.argv.find(x=>x.startsWith('--label='))?.slice(8)??'diagnostic';
if(!/^[a-z0-9-]+$/.test(label))throw Error('Invalid label');
const profile=process.argv.includes('--profile'),codeFixtures=process.argv.includes('--code-fixtures');
const modes=(process.argv.find(x=>x.startsWith('--modes='))?.slice(8)??'switch,search,split,pause,combined').split(',');
if(modes.some(x=>!['switch','search','split','pause','combined'].includes(x)))throw Error('Invalid mode');
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={acceptance:false,kind:'headless-component-allocation',label,profile,codeFixtures,startedAt:new Date().toISOString(),
 notice:'Real text model/workspace/editor with an in-memory synthetic repository; no native bridge, private-process-memory acceptance or disk recovery claim. Forced GC is diagnostic only.',
 sourceHashes:Object.fromEntries(await Promise.all(['src/text-editor.ts','src/text-workspace.ts','src/text-model.ts','src/text-search-client.ts'].map(async p=>[p,hash(await readFile(path.join(root,p)))]))),scenes:[]};
const server=spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','1438','--strictPort'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='',browser;server.stdout.on('data',x=>log+=x);server.stderr.on('data',x=>log+=x);
try{
 await expect.poll(()=>log,{timeout:20000}).toContain('1438');browser=await chromium.launch({channel:'msedge',headless:true});report.browserVersion=browser.version();
 for(const mode of modes){
  const page=await browser.newPage({viewport:{width:1180,height:780}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:1438/?empty');await page.locator('#nav-text').click();await page.locator('#text-workspace .text-toolbar').waitFor();
  await page.evaluate(async(codeFixtures)=>{
   const moduleUrl=name=>performance.getEntriesByType('resource').map(x=>x.name).find(url=>new URL(url).pathname==='/src/'+name+'.ts');
   const {TextWorkbench}=await import(moduleUrl('text-model')),{TextWorkspace}=await import(moduleUrl('text-workspace'));
   // 只替换当前隔离页面；原演示应用没有文档，也未连接原生桥。
   const app=document.getElementById('app');app.hidden=true;const host=document.createElement('div');host.style.height='760px';document.body.append(host);
   const text=('fixture text 0123456789 abcdefghijklmnopqrstuvwxyz\n'.repeat(2200)).slice(0,102399)+'\n';
   const files=Array.from({length:12},(_,i)=>{const kind=codeFixtures&&i===1?'json':codeFixtures&&i===2?'ts':'txt',name='T'+i+'.'+kind,body=kind==='json'?'{"fixture":"'+'v'.repeat(102400-15)+'"}\n':kind==='ts'?('// fixture text line; const value = 1234567890;\n'.repeat(2500)).slice(0,102399)+'\n':text;return {id:'fixture-'+i,path:'fixture/'+name,name,text:body,version:'1',size:body.length,encoding:'utf8',eol:'lf',readonly:false};});
   let queued=files,generation=0;
   const repo={open:async()=>({files:queued.map(x=>({...x})),notes:[],errors:[]}),read:async id=>({...files.find(x=>x.id===id)}),probe:async id=>({kind:'unchanged',id,version:'1',size:text.length,readonly:false}),
    close:async()=>{},invalidate:async next=>{generation=next;},checkpoint:async value=>{if(value.generation!==generation)throw Error('generation');return {generation,token:String(generation)};},notes:async()=>{},noteOwner:async()=>null};
   const model=new TextWorkbench(repo),ui=new TextWorkspace(host,model,message=>{throw Error(message);},true);await ui.show();await model.open();await ui.render();
   await model.activate(files[0].id);await model.split(files[1].id);await ui.render();
   const seen=new WeakSet(),stats={editors:0,workers:0,searchForms:0,elements:0,styleWrites:0,styleCharacters:0};const inspect=node=>{if(!(node instanceof Element))return;for(const el of [node,...node.querySelectorAll('*')]){if(seen.has(el))continue;seen.add(el);stats.elements++;if(el.matches('.cm-editor'))stats.editors++;if(el.matches('.text-search-main'))stats.searchForms++;}};
   host.querySelectorAll('*').forEach(x=>seen.add(x));const observer=new MutationObserver(records=>{for(const record of records)record.addedNodes.forEach(inspect);});observer.observe(host,{childList:true,subtree:true});
   const styleObserver=new MutationObserver(records=>{for(const record of records)if(record.target instanceof HTMLStyleElement){stats.styleWrites++;stats.styleCharacters+=record.target.textContent.length;}});styleObserver.observe(document.head,{childList:true,subtree:true});
   const OriginalWorker=window.Worker;window.Worker=class extends OriginalWorker{constructor(...args){super(...args);stats.workers++;}};
   const pause=async()=>{ui.pause();await model.suspend();model.resume();await ui.show();};
   Object.assign(window,{__allocation:{host,model,ui,stats,text,files,pause,reopen(){queued=[files.at(-1)];},async canonical(){await model.activate(files[0].id);model.merge();await model.split(files[1].id);await ui.render();},verify(){return model.documents.length===12&&model.documents.every(d=>d.text===files.find(f=>f.id===d.id)?.text&&d.revision===0&&d.savedRevision===0);},dispose(){observer.disconnect();styleObserver.disconnect();ui.destroy();model.dispose();window.Worker=OriginalWorker;host.remove();}}});
  },codeFixtures);
  const host=page.locator('body > .text-workspace'),tabs=host.getByRole('tab'),split=host.locator('[data-text-action="split"]');
  const dual=async enabled=>{if((await host.locator('.text-pane').count()===2)!==enabled)await split.click();await expect(host.locator('.text-pane')).toHaveCount(enabled?2:1);};
  async function cycle(){
   if(mode==='switch'){await tabs.nth(2).click();await tabs.last().click();}
   if(mode==='combined'){await tabs.last().click();await host.locator('.text-tab-close').last().click();await expect(tabs).toHaveCount(11);await page.evaluate(()=>window.__allocation.reopen());await host.getByRole('button',{name:'打开文本文件',exact:true}).click();await expect(tabs).toHaveCount(12);}
   if(mode==='search'||mode==='combined'){await host.getByRole('button',{name:'查找',exact:true}).click();const query=host.getByRole('textbox',{name:'查找内容',exact:true});await query.fill('fixture');await query.press('Enter');await host.getByRole('button',{name:'关闭查找',exact:true}).click();}
   if(mode==='split'||mode==='combined'){await dual(false);await dual(true);}
   if(mode==='pause'||mode==='combined')await page.evaluate(()=>window.__allocation.pause());
  }
  const cdp=await page.context().newCDPSession(page);const snapshot=async()=>({heap:await cdp.send('Runtime.getHeapUsage'),dom:await cdp.send('Memory.getDOMCounters'),counts:await page.evaluate(()=>({...window.__allocation.stats}))});
  for(let i=0;i<10;i++)await cycle();await page.evaluate(()=>window.__allocation.canonical());await page.waitForTimeout(1000);const before=await snapshot();if(profile)await cdp.send('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  for(let i=0;i<100;i++){await cycle();if((i+1)%25===0)console.log(mode+' '+(i+1)+'/100');}
  await page.evaluate(()=>window.__allocation.canonical());await page.waitForTimeout(2000);const after=await snapshot();let allocationProfile;if(profile){allocationProfile=(await cdp.send('HeapProfiler.stopSampling')).profile;await writeFile(path.join(root,'docs/verification/raw/text-allocation-profile-'+label+'-'+mode+'.json'),JSON.stringify(allocationProfile));}assert.equal(await page.evaluate(()=>window.__allocation.verify()),true);assert.deepEqual(errors,[]);
  await cdp.send('HeapProfiler.collectGarbage');const afterGc=await snapshot();const delta=Object.fromEntries(Object.keys(after.counts).map(k=>[k,after.counts[k]-before.counts[k]]));
  report.scenes.push({mode,cycles:100,warmup:10,before,after,afterGc,allocations:delta,fixtureUnchanged:true,pageErrors:errors,profileFile:profile?'text-allocation-profile-'+label+'-'+mode+'.json':undefined});console.log(JSON.stringify({mode,allocations:delta,heapDelta:after.heap.usedSize-before.heap.usedSize,afterGc:afterGc.heap.usedSize}));
  await page.evaluate(()=>window.__allocation.dispose());await page.close();
 }
 report.status='diagnostic-complete';
}catch(error){report.status='diagnostic-failed';report.error=String(error.stack??error);process.exitCode=1;}
finally{await browser?.close();server.kill();await mkdir(path.join(root,'docs/verification/raw'),{recursive:true});report.completedAt=new Date().toISOString();await writeFile(path.join(root,'docs/verification/raw/text-component-allocation-'+label+'.json'),JSON.stringify(report,null,2));}
