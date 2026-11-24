import {expect,test,type Locator,type Page} from '@playwright/test';
const source=(editor:Locator)=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
async function fullSource(editor:Locator){await editor.focus();await editor.press('Control+a');return editor.evaluate(element=>{const data=new DataTransfer();element.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain').replace(/\r\n/g,'\n');});}
async function newText(page:Page){await page.locator('#nav-text').click();await page.locator('#text-workspace [data-text-action="new"]').first().click();return page.locator('#text-workspace .cm-content').first();}
test.beforeEach(async({page})=>{await page.goto('/?empty');});

test('text language modes, output-format history and Unicode navigation are independent of body edits',async({page})=>{
 const editor=await newText(page);await editor.fill('<root>中文😀\tX</root>\n<item>第二行</item>');
 const comment=page.locator('[data-text-action="comment"]'),fold=page.locator('[data-text-action="fold"]'),unfold=page.locator('[data-text-action="unfold"]');
 await page.getByLabel('更多文本操作',{exact:true}).click();await expect(comment).toBeDisabled();await expect(fold).toBeDisabled();await expect(unfold).toBeDisabled();await expect(comment).toHaveAttribute('title',/纯文本/);await expect(fold).toHaveAttribute('aria-description',/纯文本/);
 await page.getByLabel('代码语言',{exact:true}).selectOption('javascript');await expect(comment).toBeEnabled();await expect(fold).toBeEnabled();await expect(unfold).toBeEnabled();
 await page.getByLabel('代码语言',{exact:true}).selectOption('json');await expect(comment).toBeDisabled();await expect(comment).toHaveAttribute('title',/不提供代码注释/);await expect(fold).toBeEnabled();
 await page.getByLabel('代码语言',{exact:true}).selectOption('xml');await expect(editor.locator('[class*="tok-"]').first()).toBeVisible();
 await expect(comment).toBeEnabled();await expect(fold).toBeDisabled();await expect(unfold).toBeDisabled();await expect(fold).toHaveAttribute('title',/不提供代码折叠/);await page.getByLabel('更多文本操作',{exact:true}).click();
 const before=await source(editor);await page.getByLabel('文本编码',{exact:true}).selectOption('utf16be');await page.getByLabel('文件换行',{exact:true}).selectOption('lf');
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(page.getByLabel('文件换行',{exact:true})).toHaveValue('crlf');
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf8');expect(await source(editor)).toBe(before);
 await page.getByRole('button',{name:'重做文本编辑',exact:true}).click();await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf16be');
 await editor.fill('中😀\tX\n第二行');await editor.press('Control+g');const dialog=page.getByRole('dialog',{name:'跳转行列'});
 await dialog.locator('[name="line"]').fill('1');await dialog.locator('[name="column"]').fill('4');await dialog.getByRole('button',{name:'跳转',exact:true}).click();
 await expect(page.locator('.text-position')).toHaveText('行 1，列 4');await page.keyboard.insertText('|');expect(await source(editor)).toBe('中😀\t|X\n第二行');
});

test('a delayed language cannot enable plain-text commands and a failed language explains its fallback',async({page})=>{
 let releasePython!:()=>void,pythonRequests=0,failedGo=0;const gate=new Promise<void>(resolve=>releasePython=resolve);
 await page.route(/.*lang-python.*|.*lang_python.*/,async route=>{pythonRequests++;await gate;await route.continue();});
 await page.route(/.*lang-go.*|.*lang_go.*/,async route=>{failedGo++;await route.abort();});
 const editor=await newText(page);await editor.fill('正文在语言切换后保持完整');const language=page.getByLabel('代码语言',{exact:true}),comment=page.locator('[data-text-action="comment"]'),fold=page.locator('[data-text-action="fold"]');
 try{
  await language.selectOption('python');await expect.poll(()=>pythonRequests).toBeGreaterThan(0);await expect(comment).toBeDisabled();await expect(fold).toBeDisabled();await expect(fold).toHaveAttribute('title',/加载中/);
  await language.selectOption('plain');releasePython();
  // Await the registry's shared request so assertions run after the editor's stale completion, without a timing sleep.
  await page.evaluate(async()=>{const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/code-languages.ts')!;const registry=await import(url) as typeof import('../../src/code-languages');await registry.textLanguages.find(item=>item.id==='python')!.description!.load();});
  await expect(language).toHaveValue('plain');await expect(comment).toBeDisabled();await expect(fold).toBeDisabled();await expect(fold).toHaveAttribute('title',/纯文本/);
  await language.selectOption('go');await expect(comment).toBeDisabled();await expect(fold).toBeDisabled();await expect(fold).toHaveAttribute('title',/加载失败.*纯文本/);await expect(page.locator('#toast')).toContainText('语言资源加载失败');expect(failedGo).toBeGreaterThan(0);
  expect(await source(editor)).toBe('正文在语言切换后保持完整');await editor.focus();await editor.press('Control+End');await page.keyboard.insertText('，仍可编辑');
  await language.selectOption('javascript');await expect(comment).toBeEnabled();await expect(fold).toBeEnabled();expect(await source(editor)).toBe('正文在语言切换后保持完整，仍可编辑');
 }finally{releasePython();await page.unrouteAll({behavior:'wait'});}
});

test('tab switches retain independent histories and Alt-click creates editable cursors',async({page})=>{
 const editor=await newText(page);await editor.fill('first\nsecond');await editor.press('Control+End');await page.keyboard.insertText('!');
 await page.locator('#text-workspace [data-text-action="new"]').first().click();const second=page.locator('#text-workspace .cm-content');await second.fill('another');
 await page.getByRole('tab',{name:/未命名 1$/}).click();await expect(editor).toContainText('second!');await editor.press('Control+z');expect(await source(editor)).toBe('first\nsecond');
 await editor.press('Control+Home');await editor.press('End');const line=editor.locator('.cm-line').nth(1),bounds=await line.boundingBox();
 await page.keyboard.down('Alt');await page.mouse.click(bounds!.x+2,bounds!.y+bounds!.height/2);await page.keyboard.up('Alt');await page.keyboard.insertText('X');
 expect(await source(editor)).toBe('firstX\nXsecond');await editor.press('Control+z');expect(await source(editor)).toBe('first\nsecond');
 await editor.press('Escape');await editor.press('Control+Home');await editor.press('Control+d');expect(await source(editor)).toBe('first\nfirst\nsecond');
});

test('scoped replacements apply atomically and undo once restores the full original range',async({page})=>{
 const editor=await newText(page);await editor.fill('cat cat\ncat cat\ncat cat');await editor.press('Control+Home');await editor.press('ArrowDown');await editor.press('Home');await editor.press('Shift+End');await editor.press('Control+h');
 await page.getByLabel('查找内容',{exact:true}).fill('cat');await page.getByRole('checkbox',{name:'仅选区',exact:true}).check();await page.getByLabel('替换内容',{exact:true}).fill('小猫');
 await expect(page.locator('.text-search-result')).toHaveText('2 处匹配');await page.getByRole('button',{name:'全部替换',exact:true}).click();
 await expect.poll(()=>source(editor)).toBe('cat cat\n小猫 小猫\ncat cat');await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();expect(await source(editor)).toBe('cat cat\ncat cat\ncat cat');
});

test('regex capture replacement, literal replacement and zero-width navigation work in the real worker',async({page})=>{
 const editor=await newText(page);await editor.fill('a1 a2 a3');await editor.press('Control+h');await page.getByLabel('查找内容',{exact:true}).fill('a(?<digit>\\d)');await page.getByRole('checkbox',{name:'正则表达式',exact:true}).check();await page.getByLabel('替换内容',{exact:true}).fill('$<digit>-$1-$$');
 await expect(page.locator('.text-search-result')).toHaveText('3 处匹配');await page.getByRole('button',{name:'全部替换',exact:true}).click();await expect.poll(()=>source(editor)).toBe('1-1-$ 2-2-$ 3-3-$');
 await page.getByRole('button',{name:'关闭查找',exact:true}).click();await editor.fill('😀a');await editor.press('Control+Home');await editor.press('Control+f');await page.getByLabel('查找内容',{exact:true}).fill('(?=.)|$');await page.getByRole('checkbox',{name:'正则表达式',exact:true}).check();await expect(page.locator('.text-search-result')).toHaveText('3 处匹配');
 await page.getByRole('button',{name:'下一个匹配',exact:true}).click();await expect(page.locator('.text-search-result')).toHaveText('1 / 3');await page.keyboard.press('F3');await expect(page.locator('.text-search-result')).toHaveText('2 / 3');await page.keyboard.press('F3');await expect(page.locator('.text-search-result')).toHaveText('3 / 3');await page.keyboard.press('F3');await expect(page.locator('.text-search-result')).toHaveText('1 / 3 · 已循环');
});

test('invalid, excessive and stalled regex searches keep the UI responsive and preserve all text',async({page})=>{
 const editor=await newText(page),text='a'.repeat(10001);await editor.fill(text);await editor.press('Control+h');await page.getByLabel('查找内容',{exact:true}).fill('a');await page.getByLabel('替换内容',{exact:true}).fill('b');await expect(page.locator('.text-search-result')).toContainText('10,000');expect((await fullSource(editor)).length).toBe(text.length);
 await page.getByRole('checkbox',{name:'正则表达式',exact:true}).check();await page.getByLabel('查找内容',{exact:true}).fill('[');await expect(page.locator('.text-search-result')).toHaveClass(/error/);expect(await fullSource(editor)).toBe(text);
 await page.getByRole('button',{name:'关闭查找',exact:true}).click();await editor.fill('a'.repeat(32)+'!');await editor.press('Control+f');await page.getByRole('checkbox',{name:'正则表达式',exact:true}).check();await page.getByLabel('查找内容',{exact:true}).fill('(a+)+$');await expect(page.locator('.text-search-result')).toContainText('1,500',{timeout:5000});
 await page.getByRole('button',{name:'关闭查找',exact:true}).click();await editor.press('Control+End');await page.keyboard.insertText('仍可编辑');await expect(editor).toContainText('仍可编辑');
});

test('identical in-flight searches share a worker and edits cancel old results while remounts keep the current body',async({page})=>{
 await newText(page);
 const result=await page.evaluate(async()=>{
  const url=performance.getEntriesByType('resource').map(entry=>entry.name).find(name=>new URL(name).pathname==='/src/text-editor.ts')!;
  const {textEditor}=await import(url) as typeof import('../../src/text-editor');
  const OriginalWorker=window.Worker;let workers=0;
  window.Worker=class extends OriginalWorker {constructor(url:string|URL,options?:WorkerOptions){super(url,options);workers++;}};
  const doc:import('../../src/text-editor').TextEditorDocument={id:'search-reuse',path:null,name:'fixture.txt',text:'cat cat',length:7,version:'',encoding:'utf8',eol:'lf',revision:0,savedRevision:0,cursor:0,anchor:0,scroll:0,language:'plain',tabSize:4,indentWithTabs:false,wrap:false};
  const host=document.createElement('div');document.body.append(host);let editor:ReturnType<typeof textEditor>|undefined;
  const mount=()=>textEditor(host,doc,{onEdit:text=>{doc.text=text;doc.length=text.length;doc.revision++;},onFormat:(encoding,eol)=>{doc.encoding=encoding;doc.eol=eol;}});
  try{
   editor=mount();const first=editor.search({query:'cat'}),same=editor.search({query:'cat'}),shared=first===same;
   const completed=await first,workersAfterFirst=workers;
   editor.clearSearch();const stale=editor.search({query:'cat'});editor.view.dispatch({changes:{from:0,to:3,insert:'dog'}});
   const current=await editor.search({query:'dog'}),cancelled=await stale;
   const edited=editor.getText();editor.command('undo');const undone=editor.getText();editor.destroy();editor=mount();const remounted=editor.getText();
   editor.destroy();doc.text='external body';doc.length=doc.text.length;doc.revision++;editor=mount();
   return {shared,workersAfterFirst,matches:completed.matches.length,cancelled:cancelled.status,currentMatches:current.matches.length,currentRevision:current.revision,edited,undone,remounted,external:editor.getText(),externalUndo:editor.command('undo')};
  }finally{editor?.destroy();host.remove();window.Worker=OriginalWorker;}
 });
 expect(result).toEqual({shared:true,workersAfterFirst:1,matches:2,cancelled:'cancelled',currentMatches:1,currentRevision:1,edited:'dog cat',undone:'cat cat',remounted:'cat cat',external:'external body',externalUndo:false});
 await expect.poll(()=>page.workers().length).toBe(0);
});
