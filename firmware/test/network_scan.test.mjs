import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('Wi-Fi 扫描返回设备结果，忙时不抢占连接，失败或超时后释放资源', () => {
  const source = readFileSync(new URL('../water_companion/network.c', import.meta.url), 'utf8');
  const scan = source.match(/esp_err_t network_scan\([\s\S]*?\n\}/)?.[0];
  assert.ok(scan);
  const root = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'wifi-scan-'));
  try {
    const program = `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
typedef int esp_err_t;
typedef struct { char ssid[33]; int8_t rssi; } wifi_ap_record_t;
enum { ESP_OK, ESP_ERR_INVALID_ARG, ESP_ERR_INVALID_STATE, ESP_ERR_WIFI_STATE,
       ESP_ERR_WIFI_TIMEOUT, ESP_ERR_NO_MEM, pdTRUE };
#define pdMS_TO_TICKS(value) (value)
static int mutex;
static int *wifi_lock = &mutex;
static bool locked, list_allocated;
static int scan_result, records_result, scans, stops;
static int xSemaphoreTake(int *lock, int wait) {
    assert(lock == wifi_lock && wait >= 0);
    if (locked) return 0;
    locked = true;
    return pdTRUE;
}
static void xSemaphoreGive(int *lock) { assert(lock == wifi_lock && locked); locked = false; }
static int esp_wifi_scan_start(const void *config, bool block) {
    assert(!config && block && locked);
    ++scans;
    list_allocated = scan_result == ESP_OK || scan_result == ESP_ERR_WIFI_TIMEOUT;
    return scan_result;
}
static int esp_wifi_scan_get_ap_records(uint16_t *count, wifi_ap_record_t *records) {
    assert(locked && list_allocated && *count >= 1);
    if (records_result != ESP_OK) return records_result;
    *count = 1;
    strcpy(records[0].ssid, "客厅 Wi-Fi");
    records[0].rssi = -55;
    list_allocated = false;
    return ESP_OK;
}
static int esp_wifi_clear_ap_list(void) { assert(locked); list_allocated = false; return ESP_OK; }
static int esp_wifi_scan_stop(void) { assert(locked); ++stops; return ESP_OK; }
${scan}
int main(void) {
    wifi_ap_record_t records[2];
    uint16_t count = 2;
    assert(network_scan(records, &count) == ESP_OK);
    assert(count == 1 && !strcmp(records[0].ssid, "客厅 Wi-Fi") && records[0].rssi == -55);
    assert(!locked && !list_allocated);
    locked = true;
    int previous = scans;
    assert(network_scan(records, &count) == ESP_ERR_WIFI_STATE);
    assert(scans == previous && locked);
    locked = false;
    scan_result = ESP_ERR_WIFI_STATE;
    assert(network_scan(records, &count) == ESP_ERR_WIFI_STATE);
    assert(!locked && !list_allocated && stops == 0);
    scan_result = ESP_ERR_WIFI_TIMEOUT;
    assert(network_scan(records, &count) == ESP_ERR_WIFI_TIMEOUT);
    assert(!locked && !list_allocated && stops == 1);
    scan_result = ESP_OK;
    records_result = ESP_ERR_NO_MEM;
    assert(network_scan(records, &count) == ESP_ERR_NO_MEM);
    assert(!locked && !list_allocated);
    records_result = ESP_OK;
    assert(network_scan(records, &count) == ESP_OK);
    assert(!locked && !list_allocated);
    count = 0;
    assert(network_scan(records, &count) == ESP_ERR_INVALID_ARG);
    count = 2;
    wifi_lock = NULL;
    assert(network_scan(records, &count) == ESP_ERR_INVALID_STATE);
}
`;
    const filename = join(directory, 'scan-test.c');
    const executable = join(directory, 'scan-test');
    writeFileSync(filename, program);
    const compile = spawnSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror',
      '-pedantic', filename, '-o', executable], { encoding: 'utf8', env: { ...process.env, TMPDIR: directory } });
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    const run = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
