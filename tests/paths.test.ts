import {describe,expect,it} from 'vitest';
import {Lexer} from 'marked';
import {makeLink,normalize,resolveLink,resolveImage,slug} from '../src/paths';
describe('portable Markdown links',()=>{
 it.each(['资料/API 说明.md','资料/[草稿](v2)#100%.md','中文 空格/😀笔记.md'])('round trips %s',target=>{
  const link=makeLink('项目/计划.md',target),token=Lexer.lexInline(link)[0];expect(token.type).toBe('link');if(token.type==='link')expect(resolveLink('项目/计划.md',token.href)).toEqual({kind:'note',path:target,fragment:''});
 });
 it('preserves literal percent encodings without decoding twice',()=>expect(resolveLink('A.md','notes/a%2523b.md')).toEqual({kind:'note',path:'notes/a%23b.md',fragment:''}));
 it('resolves fragments after the file path',()=>expect(resolveLink('项目/A.md','../B.md#%E5%86%85%E5%AE%B9')).toEqual({kind:'note',path:'B.md',fragment:'内容'}));
 it('resolves self fragments without replacing documents',()=>expect(resolveLink('A.md','#标题')).toEqual({kind:'note',path:'A.md',fragment:'标题'}));
 it.each(['../x.md','C:/x.md','%2fetc/x.md','javascript:alert(1)','//host/x.md','https://bad.test/a.png/../x'])('rejects unsafe/non-note destination %s',path=>{if(!path.startsWith('https:'))expect(()=>resolveLink('A.md',path)).toThrow();else expect(resolveLink('A.md',path).kind).toBe('external');});
 it('does not permit external image loads',()=>{expect(()=>resolveImage('A.md','https://host/image.png')).toThrow();expect(()=>resolveImage('A.md','../image.png')).toThrow();});
 it('normalizes relative folders and Unicode headings',()=>{expect(normalize('a/../b/C.md')).toBe('b/C.md');expect(slug(' 第一个 标题！ ')).toBe('第一个-标题');});
});
