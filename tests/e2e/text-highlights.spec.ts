import {expect,test,type Locator,type Page} from '@playwright/test';
const editor=(page:Page)=>page.locator('#text-workspace .cm-content').first();
const selectLine=async(content:Locator)=>{await content.focus();await content.press('Control+Home');await content.press('Shift+End');};
test.beforeEach(async({page})=>{await page.goto('/?empty');await page.locator('#nav-text').click();});

test('background colors, partial clearing and undo never insert formatting into the text',async({page})=>{
 await page.locator('#text-workspace [data-text-action="new"]').first().click();const content=editor(page);
 await content.fill('重点内容😀\n下一行保持原样');await selectLine(content);await page.getByRole('button',{name:'黄色背景标注',exact:true}).click();
 await content.press('ArrowRight');await expect(content.locator('.text-mark-yellow')).toHaveText('重点内容😀');
 await content.press('Control+Home');await content.press('Shift+ArrowRight');await content.press('Shift+ArrowRight');await page.getByRole('button',{name:'蓝色背景标注',exact:true}).click();
 await content.press('ArrowRight');await expect(content.locator('.text-mark-blue')).toHaveText('重点');await expect(content.locator('.text-mark-yellow')).toHaveText('内容😀');
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(content.locator('.text-mark-blue')).toHaveCount(0);await expect(content.locator('.text-mark-yellow')).toHaveText('重点内容😀');
 await selectLine(content);await page.getByRole('button',{name:'清除选区标注',exact:true}).click();await expect(content.locator('.text-mark')).toHaveCount(0);
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(content.locator('.text-mark-yellow')).toHaveText('重点内容😀');
 expect(await content.locator('.cm-line').allTextContents()).toEqual(['重点内容😀','下一行保持原样']);
 await content.press('Control+Home');await page.keyboard.insertText('前缀');await expect(content.locator('.text-mark-yellow')).toHaveText('重点内容😀');
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(content.locator('.text-mark-yellow')).toHaveText('重点内容😀');
});

test('annotations on a saved file survive immediate close, reopen and reload without dirtying the file',async({page})=>{
 await page.getByRole('button',{name:'打开文本文件',exact:true}).click();const content=editor(page);
 const before=await content.locator('.cm-line').allTextContents();await selectLine(content);await page.getByRole('button',{name:'绿色背景标注',exact:true}).click();
 await expect(page.locator('.text-tab.active .text-dirty-dot')).toHaveCount(0);await page.getByRole('button',{name:'关闭 readme.txt',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'打开文本文件',exact:true}).click();await expect(content.locator('.text-mark-green')).toHaveText(before[0]);
 await expect(page.locator('.text-document-state')).toContainText('标注已存本机');
 await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-text-session-v1')??'{}').documents?.find((doc:{id:string})=>doc.id==='demo-readme')?.highlights?.length)).toBe(1);
 await page.reload();await page.locator('#nav-text').click();await expect(content.locator('.text-mark-green')).toHaveText(before[0]);
 expect(await content.locator('.cm-line').allTextContents()).toEqual(before);
});

test('background marks follow their document through tab reuse, module switches and saving',async({page})=>{
 await page.locator('#text-workspace [data-text-action="new"]').first().click();const content=editor(page);
 await content.fill('待办重点\n原始文本');await selectLine(content);await page.getByRole('button',{name:'粉色背景标注',exact:true}).click();
 await page.getByRole('button',{name:'保存文本',exact:true}).click();await expect(page.locator('.text-document-state')).toContainText('已保存到示例数据');
 const original=await page.evaluate(()=>JSON.parse(localStorage.getItem('shiye-demo-text-files-v1')??'[]').find((item:{name:string})=>item.name==='另存文本 1.txt').text);expect(original).toBe('待办重点\n原始文本');
 await page.locator('#text-workspace [data-text-action="new"]').first().click();await content.fill('另一个文件');await expect(content.locator('.text-mark')).toHaveCount(0);
 await page.getByRole('tab',{name:'另存文本 1.txt',exact:true}).click();await expect(content.locator('.text-mark-pink')).toHaveText('待办重点');
 await page.locator('#nav-notes').click();await page.locator('#nav-text').click();await expect(content.locator('.text-mark-pink')).toHaveText('待办重点');
});

test('palette remains usable and highlights readable at desktop window sizes',async({page})=>{
 await page.locator('#text-workspace [data-text-action="new"]').first().click();const content=editor(page);
 await content.fill('项目记录\n需要优先处理：补全文件导入流程\n已确认：原始文件内容保持不变\n下一步：检查导出结果');
 for(const [line,color] of [[1,'黄色'],[2,'绿色'],[3,'蓝色']] as const){await content.focus();await content.press('Control+Home');for(let i=0;i<line;i++)await content.press('ArrowDown');await content.press('Home');await content.press('Shift+End');await page.getByRole('button',{name:color+'背景标注',exact:true}).click();}
 await content.press('ArrowRight');await expect(page.locator('.text-document-state')).toContainText('标注已存本机');
 for(const [width,name] of [[1280,'desktop'],[960,'compact']] as const){
  await page.setViewportSize({width,height:850});await expect(page.getByRole('button',{name:'粉色背景标注',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'.impeccable/review/highlights-'+name+'.png',fullPage:true});
 }
});
