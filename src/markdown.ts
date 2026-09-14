import {Marked} from 'marked';
import DOMPurify from 'dompurify';
import {resolveImage,slug} from './paths';
import type {Repository} from './types';
export function escape(text:string){return text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
const parser=new Marked({gfm:true,breaks:true,renderer:{
 html:token=>escape(token.text),
 code:token=>'<pre><code data-code-language="'+escape(token.lang||'')+'">'+escape(token.text)+'</code></pre>',
 image:token=>'<span class="image-placeholder" data-image="'+escape(token.href)+'" role="img" aria-label="'+escape(token.text)+'">'+escape(token.text||'本地图片')+'</span>',
 link(token){return '<a href="#" data-note-href="'+escape(token.href)+'">'+this.parser.parseInline(token.tokens)+'</a>';}
}});
export function preview(host:HTMLElement,text:string,path:string,repo:Repository,link:(href:string)=>void){
 host.innerHTML=DOMPurify.sanitize(parser.parse(text) as string,{FORBID_TAGS:['style','script','iframe','object','embed','form']});
 const counts=new Map<string,number>();
 host.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h=>{const name=slug(h.textContent||'');const n=counts.get(name)||0;counts.set(name,n+1);h.id=name+(n?'-'+n:'');});
 const click=(event:MouseEvent)=>{const a=(event.target as Element).closest<HTMLAnchorElement>('a[data-note-href]');if(a){event.preventDefault();link(a.dataset.noteHref!);}};
 host.addEventListener('click',click);
 let disposed=false;const loaded:HTMLElement[]=[];const pending=new Set<HTMLElement>();
 // A bounded queue retains DOM references only, not copied text or syntax trees.
 const codeQueue=new Set<HTMLElement>();let highlighting=false;
 async function highlightVisible(){
  if(highlighting||disposed)return;highlighting=true;
  try{
   while(codeQueue.size&&!disposed){
    const code=codeQueue.values().next().value!;codeQueue.delete(code);
    try{
     const {codeTokens}=await import('./code-languages');
     if(disposed||!host.contains(code))continue;
     const source=code.textContent||'',tokens=await codeTokens(source,code.dataset.codeLanguage||'',()=>disposed||!host.contains(code));
     if(disposed||!host.contains(code)||code.textContent!==source)continue;
     const fragment=document.createDocumentFragment();let offset=0;
     for(const token of tokens){
      fragment.append(document.createTextNode(source.slice(offset,token.from)));
      const span=document.createElement('span');span.className=token.classes;span.textContent=source.slice(token.from,token.to);fragment.append(span);offset=token.to;
     }
     fragment.append(document.createTextNode(source.slice(offset)));code.replaceChildren(fragment);
    }catch{/* Keep the already displayed, complete plain text when loading/parsing fails. */}
   }
  }finally{highlighting=false;}
 }
 const codeObserver=new IntersectionObserver(items=>{
  for(const item of items){
   const code=item.target as HTMLElement;
   if(!item.isIntersecting){codeQueue.delete(code);continue;}
   codeObserver.unobserve(code);codeQueue.add(code);
  }
  void highlightVisible();
 },{root:host,rootMargin:'40px'});
 host.querySelectorAll<HTMLElement>('code[data-code-language]').forEach(code=>{
  if((code.textContent?.length||0)>100_000){
   const note=document.createElement('small');note.className='code-note';note.textContent='大代码块 · 按纯文本显示';code.parentElement!.before(note);
  }else if(code.dataset.codeLanguage?.trim())codeObserver.observe(code);
 });
 const observer=new IntersectionObserver(items=>{
  for(const item of items){
   const el=item.target as HTMLElement;
   if(!item.isIntersecting){if(el.querySelector('img')){el.replaceChildren(document.createTextNode(el.getAttribute('aria-label')||'本地图片'));const i=loaded.indexOf(el);if(i>=0)loaded.splice(i,1);}continue;}
   if(pending.has(el)||el.querySelector('img'))continue;
   let imagePath:string;
   try{imagePath=resolveImage(path,el.dataset.image!);}catch{el.textContent='远程或库外图片 · '+(el.getAttribute('aria-label')||'');observer.unobserve(el);continue;}
   pending.add(el);
   void repo.image(imagePath).then(url=>{
    if(disposed)return;
    while(loaded.length>=2){const old=loaded.shift()!;old.replaceChildren(document.createTextNode(old.getAttribute('aria-label')||'本地图片'));}
    const img=document.createElement('img');img.src=url;img.alt=el.getAttribute('aria-label')||'';img.decoding='async';el.replaceChildren(img);loaded.push(el);
   }).catch(()=>{if(!disposed){el.textContent='图片暂不可显示 · '+(el.getAttribute('aria-label')||'');observer.unobserve(el);}}).finally(()=>pending.delete(el));
  }
 },{root:host,rootMargin:'40px'});
 host.querySelectorAll<HTMLElement>('[data-image]').forEach(el=>observer.observe(el));
 return ()=>{disposed=true;observer.disconnect();codeObserver.disconnect();codeQueue.clear();host.removeEventListener('click',click);loaded.splice(0);pending.clear();host.replaceChildren();};
}
