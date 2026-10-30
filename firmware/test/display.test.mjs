import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const firmware = fileURLToPath(new URL('../water_companion/', import.meta.url));
const source = readFileSync(join(firmware, 'display.cpp'), 'utf8');
const board = readFileSync(join(firmware, 'board_config.h'), 'utf8');
const structure = (file, name) => readFileSync(join(firmware, file), 'utf8')
  .match(new RegExp(`typedef struct \\{[\\s\\S]*?\\} ${name};`))[0];

function png(rgb, scale = 1) {
  const width = 172 * scale, height = 320 * scale;
  function chunk(type, data) {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; ++bit) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, payload, suffix]);
  }
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
    const input = (Math.floor(y / scale) * 172 + Math.floor(x / scale)) * 3;
    rgb.copy(rows, y * (1 + width * 3) + 1 + x * 3, input, input + 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('屏幕文案的全部中文字形均存在', () => {
  const font = readFileSync(join(firmware, 'display_font.h'), 'utf8');
  const codes = new Set([...font.matchAll(/\{0x([0-9a-f]+), \d+,/g)].map(match => parseInt(match[1], 16)));
  const strings = [...source.matchAll(/"([^"\n]*)"/g)].map(match => match[1]).join('');
  for (const character of strings) assert.ok(codes.has(character.codePointAt(0)), `缺少字形：${character}`);
  const dailyFont = readFileSync(join(firmware, 'display_daily_font.h'), 'utf8');
  const dailyStrings = source.split('static daily_view_t daily_view')[1].split('static void show_daily')[0];
  const characters = new Set([...dailyStrings.matchAll(/"([^"\n]*)"/g)]
    .flatMap(match => [...match[1]]).filter(character => character.codePointAt(0) > 127));
  for (const block of dailyFont.matchAll(/DAILY_TEXT_\d+\[\] = \{([\s\S]*?)\n\};/g)) {
    const supported = new Set([...block[1].matchAll(/\{0x([0-9a-f]+),/g)].map(match => parseInt(match[1], 16)));
    for (const character of characters) assert.ok(supported.has(character.codePointAt(0)), `抗锯齿字体缺字：${character}`);
  }
  assert.ok(!source.includes('估算'));
});

test('真实 SPI 像素绘制：日常页布局、异常状态、长数字、模式切换及熄屏', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coaster-display-'));
  try {
    const program = `
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>
#include "display_font.h"
#include "display_daily_font.h"
#include "display_cup_font.h"
#include "cups.c"
using esp_err_t = int;
enum { ESP_OK, ESP_FAIL, LOW, HIGH, OUTPUT, MSBFIRST, SPI_MODE0,
    WIFI_REASON_NO_AP_FOUND, WIFI_REASON_AUTH_FAIL, WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT, WIFI_REASON_HANDSHAKE_TIMEOUT };
#define FIRMWARE_VERSION "test"
#define WEIGHING_MAX_GRAMS 2000
#define CONTROL_IP "192.168.4.1"
${[...board.matchAll(/^#define LCD_\w+ .+$/gm)].map(match => match[0]).join('\n')}
${structure('device.h', 'device_status_t')}
${structure('network.h', 'network_status_t')}
${structure('ble_provision.h', 'ble_provision_display_t')}
${structure('daily_summary.h', 'daily_summary_t')}
struct binding_state_t { char binding_id[37]; };
struct device_config_t {};
static int64_t uptime = 1000;
static int backlight, writes, command, x0, x1, row_start, row_end;
static bool busy;
static unsigned pending, time_pending;
static device_status_t input;
static network_status_t net;
static ble_provision_display_t ble;
static daily_summary_t summary;
static binding_state_t binding;
static std::vector<uint16_t> frame(LCD_WIDTH * LCD_HEIGHT);
static int64_t esp_timer_get_time() { return uptime * 1000; }
static void pinMode(int, int) {}
static void delay(int) {}
static void digitalWrite(int pin, int value) { if (pin == LCD_BL_PIN) backlight = value; }
static bool provisioning_busy() { return busy; }
static void network_snapshot(network_status_t *s) { *s = net; }
static void device_snapshot(device_status_t *s) { *s = input; }
static void ble_provision_snapshot(ble_provision_display_t *s) { *s = ble; }
static void device_config_snapshot(device_config_t *, binding_state_t *s) { *s = binding; }
static void network_daily_summary(daily_summary_t *s, const char *) { *s = summary; }
static void storage_counts(unsigned *p, unsigned *t) { *p = pending; *t = time_pending; }
struct SPISettings { SPISettings(int, int, int) {} };
static struct {
    bool begin(int, int, int, int) { return true; }
    void beginTransaction(SPISettings) {}
    void endTransaction() {}
    void transfer(uint8_t value) { command = value; }
    void writeBytes(const uint8_t *data, size_t length) {
        if (command == 0x2a) { x0 = (data[0] * 256 + data[1]) - LCD_X_OFFSET; x1 = (data[2] * 256 + data[3]) - LCD_X_OFFSET; }
        if (command == 0x2b) { row_start = data[0] * 256 + data[1]; row_end = data[2] * 256 + data[3]; }
        if (command != 0x2c) return;
        assert(x0 >= 0 && x1 < LCD_WIDTH && row_start >= 0 && row_end < LCD_HEIGHT);
        assert(length == size_t((x1 - x0 + 1) * (row_end - row_start + 1) * 2));
        size_t index = 0;
        for (int y = row_start; y <= row_end; ++y) for (int x = x0; x <= x1; ++x) {
            frame[y * LCD_WIDTH + x] = data[index] * 256 + data[index + 1]; index += 2;
        }
        ++writes;
    }
} SPI;
${source.replace(/^#include .+$/gm, '')}
static void capture(const char *path) {
    FILE *file = fopen(path, "wb"); assert(file);
    for (uint16_t color : frame) {
        uint8_t rgb[] = {uint8_t((color >> 11) * 255 / 31), uint8_t(((color >> 5) & 63) * 255 / 63), uint8_t((color & 31) * 255 / 31)};
        assert(fwrite(rgb, 1, 3, file) == 3);
    }
    fclose(file);
}
int main(int argc, char **argv) {
    assert(argc == 6 && display_start());
    assert(backlight == LOW);
    input.sensor_ready = input.calibrated = input.stable = input.cup_present = true;
    input.weight = 380; input.empty_cup = 120;
    cups_init(&input.cups, "11111111-1111-4111-8111-111111111111", 120);
    strcpy(input.cups.items[0].name, "保温杯A1");
    net.wifi_connected = net.server_connected = true;
    strcpy(binding.binding_id, "11111111-1111-4111-8111-111111111111");
    summary.received = summary.valid = summary.synced = true;
    summary.drink_ml = 1280; summary.drink_count = 6;
    summary.server_time_ms = 1800000000000LL;
    summary.last_drink_at_ms = summary.server_time_ms - 25 * 60000;
    summary.last_drink_ml = 120;
    display_wake(); display_update(ESP_OK);
    assert(backlight == LOW); uptime += 119; display_update(ESP_OK); assert(backlight == LOW);
    ++uptime; display_update(ESP_OK);
    assert(current_page == 1 && backlight == HIGH);
    daily_view_t view = daily_view(input, net, summary, 0, 0);
    assert(!strcmp(view.total, "1280") && !strcmp(view.water, "260") && !strcmp(view.age, "25分钟前"));
    assert(!strcmp(view.connection, "已同步") && !strcmp(view.notice, "杯垫工作正常"));
    assert(!strcmp(view.cup, "1: 保温杯A1"));
    for (const daily_font_t &font : DAILY_TEXT_FONTS) for (unsigned i = 0; i < font.count; ++i) {
        const auto &glyph = font.glyphs[i];
        assert(glyph.offset + (glyph.width * glyph.height + 1) / 2 <= sizeof(DAILY_BITMAP));
    }
    for (const daily_font_t &font : DAILY_NUMBER_FONTS) for (unsigned i = 0; i < font.count; ++i) {
        const auto &glyph = font.glyphs[i];
        assert(glyph.offset + (glyph.width * glyph.height + 1) / 2 <= sizeof(DAILY_BITMAP));
    }
    assert(daily_glyph(daily_font(64, true), '0').height >= 40);
    assert(shade(BLUE, 0) == 0 && shade(BLUE, 15) == BLUE);
    unsigned edge_shades = 0;
    for (unsigned alpha = 1; alpha < 15; ++alpha) {
        bool found = false;
        for (int y = 80; y < 140; ++y) for (int x = 8; x < 150; ++x)
            if (frame[y * LCD_WIDTH + x] == shade(BLUE, alpha)) found = true;
        if (found) ++edge_shades;
    }
    assert(edge_shades >= 10);
    capture(argv[1]);
    int painted = writes;
    display_update(ESP_OK); assert(writes == painted);
    for (const char *value : {"0", "1280", "99999", "8589934590000"}) {
        int height = quantity_height(value, "", "ml", 156, 64);
        assert(text_width(value, height, true) + text_width("ml", 13) + 3 <= 156);
    }
    for (const char *value : {"260", "1995"}) {
        int height = quantity_height(value, "约", "ml", 74, 28);
        assert(text_width(value, height, true) + text_width("约ml", 13) + 5 <= 74);
    }
    int height = quantity_height("4294967295", "", "次", 74, 28);
    assert(text_width("4294967295", height, true) + text_width("次", 13) + 3 <= 74);
    height = quantity_height("2000", "", "ml", 148 - text_width("时间待确认", 12), 24);
    assert(text_width("2000", height, true) + text_width("ml", 13) + 3 <= 148 - text_width("时间待确认", 12));
    summary.drink_ml = 1280.5;
    assert(!strcmp(daily_view(input, net, summary, 0, 0).total, "1281"));
    summary.drink_ml = 1280;
    net.wifi_connected = net.server_connected = false;
    view = daily_view(input, net, summary, 2, 0);
    assert(view.total_ready && !strcmp(view.connection, "离线") && strstr(view.notice, "2条"));
    pending = 2; display_update(ESP_OK); capture(argv[2]); pending = 0;
    net.wifi_connected = net.server_connected = true;
    summary.synced = false;
    assert(strcmp(daily_view(input, net, summary, 0, 0).connection, "已同步"));
    summary.synced = true;
    assert(strcmp(daily_view(input, net, summary, 1, 0).connection, "已同步"));
    input.cup_present = false;
    view = daily_view(input, net, summary, 0, 0); assert(!view.water_ready && !strcmp(view.water, "已取走"));
    input.cup_present = true; input.stable = false;
    assert(!strcmp(daily_view(input, net, summary, 0, 0).water, "待稳定"));
    input.stable = true; input.empty_cup = 0;
    assert(strstr(daily_view(input, net, summary, 0, 0).notice, "手机"));
    input.empty_cup = 120; input.weight = 119.5;
    assert(!strcmp(daily_view(input, net, summary, 0, 0).water, "0"));
    input.weight = NAN;
    view = daily_view(input, net, summary, 0, 0); assert(!view.water_ready && view.notice_color == RED);
    display_update(ESP_OK); capture(argv[4]);
    input.weight = 380; input.unsaved_event = true;
    assert(strstr(daily_view(input, net, summary, 2, 1).notice, "保存失败")); input.unsaved_event = false;
    summary.valid = false;
    view = daily_view(input, net, summary, 0, 0);
    assert(!view.total_ready && !strcmp(view.total, "--") && !strcmp(view.notice, "统计暂不可用"));
    display_update(ESP_OK); capture(argv[5]);
    summary.received = false;
    assert(!strcmp(daily_view(input, net, summary, 0, 0).notice, "等待云端统计"));
    summary.valid = true; summary.drink_ml = 0; summary.drink_count = 0; summary.last_drink_at_ms = 0;
    view = daily_view(input, net, summary, 0, 0);
    assert(!strcmp(view.total, "0") && !view.last_ready && !strcmp(view.last, "今日暂无记录"));
    display_update(ESP_OK); capture(argv[3]);
    net.ap_ready = net.control_ready = true;
    display_update(ESP_OK); assert(current_page == 1);
    ble.window_open = ble.pairing = true; ble.passkey = 123;
    display_update(ESP_OK); assert(current_page == 0 && !strcmp(previous[1].text, "000123"));
    ble.window_open = ble.pairing = false;
    display_update(ESP_OK); assert(current_page == 1);
    auto returned = frame;
    daily_drawn = false; display_update(ESP_OK); assert(frame == returned);
    binding.binding_id[0] = 0; display_update(ESP_OK); assert(current_page == 0);
    display_update(ESP_FAIL); assert(current_page == 2 && !strcmp(previous[0].text, "初始化失败"));
    for (int y = 150; y < LCD_HEIGHT; ++y) for (int x = 0; x < LCD_WIDTH; ++x)
        assert(frame[y * LCD_WIDTH + x] == 0);
    uptime += 15000; painted = writes; display_update(ESP_OK);
    assert(backlight == LOW && writes == painted);
    const auto before_sleep = frame;
    display_update(ESP_OK); assert(writes == painted);
    for (auto &pixel : frame) pixel = 0xffff;
    display_wake(); display_update(ESP_FAIL);
    assert(backlight == LOW); uptime += 120; display_update(ESP_FAIL);
    assert(backlight == HIGH && writes > painted && frame == before_sleep);
    painted = writes; display_update(ESP_FAIL); assert(writes == painted);
}
`;
    writeFileSync(join(dir, 'test.cpp'), program);
    const compiled = spawnSync(process.env.CXX || 'c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror',
      '-I', firmware, join(dir, 'test.cpp'), '-o', join(dir, 'test')], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const states = ['normal', 'offline', 'empty', 'error', 'unavailable'];
    const result = spawnSync(join(dir, 'test'), states.map(name => join(dir, `${name}.rgb`)), { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
    mkdirSync(output, { recursive: true });
    for (const name of states) {
      const rgb = readFileSync(join(dir, `${name}.rgb`));
      assert.equal(rgb.length, 172 * 320 * 3);
      writeFileSync(join(output, `daily-page-${name}.png`), png(rgb));
      writeFileSync(join(output, `daily-page-${name}-2x.png`), png(rgb, 2));
      writeFileSync(join(output, `daily-page-${name}-4x.png`), png(rgb, 4));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
