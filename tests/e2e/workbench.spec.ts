import {test,expect,type Page} from '@playwright/test';
test.beforeEach(async({page})=>{await page.goto('/');await expect(page.locator('.note-pane')).toHaveCount(1);});
async function createFolder(page:Page,name:string,location:string){
 await page.locator('#new-folder').click();
 await expect(page.locator('dialog')).toContainText('保存位置：'+location);
 await page.getByLabel('名称',{exact:true}).fill(name);
 await page.getByRole('button',{name:'创建文件夹',exact:true}).click();
}
test('selecting the workspace root or tree background creates separate top-level folders',async({page})=>{
 await createFolder(page,'项目一','笔记根目录');
 await expect(page.locator('.tree-row[title="项目一"]')).toHaveAttribute('aria-selected','true');
 await page.locator('#workspace-name').click();
 await expect(page.locator('#workspace-name')).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.tree-row[aria-selected="true"]')).toHaveCount(0);
 await createFolder(page,'项目二','笔记根目录');
 const tree=page.locator('#tree'),bounds=await tree.boundingBox();
 await tree.click({position:{x:20,y:bounds!.height-8}});
 await createFolder(page,'项目三','笔记根目录');
 for(const name of ['项目一','项目二','项目三'])await expect(page.locator('.tree-row[title="'+name+'"]')).toBeVisible();
 await expect(page.locator('.note-pane')).toHaveCount(1);
});
test('folder menus create siblings at the root and inside a parent while the toolbar creates children',async({page})=>{
 await createFolder(page,'父目录','笔记根目录');
 await createFolder(page,'子目录一','父目录');
 await expect(page.locator('.tree-row[title="父目录/子目录一"]')).toBeVisible();
 await page.locator('.tree-row[title="父目录/子目录一"]').click({button:'right'});
 await page.getByRole('button',{name:'新建同级文件夹',exact:true}).click();
 await expect(page.locator('dialog')).toContainText('保存位置：父目录');
 await page.getByLabel('名称',{exact:true}).fill('子目录二');
 await page.getByRole('button',{name:'创建文件夹',exact:true}).click();
 await expect(page.locator('.tree-row[title="父目录/子目录二"]')).toBeVisible();
 await page.locator('.tree-row[title="父目录"]').click({button:'right'});
 await page.getByRole('button',{name:'新建同级文件夹',exact:true}).click();
 await expect(page.locator('dialog')).toContainText('保存位置：笔记根目录');
 await page.getByLabel('名称',{exact:true}).fill('另一个父目录');
 await page.getByRole('button',{name:'创建文件夹',exact:true}).click();
 await expect(page.locator('.tree-row[title="另一个父目录"]')).toBeVisible();
 await expect(page.locator('.tree-row[title="父目录/子目录一"]')).toBeVisible();
});
test('the tree background menu targets the root and disables operations on the previous selection',async({page})=>{
 await createFolder(page,'已有目录','笔记根目录');
 const tree=page.locator('#tree'),bounds=await tree.boundingBox();
 await tree.click({button:'right',position:{x:20,y:bounds!.height-8}});
 const menu=page.locator('.context-menu');
 await expect(menu.getByRole('button',{name:'重命名',exact:true})).toBeDisabled();
 await expect(menu.getByRole('button',{name:'移至回收站',exact:true})).toBeDisabled();
 const menuBounds=await menu.boundingBox();
 expect(menuBounds!.y+menuBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
 await menu.getByRole('button',{name:'新建文件夹',exact:true}).click();
 await expect(page.locator('dialog')).toContainText('保存位置：笔记根目录');
 await page.getByLabel('名称',{exact:true}).fill('并列目录');
 await page.getByRole('button',{name:'创建文件夹',exact:true}).click();
 await expect(page.locator('.tree-row[title="并列目录"]')).toBeVisible();
});
test('renders the workbench and rotates A B C without a third pane',async({page})=>{
 await expect(page.getByRole('heading',{name:'给思绪一个落脚点'})).toBeVisible();
 await page.locator('.article').getByRole('link',{name:'使用指南'}).click();
 await expect(page.locator('.note-pane')).toHaveCount(2);
 await page.locator('.note-pane').nth(1).getByRole('link',{name:'灵感收集',exact:true}).click();
 await expect(page.locator('.note-pane')).toHaveCount(2);
 await expect(page.locator('.note-pane').nth(0).locator('.note-title strong')).toHaveText('使用指南');
 await expect(page.locator('.note-pane').nth(1).locator('.note-title strong')).toHaveText('灵感收集');
 await page.screenshot({path:'.qa/workbench-split.png'});
 await page.getByRole('button',{name:'关闭右窗格'}).click();await expect(page.locator('.note-pane')).toHaveCount(1);
});
test('edits, saves, switches modes and retains undo across remounts',async({page})=>{
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();
 const editor=page.locator('.cm-content');await editor.click();await editor.press('Control+End');await editor.press('Enter');await page.keyboard.insertText('Saved marker');
 await expect(editor).toContainText('Saved marker');
 await expect(page.locator('.save-state')).toHaveText('已保存到本地');
 await page.getByRole('button',{name:'显示模式',exact:true}).click();await expect(page.locator('.article')).toContainText('Saved marker');
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();await editor.click();await editor.press('Control+z');await expect(editor).not.toContainText('Saved marker');await editor.press('Control+y');await expect(editor).toContainText('Saved marker');await editor.press('Control+End');await editor.press('Enter');await page.keyboard.insertText('Second marker');await expect(editor).toContainText('Second marker');
 await editor.press('Control+s');await page.getByRole('button',{name:'显示模式',exact:true}).click();await expect(page.locator('.article')).toContainText('Second marker');
 await page.reload();await expect(page.locator('.cm-content')).toContainText('Second marker');
});
test('dragging a tree note inserts a link and Ctrl-click opens it',async({page})=>{
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();
 const editor=page.locator('.cm-content');await editor.click();await editor.press('Control+Home');
 await page.getByRole('treeitem').filter({hasText:'使用指南'}).dragTo(editor,{targetPosition:{x:160,y:13}});
 await expect(editor.locator('.cm-line').first()).toContainText('[使用指南]('+encodeURIComponent('使用指南')+'.md)');
 await editor.locator('.cm-line').first().getByText('使用指南',{exact:true}).click({modifiers:['Control']});await expect(page.locator('.note-pane')).toHaveCount(2);
 await page.getByRole('treeitem').filter({hasText:'欢迎使用'}).click();await expect(page.locator('.note-pane')).toHaveCount(2);
});
test('unsupported drags preserve the note and explain the restriction',async({page})=>{
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();const editor=page.locator('.cm-content'),before=await editor.textContent();
 await page.getByRole('treeitem').filter({hasText:'灵感'}).dragTo(editor);await expect(page.locator('#toast')).toContainText('文件夹不能插入链接');expect(await editor.textContent()).toBe(before);
 await page.getByRole('button',{name:'显示模式',exact:true}).click();const article=page.locator('.article'),preview=await article.textContent();
 await page.getByRole('treeitem').filter({hasText:'使用指南'}).dragTo(article);await expect(page.locator('#toast')).toContainText('编辑模式');expect(await article.textContent()).toBe(preview);
});
test('new file operations and clipboard navigation keep content',async({page})=>{
 await page.getByRole('button',{name:'新建笔记',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('测试笔记');await page.getByRole('button',{name:'创建笔记',exact:true}).click();
 await expect(page.locator('.cm-content')).toBeVisible();await page.locator('.cm-content').fill('本地内容');await page.keyboard.press('Control+s');
 await page.getByRole('button',{name:'剪贴板',exact:true}).click();await expect(page.getByRole('heading',{name:'当前剪贴板'})).toBeVisible();await expect(page.getByLabel('当前剪贴板文本')).toContainText('在这里查看');
 await page.getByRole('button',{name:'笔记管理',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('本地内容');
 await page.getByRole('button',{name:'显示模式',exact:true}).click();await page.screenshot({path:'.qa/workbench-single.png'});
});
test('raw HTML is inert and remote images never load',async({page})=>{
 const requests:string[]=[];page.on('request',r=>requests.push(r.url()));
 await page.getByRole('button',{name:'编辑模式',exact:true}).click();await page.locator('.cm-content').fill('<script>window.bad=true</script>\n\n![remote](https://example.com/private.png)');
 await page.getByRole('button',{name:'显示模式',exact:true}).click();await expect(page.locator('.article')).toContainText('<script>');expect(requests.some(url=>url.includes('private.png'))).toBe(false);
 expect(await page.evaluate(()=>('bad' in window))).toBe(false);
});
