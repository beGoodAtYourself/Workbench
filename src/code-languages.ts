import {LanguageDescription,LanguageSupport,StreamLanguage} from '@codemirror/language';
import {classHighlighter,highlightTree} from '@lezer/highlight';

const plain = new LanguageSupport(StreamLanguage.define({token(stream){stream.skipToEnd();return null;}}));
export function isFallbackSupport(support:LanguageSupport){return support===plain;}
function entry(id:string,name:string,alias:string[],load:()=>Promise<LanguageSupport>){
 return {id,name,description:LanguageDescription.of({name,alias:[id,...alias],load:()=>load().catch(()=>plain)})};
}
export const codeLanguages = [
 entry('javascript','JavaScript',['js','ecmascript','node'],()=>import('@codemirror/lang-javascript').then(m=>m.javascript())),
 entry('typescript','TypeScript',['ts'],()=>import('@codemirror/lang-javascript').then(m=>m.javascript({typescript:true}))),
 entry('jsx','JSX',[],()=>import('@codemirror/lang-javascript').then(m=>m.javascript({jsx:true}))),
 entry('tsx','TSX',[],()=>import('@codemirror/lang-javascript').then(m=>m.javascript({jsx:true,typescript:true}))),
 entry('python','Python',['py'],()=>import('@codemirror/lang-python').then(m=>m.python())),
 entry('java','Java',[],()=>import('@codemirror/lang-java').then(m=>m.java())),
 entry('c','C',[],()=>import('@codemirror/lang-cpp').then(m=>m.cpp())),
 entry('cpp','C++',['c++','cc','cxx'],()=>import('@codemirror/lang-cpp').then(m=>m.cpp())),
 entry('csharp','C#',['c#','cs'],()=>import('@codemirror/legacy-modes/mode/clike').then(m=>new LanguageSupport(StreamLanguage.define(m.csharp)))),
 entry('go','Go',['golang'],()=>import('@codemirror/lang-go').then(m=>m.go())),
 entry('rust','Rust',['rs'],()=>import('@codemirror/lang-rust').then(m=>m.rust())),
 entry('html','HTML',['htm'],()=>import('@codemirror/lang-html').then(m=>m.html())),
 entry('css','CSS',[],()=>import('@codemirror/lang-css').then(m=>m.css())),
 entry('json','JSON',[],()=>import('@codemirror/lang-json').then(m=>m.json())),
 entry('sql','SQL',[],()=>import('@codemirror/lang-sql').then(m=>m.sql())),
 entry('shell','Shell',['sh','bash','zsh'],()=>import('@codemirror/legacy-modes/mode/shell').then(m=>new LanguageSupport(StreamLanguage.define(m.shell)))),
 entry('powershell','PowerShell',['ps1','pwsh','ps'],()=>import('@codemirror/legacy-modes/mode/powershell').then(m=>new LanguageSupport(StreamLanguage.define(m.powerShell)))),
 entry('yaml','YAML',['yml'],()=>import('@codemirror/lang-yaml').then(m=>m.yaml()))
];
export function codeLanguage(info:string){
 const name=info.trim().split(/\s+/)[0].toLowerCase();
 return codeLanguages.find(item=>item.id===name||item.description.alias.includes(name));
}
export const codeDescriptions=codeLanguages.map(item=>item.description);
// Text files use their own registry so Markdown code fences keep their original choices.
export const textLanguages=[
 {id:'plain',name:'纯文本',description:undefined},...codeLanguages,
 entry('markdown','Markdown',['md','mdown'],()=>import('@codemirror/lang-markdown').then(m=>m.markdown({codeLanguages:codeDescriptions}))),
 entry('xml','XML',['svg','xsl','xsd'],()=>import('@codemirror/legacy-modes/mode/xml').then(m=>new LanguageSupport(StreamLanguage.define(m.xml))))
];
export function textLanguageForPath(path:string|null):string{
 const name=path?.replace(/\\/g,'/').split('/').pop()?.toLowerCase()??'',extension=name.includes('.')?name.split('.').pop()!:'';
 const extensions:Record<string,string>={js:'javascript',mjs:'javascript',cjs:'javascript',ts:'typescript',mts:'typescript',cts:'typescript',jsx:'jsx',tsx:'tsx',py:'python',java:'java',c:'c',h:'c',cpp:'cpp',cc:'cpp',cxx:'cpp',hpp:'cpp',hxx:'cpp',cs:'csharp',go:'go',rs:'rust',html:'html',htm:'html',css:'css',json:'json',jsonc:'json',sql:'sql',sh:'shell',bash:'shell',zsh:'shell',ps1:'powershell',psm1:'powershell',psd1:'powershell',yaml:'yaml',yml:'yaml',md:'markdown',markdown:'markdown',mdown:'markdown',xml:'xml',svg:'xml',xsl:'xml',xslt:'xml',xsd:'xml',config:'xml'};
 return extensions[extension]??'plain';
}
export const tokenHighlighter=classHighlighter;
export const MAX_HIGHLIGHT_LENGTH=100_000;
export type CodeToken={from:number;to:number;classes:string};
// The caller owns the text and lifetime. No document text or trees are cached here.
export async function codeTokens(text:string,info:string,cancelled:()=>boolean=()=>false):Promise<CodeToken[]>{
 const language=codeLanguage(info);
 if(!language||text.length>MAX_HIGHLIGHT_LENGTH||cancelled())return [];
 const support=await language.description.load();
 if(cancelled())return [];
 const tokens:CodeToken[]=[];
 highlightTree(support.language.parser.parse(text),tokenHighlighter,(from,to,classes)=>tokens.push({from,to,classes}));
 return tokens;
}
