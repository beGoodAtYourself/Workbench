"""Generate the project's simple document mark without external packages."""
from pathlib import Path
import struct
import zlib

size = 64
rows = bytearray()
for y in range(size):
    rows.append(0)
    for x in range(size):
        color = (42, 76, 57, 255)
        if 19 <= x <= 44 and 14 <= y <= 49:
            color = (241, 241, 222, 255)
        if 24 <= x <= 39 and y in (25, 26, 33, 34, 41, 42):
            color = (76, 105, 81, 255)
        rows.extend(color)

def chunk(kind, content):
    return struct.pack('>I', len(content)) + kind + content + struct.pack('>I', zlib.crc32(kind + content))

png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
out = Path(__file__).resolve().parents[1] / 'src-tauri/icons'
out.mkdir(parents=True, exist_ok=True)
(out / 'icon.png').write_bytes(png)
(out / 'icon.ico').write_bytes(struct.pack('<HHH', 0, 1, 1) + struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(png), 22) + png)
print('Created icon.png and icon.ico')
