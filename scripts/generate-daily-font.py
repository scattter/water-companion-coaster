"""将日常页用到的矢量字形按实际字号生成 4 位灰度字模；需要 Pillow。"""
import argparse
import hashlib
import math
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--text-font", required=True, type=Path, help="NotoSansSC[wght].ttf")
parser.add_argument("--number-font", required=True, type=Path, help="RobotoCondensed[wght].ttf")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = (root / "firmware/water_companion/display.cpp").read_text()
daily = source.split("static daily_view_t daily_view", 1)[1].split("static void show_daily", 1)[0]
literals = re.findall(r'"([^"\n]*)"', daily)
characters = sorted(set("0123456789ml?- ") | {
    character for literal in literals for character in literal if ord(character) > 127
})
bitmap = bytearray()
output = [
    "// 日常页抗锯齿字模；由 scripts/generate-daily-font.py 生成，不手工编辑。",
    "// Noto Sans SC / Roboto Condensed 字形子集，SIL OFL 1.1；见 daily-font-license.txt。",
    f"// Text SHA-256: {hashlib.sha256(args.text_font.read_bytes()).hexdigest()}",
    f"// Number SHA-256: {hashlib.sha256(args.number_font.read_bytes()).hexdigest()}",
    "#pragma once", "#include <stdint.h>",
    "typedef struct { uint16_t code; uint8_t width, height, advance; int8_t left, top; uint32_t offset; } daily_glyph_t;",
    "typedef struct { uint8_t size; uint16_t count; const daily_glyph_t *glyphs; } daily_font_t;",
]


def generate(name, path, sizes, chars, weight, horizontal_scale):
    fonts = []
    for size in sizes:
        # 四倍采样矢量轮廓后覆盖率降采样，保留小字号中文细线和数字曲线。
        scale = 4
        font = ImageFont.truetype(str(path), size * scale)
        font.set_variation_by_axes([weight])
        records = []
        for character in chars:
            left, top, right, bottom = font.getbbox(character, anchor="ls")
            left = math.floor(left * horizontal_scale / scale)
            top = math.floor(top / scale)
            right = math.ceil(right * horizontal_scale / scale)
            bottom = math.ceil(bottom / scale)
            width, height = right - left, bottom - top
            advance = max(1, round(font.getlength(character) * horizontal_scale / scale))
            if width and height:
                high = Image.new("L", (math.ceil(width * scale / horizontal_scale), height * scale))
                ImageDraw.Draw(high).text((-left * scale / horizontal_scale, -top * scale),
                                          character, font=font, fill=255, anchor="ls")
                mask = high.resize((width, height), Image.Resampling.BOX)
                alpha = [(value * 15 + 127) // 255 for value in mask.tobytes()]
            else:
                width = height = 0
                alpha = []
            offset = len(bitmap)
            if len(alpha) % 2:
                alpha.append(0)
            bitmap.extend((alpha[i] << 4) | alpha[i + 1] for i in range(0, len(alpha), 2))
            records.append(f"    {{0x{ord(character):04x}, {width}, {height}, {advance}, {left}, {top}, {offset}}},")
        label = f"DAILY_{name}_{size}"
        output.extend([f"static const daily_glyph_t {label}[] = {{", *records, "};"])
        fonts.append(f"    {{{size}, {len(chars)}, {label}}},")
    output.extend([f"static const daily_font_t DAILY_{name}_FONTS[] = {{", *fonts, "};"])


generate("TEXT", args.text_font, [10, 11, 12, 13, 14, 18], characters, 550, 1)
generate("NUMBER", args.number_font, [10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64],
         sorted("0123456789-?"), 800, 0.88)
output.append("static const uint8_t DAILY_BITMAP[] = {")
for start in range(0, len(bitmap), 24):
    output.append("    " + ", ".join(f"0x{value:02x}" for value in bitmap[start:start + 24]) + ",")
output.append("};")
(root / "firmware/water_companion/display_daily_font.h").write_text("\n".join(output) + "\n")
print(f"Generated {len(characters)} text characters, {len(bitmap)} bitmap bytes.")
