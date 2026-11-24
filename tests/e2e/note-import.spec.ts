import {expect, test, type Page} from '@playwright/test';

async function importMarkdown(page: Page, name: string, content: string | Buffer, menu = false) {
  const selection = page.waitForEvent('filechooser');
  if (menu) {
    await page.locator('.context-menu').getByRole('button', {name: '导入 Markdown', exact: true}).click();
  } else {
    await page.getByRole('button', {name: '导入 Markdown', exact: true}).click();
  }
  const chooser = await selection;
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles({
    name,
    mimeType: 'text/markdown',
    buffer: typeof content === 'string' ? Buffer.from(content) : content,
  });
  await expect(page.locator('#app')).not.toHaveAttribute('inert', '');
}

test.beforeEach(async ({page}) => {
  await page.goto('/');
  await expect(page.locator('.note-pane')).toHaveCount(1);
});

test('imports at the root, opens the note and restores it after reloading', async ({page}) => {
  await page.locator('#workspace-name').click();
  await importMarkdown(page, '外部笔记.md', '\uFEFF# 导入标题\r\n\r\n保留中文正文\r\n');
  const entry = page.locator('.tree-row[title="外部笔记.md"]');
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.article')).toContainText('保留中文正文');
  await expect(page.locator('.note-title strong')).toHaveText('外部笔记');
  await expect(page.locator('#toast')).toContainText('已导入“外部笔记.md”');
  await expect.poll(() => page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('shiye-demo-settings') || 'null');
    return settings?.session.panes[0]?.path;
  })).toBe('外部笔记.md');
  await page.reload();
  await expect(page.locator('.article')).toContainText('保留中文正文');

  for (const width of [1280, 900]) {
    await page.setViewportSize({width, height: 850});
    const button = page.locator('#import-markdown');
    await expect(button).toBeVisible();
    expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({path: '.qa/note-import/interface-' + width + '.png'});
  }
});

test('imports into the selected folder and numbers collisions without replacing existing notes', async ({page}) => {
  await page.locator('.tree-row[title="灵感"]').click({button: 'right'});
  await importMarkdown(page, '灵感收集.md', '# 新导入的正文', true);
  const entry = page.locator('.tree-row[title="灵感/灵感收集 (1).md"]');
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.article')).toContainText('新导入的正文');
  await importMarkdown(page, '灵感收集.md', '# 第二次导入');
  await expect(page.locator('.tree-row[title="灵感/灵感收集 (2).md"]')).toBeVisible();
  await page.locator('.tree-row[title="灵感/灵感收集.md"]').click();
  await expect(page.locator('.article')).toContainText('零散的想法');
  await expect(page.locator('.article')).not.toContainText('新导入的正文');
});

test('cancelling selection keeps the note and releases the busy state', async ({page}) => {
  const before = await page.locator('.article').textContent();
  const selection = page.waitForEvent('filechooser');
  await page.locator('#import-markdown').click();
  await selection;
  await expect(page.locator('#app')).toHaveAttribute('inert', '');
  await page.locator('input[type="file"]').dispatchEvent('cancel');
  await expect(page.locator('#app')).not.toHaveAttribute('inert', '');
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(await page.locator('.article').textContent()).toBe(before);
  await page.locator('#new-note').click();
  await expect(page.getByRole('button', {name: '创建笔记', exact: true})).toBeVisible();
});

test('rejects unsupported extensions and invalid UTF-8 without adding files', async ({page}) => {
  const before = await page.locator('.article').textContent();
  await importMarkdown(page, '错误.txt', '正文');
  await expect(page.locator('#toast')).toContainText('请选择 Markdown');
  await importMarkdown(page, '乱码.md', Buffer.from([0xff, 0xfe, 0x00]));
  await expect(page.locator('#toast')).toContainText('不是有效 UTF-8');
  await expect(page.locator('.tree-row[title="乱码.md"]')).toHaveCount(0);
  expect(await page.locator('.article').textContent()).toBe(before);
});

test('saves current edits before opening an imported note', async ({page}) => {
  await page.getByRole('button', {name: '编辑模式', exact: true}).click();
  await page.locator('.cm-content').fill('导入前的未保存修改');
  await importMarkdown(page, '后续笔记.md', '# 新页面');
  await expect(page.locator('.article')).toContainText('新页面');
  await page.locator('.tree-row[title="欢迎使用拾页.md"]').click();
  await expect(page.locator('.article')).toContainText('导入前的未保存修改');
});

test('reveals an imported file in a long virtualized tree', async ({page}) => {
  await page.evaluate(() => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 100; index++) {
      files['file-' + String(index).padStart(3, '0') + '.md'] = '# 已有笔记';
    }
    localStorage.setItem('shiye-demo-files', JSON.stringify(files));
  });
  await page.locator('#refresh').click();
  await page.locator('#workspace-name').click();
  await importMarkdown(page, 'zzz-imported.md', '# 列表末尾的笔记');
  await expect(page.locator('.tree-row[title="zzz-imported.md"]')).toBeVisible();
  await expect(page.locator('.article')).toContainText('列表末尾的笔记');
});
