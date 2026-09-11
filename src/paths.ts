export function key(path: string): string { return path.replaceAll('\\','/').toLocaleLowerCase('en-US'); }
export function parent(path: string): string { return path.includes('/') ? path.slice(0,path.lastIndexOf('/')) : ''; }
export function basename(path: string): string { return path.split('/').at(-1) || path; }
export function belongs(path: string, folder: string): boolean { return key(path)===key(folder) || key(path).startsWith(key(folder)+'/'); }
export function normalize(path: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(path)) throw new Error('只能打开笔记文件夹内的相对路径。');
  const parts: string[]=[];
  for (const part of path.replaceAll('\\','/').split('/')) {
    if(!part || part==='.')continue;
    if(part==='..'){if(!parts.length)throw new Error('链接超出了笔记文件夹。');parts.pop();}
    else parts.push(part);
  }
  return parts.join('/');
}
export function makeLink(source: string, target: string): string {
  const from=parent(source).split('/').filter(Boolean), to=target.split('/');
  while(from.length && to.length && key(from[0])===key(to[0])){from.shift();to.shift();}
  const relative=[...from.map(()=>'..'),...to].map(part=>encodeURIComponent(part).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  const label=basename(target).replace(/\.md$/i,'').replace(/[\\[\]]/g,'\\$&');
  return '['+label+']('+relative+')';
}
export type Destination = {kind:'external';url:string}|{kind:'note';path:string;fragment:string};
export function resolveLink(source: string, href: string): Destination {
  if(/^https?:\/\//i.test(href))return {kind:'external',url:href};
  if(/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('\\'))throw new Error('不支持这种链接。');
  const index=href.indexOf('#'), raw=index<0?href:href.slice(0,index);
  const fragment=index<0?'':decodeURIComponent(href.slice(index+1));
  if(!raw)return {kind:'note',path:source,fragment};
  const decoded=decodeURIComponent(raw);
  if(/^(?:[/\\]|[a-z][a-z\d+.-]*:)/i.test(decoded))throw new Error('不支持绝对路径。');
  const path=normalize((parent(source)?parent(source)+'/':'')+decoded);
  if(!path.toLowerCase().endsWith('.md'))throw new Error('只能分屏打开 Markdown（.md）笔记。');
  return {kind:'note',path,fragment};
}
export function resolveImage(source: string, href: string): string {
  const decoded=decodeURIComponent(href);
  if(/^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(decoded))throw new Error('仅显示笔记文件夹内的图片');
  return normalize((parent(source)?parent(source)+'/':'')+decoded);
}
export function slug(text: string): string { return text.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s+/g,'-'); }
