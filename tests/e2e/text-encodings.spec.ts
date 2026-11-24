import {expect,test} from '@playwright/test';

test.beforeEach(async({page})=>{await page.goto('/?empty');await page.locator('#nav-text').click();});

test('extended encodings participate in undo and draft restoration',async({page})=>{
 await page.locator('#text-workspace [data-text-action="new"]').first().click();
 const editor=page.locator('#text-workspace .cm-content').first(),encoding=page.getByLabel('文本编码',{exact:true});
 await editor.fill('中文😀 and text');await expect(encoding.locator('option')).toHaveCount(47);
 for(const value of ['gb18030','big5','shift-jis','windows-1252','utf32be-nobom']){await encoding.selectOption(value);await expect(encoding).toHaveValue(value);}
 await page.getByRole('button',{name:'撤销文本编辑',exact:true}).click();await expect(encoding).toHaveValue('windows-1252');
 await page.getByRole('button',{name:'重做文本编辑',exact:true}).click();await expect(encoding).toHaveValue('utf32be-nobom');
 await expect(editor).toHaveText('中文😀 and text');
 await expect(page.locator('.text-document-state')).toContainText('已暂存本机');
 await page.reload();await page.locator('#nav-text').click();await expect(encoding).toHaveValue('utf32be-nobom');await expect(editor).toHaveText('中文😀 and text');
});

test('explicit open is available in an empty workspace and cancellation preserves it',async({page})=>{
 await page.getByLabel('更多文本操作',{exact:true}).click();await page.getByRole('button',{name:'指定编码打开',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'指定编码打开',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByLabel('读取编码')).toHaveValue('gb18030');
 await dialog.getByLabel('读取编码').selectOption('gbk');await dialog.getByRole('button',{name:'取消',exact:true}).click();
 await expect(page.locator('.text-tabs [role="tab"]')).toHaveCount(0);
});

test('reopening explains discard and cancellation keeps unsaved content',async({page})=>{
 await page.getByRole('button',{name:'打开文本文件',exact:true}).click();
 const editor=page.locator('#text-workspace .cm-content').first();await editor.fill('保留未保存内容');
 await page.getByLabel('更多文本操作',{exact:true}).click();await page.getByRole('button',{name:'以其他编码重新打开',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'以其他编码重新打开',exact:true});await expect(dialog).toContainText('当前未保存的修改将被丢弃');
 await dialog.getByLabel('读取编码').selectOption('big5');await dialog.getByRole('button',{name:'取消',exact:true}).click();
 await expect(editor).toHaveText('保留未保存内容');await expect(page.getByLabel('文本编码',{exact:true})).toHaveValue('utf8');
});
