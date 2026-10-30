import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const firmware = fileURLToPath(new URL('../water_companion/', import.meta.url));
function actual(file, signature) {
  const source = readFileSync(join(firmware, file), 'utf8');
  const start = source.indexOf(`${signature}(`);
  assert.notEqual(start, -1);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function run(source) {
  const dir = mkdtempSync(join(tmpdir(), 'coaster-cups-'));
  try {
    writeFileSync(join(dir, 'test.c'), source);
    const compiled = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic',
      '-I', firmware, join(dir, 'test.c'), join(firmware, 'cups.c'), '-lm', '-o', join(dir, 'test')], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(join(dir, 'test'), [], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('实际 NVS 杯子读写与启动迁移：重启、删除不复活、换绑、损坏及写入失败', () => {
  run(`
#include <assert.h>
#include <math.h>
#include <string.h>
#include "cups.h"
typedef int esp_err_t;
enum { ESP_OK, ESP_ERR_NVS_NOT_FOUND, ESP_ERR_INVALID_RESPONSE, ESP_ERR_INVALID_ARG, ESP_FAIL };
static int settings, writes, write_error;
static bool present;
static cup_config_t disk, cups;
static size_t disk_size = sizeof(disk);
static struct { float empty_cup; } config;
static struct { char binding_id[37]; } binding;
static bool provision_uuid(const char *id) { return strlen(id) == 36; }
static int nvs_get_blob(int handle, const char *key, void *data, size_t *size) {
    (void)handle; assert(!strcmp(key, "cups"));
    if (!present) return ESP_ERR_NVS_NOT_FOUND;
    assert(*size >= disk_size); memcpy(data, &disk, disk_size); *size = disk_size; return ESP_OK;
}
static int save_setting(const char *key, const void *data, size_t size) {
    assert(!strcmp(key, "cups") && size == sizeof(disk)); ++writes;
    if (write_error) return write_error;
    memcpy(&disk, data, size); disk_size = size; present = true; return ESP_OK;
}
${actual('storage.c', 'esp_err_t storage_load_cups')}
${actual('storage.c', 'esp_err_t storage_save_cups')}
${actual('coaster.c', 'static esp_err_t load_cups')}
int main(void) {
    strcpy(binding.binding_id, "11111111-1111-4111-8111-111111111111");
    config.empty_cup = 120.5f;
    assert(load_cups() == ESP_OK && writes == 1 && cups.active_id == 1);
    assert(!strcmp(cups.items[0].name, "默认杯") && cups_weight(&disk) == 120.5f);
    strcpy(cups.items[1].name, "茶杯A1"); cups.items[1].empty_cup = 180; cups.active_id = 2;
    assert(storage_save_cups(&cups) == ESP_OK);
    config.empty_cup = 999; assert(load_cups() == ESP_OK && config.empty_cup == 180);
    assert(cups_next(&cups, 1) == 2 && cups_next(&cups, 2) == 1);
    strcpy(cups.items[2].name, "三号杯"); cups.items[2].empty_cup = 200;
    assert(cups_next(&cups, 2) == 3 && cups_next(&cups, 3) == 1);
    cup_config_t previous = disk;
    write_error = ESP_FAIL; assert(storage_save_cups(&cups) == ESP_FAIL);
    assert(!memcmp(&disk, &previous, sizeof(disk))); write_error = 0;
    cups_init(&cups, binding.binding_id, 0); assert(storage_save_cups(&cups) == ESP_OK);
    config.empty_cup = 120; assert(load_cups() == ESP_OK && config.empty_cup == 0 && !cups.active_id);
    cups_init(&disk, "22222222-2222-4222-8222-222222222222", 150);
    assert(load_cups() == ESP_OK && !cups.active_id && !strcmp(disk.binding_id, binding.binding_id));
    disk_size = 7; assert(load_cups() == ESP_ERR_INVALID_RESPONSE); disk_size = sizeof(disk);
    disk.version = 99; assert(load_cups() == ESP_ERR_INVALID_RESPONSE); disk.version = 1;
    disk.items[0].empty_cup = NAN; assert(load_cups() == ESP_ERR_INVALID_RESPONSE);
    present = false; write_error = ESP_FAIL; config.empty_cup = 110;
    assert(load_cups() == ESP_FAIL && !present && config.empty_cup == 110);
    return 0;
}
`);
});

test('实际按键状态机：消抖、双击窗口、三击、长按优先及计时回绕', () => {
  run(`
#include <assert.h>
#include "button.h"
static unsigned tap(button_t *b, uint32_t at) {
    assert(!button_poll(b, true, at));
    assert(button_poll(b, true, at + 40) == BUTTON_WAKE);
    assert(!button_poll(b, false, at + 80));
    return button_poll(b, false, at + 120);
}
int main(void) {
    button_t b = {0};
    assert(!button_poll(&b, true, 0)); assert(!button_poll(&b, false, 10));
    assert(!button_poll(&b, false, 50) && !b.waiting);
    assert(!tap(&b, 100)); assert(tap(&b, 300) == BUTTON_DOUBLE); assert(!tap(&b, 500));
    b = (button_t){0}; assert(!tap(&b, 100)); assert(tap(&b, 580) == BUTTON_DOUBLE);
    b = (button_t){0}; assert(!tap(&b, 100)); assert(!tap(&b, 581));
    b = (button_t){0}; assert(!tap(&b, 100));
    assert(!button_poll(&b, true, 300)); assert(button_poll(&b, true, 340) == BUTTON_WAKE);
    assert(!button_poll(&b, true, 3339)); assert(button_poll(&b, true, 3340) == BUTTON_LONG);
    assert(!button_poll(&b, true, 5000)); assert(!button_poll(&b, false, 5100));
    assert(!button_poll(&b, false, 5140) && !b.waiting);
    b = (button_t){0}; assert(!tap(&b, UINT32_MAX - 200)); assert(tap(&b, 10) == BUTTON_DOUBLE);
    return 0;
}
`);
});
