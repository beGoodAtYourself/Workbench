// Seal local QA assets, then record independently built formal deliverables.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(root,'src-tauri','target','text-editor');
const output=path.join(root,'docs','verification','raw');
const execute=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(output,{recursive:true});
async function record(file){const bytes=await readFile(file),info=await stat(file);return {path:file,bytes:bytes.length,modifiedAt:info.mtime.toISOString(),sha256:hash(bytes)};}
async function assets(directory=path.join(root,'dist')){const result=[];for(const entry of await readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);if(entry.isDirectory())result.push(...await assets(full));else result.push({file:path.relative(path.join(root,'dist'),full).replaceAll('\\','/'),sha256:hash(await readFile(full))});}return result.sort((a,b)=>a.file.localeCompare(b.file));}
const assetList=await assets();
if(process.argv.includes('--seal-qa')){
 const report={recordedAt:new Date().toISOString(),identity:'local.shiye.workbench.textqa',binary:await record(path.join(target,'release','shiye-text-qa.exe')),assets:assetList};
 await writeFile(path.join(output,'text-editor-qa-build.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({qaSha256:report.binary.sha256,assets:assetList.length}));
}else{
 const qa=JSON.parse(await readFile(path.join(output,'text-editor-qa-build.json'),'utf8'));assert.deepEqual(assetList,qa.assets,'Formal build assets must match the sealed QA build.');
 const report={recordedAt:new Date().toISOString(),version:JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version,artifacts:await Promise.all([record(path.join(target,'release','shiye.exe')),record(path.join(target,'release','bundle','nsis','拾页_0.1.0_x64-setup.exe'))]),qa,assets:assetList,evidence:{},toolchain:{},notes:['Formal installer is generated and hashed; isolated installer testing uses the audited startupqa identity, never the user installation.','QA and formal front-end assets match exactly. Resource acceptance is reported by the performance evidence, independently of successful packaging.']};
 for(const name of ['native','dialogs','recovery','workspace','editing','links','shell','performance','installer']){try{const value=JSON.parse(await readFile(path.join(output,'text-editor-'+name+'.json'),'utf8')),evidenceSha256=value.finalBuild?.sha256??value.sha256;report.evidence[name]={path:path.join(output,'text-editor-'+name+'.json'),status:value.status??(value.pass?'passed':'failed'),sha256:evidenceSha256,matchesSealedQa:evidenceSha256?evidenceSha256===qa.binary.sha256:null,acceptance:value.acceptance};}catch(error){if(error.code!=='ENOENT')throw error;report.evidence[name]={status:'pending',matchesSealedQa:null};}}
 for(const [name,command,args] of [['node','node',['--version']],['rust','rustc',['--version']],['cargo','cargo',['--version']],['git','git',['rev-parse','--abbrev-ref','HEAD']]]){report.toolchain[name]=(await execute(command,args,{cwd:root,windowsHide:true})).stdout.trim();}
 await writeFile(path.join(output,'text-editor-delivery.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({artifacts:report.artifacts,evidence:report.evidence},null,2));
}
