"""从 GNU Unifont 17.0.04 的 .hex.gz 生成屏幕固定文案所需的字形。"""
import gzip
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
display = root / "firmware/water_companion/display.cpp"
literals = re.findall(r'"([^"\n]*)"', display.read_text())
characters = set(range(32, 127)) | {
    ord(character) for literal in literals for character in literal if ord(character) > 127
}
glyphs = {}
with gzip.open(sys.argv[1], "rt") as source:
    for line in source:
        code, bitmap = line.strip().split(":")
        if int(code, 16) in characters:
            glyphs[int(code, 16)] = bytes.fromhex(bitmap)
assert characters == glyphs.keys(), "字体缺少屏幕使用的字符"
output = [
    "// GNU Unifont 17.0.04 字形子集；SIL OFL 1.1，见 display-font-license.txt。",
    "// 由 scripts/generate-display-font.py 生成；修改文案后重新生成。",
    "#pragma once", "#include <stdint.h>",
    "typedef struct { uint16_t code; uint8_t width; uint16_t rows[16]; } display_glyph_t;",
    "static const display_glyph_t DISPLAY_GLYPHS[] = {",
]
for code, bitmap in sorted(glyphs.items()):
    stride = len(bitmap) // 16
    assert stride in (1, 2)
    rows = [int.from_bytes(bitmap[i:i + stride], "big") << (8 if stride == 1 else 0)
            for i in range(0, len(bitmap), stride)]
    data = ", ".join(f"0x{row:04x}" for row in rows)
    output.append(f"    {{0x{code:04x}, {stride * 8}, {{{data}}}}},")
output.append("};")
(display.parent / "display_font.h").write_text("\n".join(output) + "\n")
print(f"Generated {len(glyphs)} glyphs.")
