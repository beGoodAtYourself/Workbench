import {test,expect,type Page,type Locator} from '@playwright/test';
import {codeSamples} from '../fixtures/code-samples';

test.beforeEach(async({page})=>{await page.goto('/');await page.getByRole('button',{name:'编辑模式',exact:true}).click();});
const source=(editor:Locator)=>editor.locator('.cm-line').allTextContents().then(lines=>lines.join('\n'));
// Keyboard selection needs focus; a wrapped content element can extend beyond its clipped scroll viewport.
async function selectFirstLine(editor:Locator){await editor.focus();await editor.press('Control+Home');await editor.press('Shift+End');}
async function preview(page:Page){await page.getByRole('button',{name:'显示模式',exact:true}).click();return page.locator('.article');}
async function closeFormattingDialog(page:Page,label:'取消'|'应用'){
 await page.getByRole('button',{name:label,exact:true}).click();
 // Wait for the close event that restores the selection and applies the format.
 await expect(page.locator('.formatting-dialog')).toHaveCount(0);
}

test('toolbar preserves selection, creates blocks, toggles formats and saves with undo',async({page})=>{
 const editor=page.locator('.cm-content');await editor.fill('标题文字\n第一项\n第二项');await selectFirstLine(editor);
 await page.getByLabel('段落格式').selectOption('h2');expect(await source(editor)).toBe('## 标题文字\n第一项\n第二项');
 await page.getByRole('button',{name:'加粗（Ctrl+B）',exact:true}).click();expect(await source(editor)).toContain('## **标题文字**');
 await page.getByRole('button',{name:'撤销（Ctrl+Z）',exact:true}).click();expect(await source(editor)).toBe('## 标题文字\n第一项\n第二项');
 await page.getByRole('button',{name:'重做（Ctrl+Y）',exact:true}).click();expect(await source(editor)).toContain('## **标题文字**');
 await editor.press('Control+z');await editor.press('Control+End');await editor.press('Home');await editor.press('Control+Shift+Home');
 await page.getByRole('button',{name:'无序列表',exact:true}).click();expect(await source(editor)).toContain('- 标题文字');
 await editor.press('Control+s');await expect(page.locator('.save-state')).toHaveText('已保存到本地');
 const article=await preview(page);await expect(article.locator('ul')).toBeVisible();
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();await editor.press('Control+z');expect(await source(editor)).toContain('## 标题文字');
});

test('link and language dialogs apply to the original range and cancellation keeps it',async({page})=>{
 const editor=page.locator('.cm-content');await editor.fill('链接文字\n第二行');await selectFirstLine(editor);
 await page.getByRole('button',{name:'插入链接',exact:true}).click();await closeFormattingDialog(page,'取消');
 expect(await source(editor)).toBe('链接文字\n第二行');await editor.pressSequentially('替换文字');expect(await source(editor)).toBe('替换文字\n第二行');
 await selectFirstLine(editor);await page.getByRole('button',{name:'插入链接',exact:true}).click();await page.getByLabel('链接地址').fill('使用指南.md');await closeFormattingDialog(page,'应用');
 expect(await source(editor)).toContain('[替换文字](<使用指南.md>)');
 await editor.fill('const answer = "```";');await selectFirstLine(editor);await page.getByRole('button',{name:'代码块与语言',exact:true}).click();
 await expect(page.getByLabel('代码语言')).toHaveValue('');await page.getByLabel('代码语言').selectOption('javascript');await closeFormattingDialog(page,'应用');
 expect(await source(editor)).toBe('````javascript\nconst answer = "```";\n````');
 await page.getByRole('button',{name:'代码块与语言',exact:true}).click();await expect(page.getByLabel('代码语言')).toHaveValue('javascript');
 await page.getByLabel('代码语言').selectOption('typescript');await closeFormattingDialog(page,'应用');
 expect(await source(editor)).toBe('````typescript\nconst answer = "```";\n````');await editor.press('Control+z');expect(await source(editor)).toContain('````javascript');
});

test('TXT paste keeps line breaks and paragraphs without altering the source',async({page})=>{
 const editor=page.locator('.cm-content');await editor.fill('');
 await editor.evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','第一行\r\n第二行\r\n\r\n另一个段落');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
 expect(await source(editor)).toBe('第一行\n第二行\n\n另一个段落');
 const article=await preview(page);await expect(article.locator('p')).toHaveCount(2);await expect(article.locator('p').first().locator('br')).toHaveCount(1);
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();
 // The editor module mounts asynchronously after the mode button's click handler.
 await expect(editor).toBeVisible();await expect.poll(()=>source(editor)).toBe('第一行\n第二行\n\n另一个段落');
});

test('all supported languages have visible code colors in edit and preview modes',async({page})=>{
 test.setTimeout(90000);const editor=page.locator('.cm-content');
 for(const [id,code] of Object.entries(codeSamples)){
  await editor.fill('```'+id+'\n'+code+'\n```');
  const tokens=editor.locator('.cm-line:not(:first-child):not(:last-child) [class*="tok-"]');await expect(tokens.first(),id+' editor').toBeVisible();
  const article=await preview(page);await expect(article.locator('pre code [class*="tok-"]').first(),id+' preview').toBeVisible();await expect(article.locator('pre code')).toHaveText(code);
  if(id==='javascript'){
   const colors=await article.locator('.tok-keyword,.tok-string').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).color));expect(new Set(colors).size).toBeGreaterThan(1);
   await page.screenshot({path:'.qa/formatting-code-preview.png'});
  }
  await page.getByRole('button',{name:'编辑模式',exact:true}).click();
 }
});

test('unknown and huge blocks stay complete and raw HTML stays inert',async({page})=>{
 const editor=page.locator('.cm-content'),large='x'.repeat(100001);
 await editor.fill('```unknown\n<svg onload="window.bad=true">text</svg>\n```\n\n```js\n'+large+'\n```');
 const article=await preview(page);await expect(article.locator('pre code')).toHaveCount(2);await expect(article.locator('pre code').nth(1)).toHaveText(large);
 await expect(article.locator('pre code span')).toHaveCount(0);await expect(article.locator('.code-note')).toBeVisible();expect(await page.evaluate(()=>('bad' in window))).toBe(false);
});

test('selection is visible on the active line, wrapped lines, blur and separate panes',async({page})=>{
 const editor=page.locator('.cm-content');await editor.fill('选中的文字清楚可见\n'+'中文长行用于验证自动换行的选区。'.repeat(20)+'\n最后一行');
 await selectFirstLine(editor);await expect(page.locator('.cm-selectionBackground').first()).toBeVisible();
 await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/);
 const focused=await page.locator('.cm-selectionBackground').first().evaluate(el=>getComputedStyle(el).backgroundColor);
 const lineBackground=await page.locator('.cm-activeLine').evaluate(el=>getComputedStyle(el).backgroundColor);expect(lineBackground).toMatch(/^rgba\(/);
 await page.screenshot({path:'.qa/formatting-selection-focused.png'});
 await page.locator('#new-note').focus();await expect(page.locator('#new-note')).toBeFocused();
 // CodeMirror updates its focus class in a scheduled view update, after the native blur event.
 await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-focused/);
 await expect.poll(()=>page.locator('.cm-selectionBackground').first().evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe(focused);
 await page.screenshot({path:'.qa/formatting-selection-blurred.png'});
 await editor.focus();await editor.press('Control+Home');await editor.press('Control+Shift+End');await expect(page.locator('.cm-selectionBackground').first()).toBeVisible();await page.screenshot({path:'.qa/formatting-selection-wrapped.png'});
 // Open another pane via an existing local link, then make two independent edit selections.
 await editor.fill('[打开指南](使用指南.md)');await preview(page);await page.getByRole('link',{name:'打开指南',exact:true}).click();
 const panes=page.locator('.note-pane');await expect(panes).toHaveCount(2);
 for(let i=0;i<2;i++){
  const pane=panes.nth(i);await pane.getByRole('button',{name:'编辑模式',exact:true}).click();const content=pane.locator('.cm-content');await selectFirstLine(content);
 }
 for(let i=0;i<2;i++)await expect(panes.nth(i).locator('.cm-selectionBackground').first()).toBeVisible();
 await page.setViewportSize({width:900,height:850});await page.screenshot({path:'.qa/formatting-selection-split.png'});
 for(let i=0;i<2;i++)expect(await panes.nth(i).locator('.format-toolbar').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});

test('pointer dragging selects text and delayed highlighting cannot update a replaced pane',async({page})=>{
 const editor=page.locator('.cm-content');await editor.fill('拖选这些文字测试底色');
 const bounds=await editor.locator('.cm-line').first().boundingBox();await page.mouse.move(bounds!.x+1,bounds!.y+10);await page.mouse.down();await page.mouse.move(bounds!.x+90,bounds!.y+10,{steps:8});await page.mouse.up();
 expect(await page.evaluate(()=>window.getSelection()?.toString().length)).toBeGreaterThan(1);await page.screenshot({path:'.qa/formatting-selection-mouse.png'});
 let release!:()=>void,requested!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),requestStarted=new Promise<void>(resolve=>requested=resolve);
 await page.route(/.*lang-python.*|.*lang_python.*/,async route=>{requested();await gate;await route.continue();});
 await editor.fill('```python\n'+codeSamples.python+'\n```');await requestStarted;
 await preview(page);await page.getByRole('button',{name:'编辑模式',exact:true}).click();await editor.fill('替换后的正文');release();await page.unrouteAll({behavior:'wait'});
 const article=await preview(page);await expect(article).toHaveText('替换后的正文');await expect(article.locator('code')).toHaveCount(0);
});

test('language loading failure leaves readable code and usable editing',async({page})=>{
 let failed=0;await page.route(/.*lang-python.*|.*lang_python.*/,async route=>{failed++;await route.abort();});
 const editor=page.locator('.cm-content'),code=codeSamples.python;await editor.fill('```python\n'+code+'\n```');
 await expect.poll(()=>failed).toBeGreaterThan(0);
 const article=await preview(page);await expect(article.locator('pre code')).toHaveText(code);await expect(article.locator('pre code span')).toHaveCount(0);
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();await editor.press('Control+End');await editor.press('Enter');await editor.pressSequentially('still editable');await expect(editor).toContainText('still editable');
});
