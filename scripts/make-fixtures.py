from pathlib import Path
root = Path(__file__).resolve().parents[1] / '.qa' / 'notes'
root.mkdir(parents=True, exist_ok=True)
line = '本地笔记测试，文件内容保留在用户选择的目录。\n'
def sized(heading, size):
    left = size - len(heading.encode('utf-8'))
    repeated, tail = divmod(left, len(line.encode('utf-8')))
    return heading + line * repeated + 'x' * tail
for folder in range(50):
    directory = root / f'folder-{folder:02}'
    directory.mkdir(exist_ok=True)
    for index in range(20):
        path = directory / f'note-{index:02}.md'
        path.write_text(sized(f'# Note {folder}-{index}\n\n', 20 * 1024), encoding='utf-8', newline='\n')
for name, next_name in [('A', 'B'), ('B', 'C'), ('C', 'A')]:
    path = root / f'{name}.md'
    path.write_text(sized(f'# {name} · 本地笔记\n\n[打开 {next_name}]({next_name}.md)\n\n## 内容\n\n', 100 * 1024), encoding='utf-8', newline='\n')
(root / 'large.md').write_text('# Large\n\n' + 'a' * (2 * 1024 * 1024), encoding='utf-8')
(root / 'two-mib.md').write_text(sized('# Two MiB\n\n', 2 * 1024 * 1024), encoding='utf-8', newline='\n')
print(root)
