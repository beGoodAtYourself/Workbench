/** 浏览器预览只将选中文件复制到示例存储，桌面版使用原生文件选择框。 */
export function pickMarkdownFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md';
    input.hidden = true;
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), {once: true});
    input.addEventListener('cancel', () => finish(null), {once: true});
    document.body.append(input);
    input.click();
  });
}
