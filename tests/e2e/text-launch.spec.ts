import {expect, test} from '@playwright/test';

test('system open enters the editor after startup and preserves a dirty tab on second launch', async ({page}) => {
 await page.addInitScript(() => {
  const file = {
   id: 'host-log', path: 'D:\\日志 目录\\运行.log', name: '运行.log',
   text: '日志正文\n', encoding: 'gbk', eol: 'crlf', version: 'v1', size: 10, readonly: false
  };
  let pending = true;
  const callbacks: Array<() => void> = [];
  let restored: (() => void) | undefined;
  window.addEventListener('test-second-launch', () => {
   pending = true;
   restored?.();
  });

  Object.assign(window, {
   __TAURI_INTERNALS__: {
    transformCallback(callback: () => void) {
     callbacks.push(callback);
     return callbacks.length - 1;
    },
    async invoke(command: string, args: Record<string, unknown> = {}) {
     switch (command) {
      case 'plugin:event|listen':
       if (args.event === 'restored') {
        restored = callbacks[Number(args.handler)];
       }
       return args.handler;
      case 'get_settings':
       return {
        root: null, shortcut: 'Control+Alt+Space', floating: false,
        session: {module: 'notes', panes: [], expanded: []}
       };
      case 'get_autostart_status':
       return {state: 'disabled', revision: 'v1', target: null, message: null};
      case 'text_restore':
       return {schema: 1, generation: 0, documents: [], views: [], active: 0};
      case 'text_checkpoint':
       return {generation: (args.value as {generation: number}).generation, token: 'checkpoint'};
      case 'frontend_ready':
       return pending;
      case 'text_open_launch': {
       const files = pending ? [file] : [];
       pending = false;
       return {files, errors: [], notes: []};
      }
      case 'text_read':
       return {kind: 'unchanged', id: file.id, version: file.version, size: file.size, readonly: false};
      default:
       return null;
     }
    }
   }
  });
 });

 await page.goto('/');
 const editor = page.getByRole('textbox', {name: '运行.log 文本编辑器'});
 const tabs = page.locator('.text-tabs [role=tab]');
 await expect(page.locator('#nav-text')).toHaveClass(/selected/);
 await expect(editor).toContainText('日志正文');
 await expect(editor).toBeFocused();
 await editor.fill('未保存的草稿');

 await page.locator('#nav-notes').click();
 await page.locator('#settings').click();
 const dialog = page.getByRole('dialog');
 await expect(dialog).toBeVisible();
 await page.evaluate(() => window.dispatchEvent(new Event('test-second-launch')));
 await expect(page.locator('#nav-notes')).toHaveClass(/selected/);
 await dialog.getByRole('button', {name: '取消'}).click();

 await expect(page.locator('#nav-text')).toHaveClass(/selected/);
 await expect(tabs).toHaveCount(1);
 await expect(editor).toHaveText('未保存的草稿');
 await expect(editor).toBeFocused();
});
