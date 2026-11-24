import {expect, test} from '@playwright/test';

test.beforeEach(async ({page}) => {
 await page.goto('/?empty');
 await page.locator('#nav-text').click();
});

test('a pending file picker cannot silently lose its result through module switching or hiding', async ({page}) => {
 await page.evaluate(async () => {
  const url = new URL('/src/text-model.ts', location.href).href;
  const {TextWorkbench} = await import(url) as typeof import('../../src/text-model');
  const open = TextWorkbench.prototype.open;
  TextWorkbench.prototype.open = function (encoding) {
   const select = this.repo.open.bind(this.repo);
   let release!: () => void;
   const pending = new Promise<void>(resolve => { release = resolve; });
   Object.assign(window, {releaseTextOpen: release});
   this.repo.open = async value => {
    await pending;
    return select(value);
   };
   return open.call(this, encoding).finally(() => {
    this.repo.open = select;
    TextWorkbench.prototype.open = open;
   });
  };
 });
 await page.getByRole('button', {name: '打开文本文件', exact: true}).click();
 await expect(page.locator('#text-workspace')).toHaveAttribute('aria-busy', 'true');
 await page.locator('#nav-notes').click();
 await expect(page.locator('#toast')).toContainText('完成文件选择后再切换模块');
 await page.locator('#hide').click();
 await expect(page.locator('#toast')).toContainText('完成文件选择后再隐藏或退出');
 await expect(page.locator('#text-workspace')).toBeVisible();
 await page.evaluate(() => (window as unknown as {releaseTextOpen: () => void}).releaseTextOpen());
 await expect(page.locator('.text-tabs [role="tab"]')).toHaveCount(2);
 await expect(page.locator('.text-pane .cm-content')).toBeVisible();
 await expect(page.locator('.text-pane .cm-content')).toBeFocused();
 await expect(page.locator('#text-workspace')).toHaveAttribute('aria-busy', 'false');
 await page.locator('#nav-notes').click();
 await page.locator('#nav-text').click();
 await expect(page.locator('.text-tabs [role="tab"]')).toHaveCount(2);
});

test('pointer sorting keeps the active buffer and persists tab order', async ({page}) => {
 for (const text of ['first draft', 'second draft', 'third draft']) {
  await page.getByRole('button', {name: '新建文本', exact: true}).click();
  await page.locator('.text-pane.active .cm-content').fill(text);
 }
 const first = await page.getByRole('tab', {name: /未命名 1$/}).boundingBox();
 const third = await page.getByRole('tab', {name: /未命名 3$/}).boundingBox();
 await page.mouse.move(third!.x + third!.width / 2, third!.y + third!.height / 2);
 await page.mouse.down();
 await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2, {steps: 10});
 await page.mouse.up();
 await expect(page.locator('.text-tabs [role="tab"]')).toContainText(['未命名 3', '未命名 1', '未命名 2']);
 await expect(page.locator('.text-pane.active .cm-content')).toHaveText('third draft');
 await page.locator('#nav-notes').click();
 await page.reload();
 await page.locator('#nav-text').click();
 await expect(page.locator('.text-tabs [role="tab"]')).toContainText(['未命名 3', '未命名 1', '未命名 2']);
 await expect(page.locator('.text-pane.active .cm-content')).toHaveText('third draft');
});
