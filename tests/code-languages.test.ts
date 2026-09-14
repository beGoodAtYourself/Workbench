import {it,expect,vi} from 'vitest';
import {codeLanguages,codeLanguage,codeTokens,MAX_HIGHLIGHT_LENGTH} from '../src/code-languages';
import {codeSamples} from './fixtures/code-samples';

it.each(Object.entries(codeSamples))('highlights %s with valid token ranges',async(id,source)=>{
 const tokens=await codeTokens(source,id);expect(tokens.length).toBeGreaterThan(0);
 let end=0;for(const token of tokens){expect(token.from).toBeGreaterThanOrEqual(end);expect(token.to).toBeGreaterThan(token.from);expect(token.to).toBeLessThanOrEqual(source.length);expect(token.classes).toMatch(/tok-/);end=token.to;}
});
it('covers all toolbar languages and common aliases',()=>{
 expect(codeLanguages.map(item=>item.id).sort()).toEqual(Object.keys(codeSamples).sort());
 for(const [alias,id] of Object.entries({JS:'javascript',ts:'typescript',py:'python','c++':'cpp','C#':'csharp',cs:'csharp',golang:'go',rs:'rust',bash:'shell',ps1:'powershell',pwsh:'powershell',yml:'yaml'}))expect(codeLanguage(alias+' extra')?.id).toBe(id);
});
it('keeps unknown, unlabelled and oversized blocks as plain text',async()=>{
 expect(await codeTokens('const x = 1;','')).toEqual([]);expect(await codeTokens('const x = 1;','unknown')).toEqual([]);
 expect(await codeTokens('x'.repeat(MAX_HIGHLIGHT_LENGTH+1),'javascript')).toEqual([]);
});
it('does not parse an old document after its delayed language load finishes',async()=>{
 const description=codeLanguage('js')!.description,support=await description.load();
 let cancelled=false,release!:(value:typeof support)=>void;
 const load=vi.spyOn(description,'load').mockImplementation(()=>new Promise(resolve=>release=resolve));
 const parse=vi.spyOn(support.language.parser,'parse');
 try{
  const pending=codeTokens('const oldDocument = 1;','js',()=>cancelled);cancelled=true;release(support);
  expect(await pending).toEqual([]);expect(parse).not.toHaveBeenCalled();
 }finally{load.mockRestore();parse.mockRestore();}
});
