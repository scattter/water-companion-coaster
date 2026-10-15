import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const source = readFileSync(new URL('../water_companion/ble_provision.cpp', import.meta.url), 'utf8');
function actual(signature) {
  const start = source.indexOf(`${signature}(`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return source.slice(start, end + 2);
}

test('BLE Wi-Fi 扫描隔离会话、认证和配网，异步返回真实网络并处理资源不足', () => {
  const globals = source.slice(source.indexOf('enum class ScanState'), source.indexOf('static int64_t now_ms'));
  const callbacks = source.slice(source.indexOf('class Wifi :'), source.indexOf('class Security :'));
  assert.ok(globals && callbacks);
  const program = `
#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <string>
using esp_err_t = int;
using String = std::string;
enum { ESP_OK, ESP_ERR_WIFI_STATE, ESP_ERR_NO_MEM, ESP_ERR_WIFI_TIMEOUT, pdPASS, WIFI_AUTH_OPEN, WIFI_AUTH_WPA2_PSK };
constexpr int portMAX_DELAY = -1;
static int mutex;
static bool locked, authenticated = true, window_open = true, busy, allocation_failed, task_failed;
static uint16_t connection_id = 7;
static int scans, tasks, deleted, network_result;
static void (*pending_task)(void *);
static void *pending_argument;
static struct { bool active; } frames;
struct wifi_ap_record_t { unsigned char ssid[33]; int8_t rssi; uint8_t primary; int authmode; };
static wifi_ap_record_t found[20];
static uint16_t found_count;
static bool open_locked() { return window_open; }
static bool provisioning_busy() { return busy; }
static void xSemaphoreTake(int, int) { assert(!locked); locked = true; }
static void xSemaphoreGive(int) { assert(locked); locked = false; }
static void *test_calloc(size_t count, size_t size) { return allocation_failed ? nullptr : std::calloc(count, size); }
static int network_scan(wifi_ap_record_t *records, uint16_t *count) {
    assert(!locked && *count == 20); ++scans;
    if (network_result != ESP_OK) return network_result;
    *count = found_count;
    memcpy(records, found, found_count * sizeof(*records));
    return ESP_OK;
}
static int xTaskCreate(void (*entry)(void *), const char *name, unsigned stack, void *arg, int priority, void *) {
    assert(locked && !pending_task && !strcmp(name, "coaster-scan") && stack >= 4096 && priority == 1);
    if (task_failed) return -1;
    pending_task = entry; pending_argument = arg; ++tasks; return pdPASS;
}
static void vTaskDelete(void *task) { assert(!locked && !task); ++deleted; }
${globals}
${actual('static void reset_wifi_scan')}
#define calloc test_calloc
${actual('static void scan_wifi')}
#undef calloc
${actual('static void request_wifi_scan')}

struct ble_gap_conn_desc { uint16_t conn_handle; struct { bool encrypted, authenticated; } sec_state; };
struct BLECharacteristic {
    String value;
    String getValue() { return value; }
    void setValue(const char *text) { value = text; }
};
class BLECharacteristicCallbacks {
public:
    virtual void onWrite(BLECharacteristic *, ble_gap_conn_desc *) {}
    virtual void onRead(BLECharacteristic *, ble_gap_conn_desc *) {}
};
struct cJSON { std::map<std::string, std::string> fields; std::shared_ptr<cJSON> network; };
static cJSON last_json;
static cJSON *cJSON_CreateObject() { return new cJSON; }
static void cJSON_AddStringToObject(cJSON *json, const char *name, const char *value) { json->fields[name] = value; }
static void cJSON_AddNumberToObject(cJSON *json, const char *name, int value) { json->fields[name] = std::to_string(value); }
static void cJSON_AddBoolToObject(cJSON *json, const char *name, bool value) { json->fields[name] = value ? "true" : "false"; }
static cJSON *cJSON_AddObjectToObject(cJSON *json, const char *name) {
    assert(!strcmp(name, "network")); json->network = std::make_shared<cJSON>(); return json->network.get();
}
static void characteristic_json(BLECharacteristic *characteristic, cJSON *json) {
    last_json = *json; delete json; characteristic->setValue("snapshot");
}
${callbacks}
static Wifi wifi;
static BLECharacteristicCallbacks *callbacks = &wifi;
static BLECharacteristic characteristic;
static ble_gap_conn_desc peer = {7, {true, true}};
static void request() { characteristic.value.assign(1, 1); callbacks->onWrite(&characteristic, &peer); }
static void read() { callbacks->onRead(&characteristic, &peer); }
static void finish() {
    auto task = pending_task; auto argument = pending_argument;
    assert(task); pending_task = nullptr; task(argument);
    assert(!scan_running && !locked);
}
static void reset() { xSemaphoreTake(mutex, portMAX_DELAY); reset_wifi_scan(); xSemaphoreGive(mutex); }
static void network(unsigned index, const char *ssid, int rssi, unsigned channel, int auth) {
    strcpy(reinterpret_cast<char *>(found[index].ssid), ssid); found[index].rssi = rssi;
    found[index].primary = channel; found[index].authmode = auth;
}
int main() {
    network(0, "客厅 Wi-Fi", -50, 6, WIFI_AUTH_WPA2_PSK);
    network(1, "5G", -30, 36, WIFI_AUTH_WPA2_PSK);
    network(2, "", -40, 1, WIFI_AUTH_OPEN);
    network(3, "guest", -70, 11, WIFI_AUTH_OPEN);
    found_count = 4;
    authenticated = false; request(); assert(!tasks); read(); assert(characteristic.value.empty());
    authenticated = true; peer.sec_state.encrypted = false; request(); assert(!tasks);
    peer.sec_state.encrypted = true; peer.sec_state.authenticated = false; request(); assert(!tasks);
    peer.sec_state.authenticated = true; peer.conn_handle = 8; request(); assert(!tasks);
    peer.conn_handle = 7; window_open = false; request(); assert(!tasks);
    window_open = true;
    request(); assert(scan_running && scan_state == ScanState::Scanning && scans == 0);
    request(); assert(tasks == 1);
    read(); assert(last_json.fields["state"] == "scanning" && last_json.fields["count"] == "0");
    finish(); assert(scans == 1 && deleted == 1 && scan_state == ScanState::Ready && scan_count == 2);
    read(); assert(last_json.fields["count"] == "2" && last_json.fields["index"] == "0");
    assert(last_json.network->fields["ssid"] == "客厅 Wi-Fi" && last_json.network->fields["secure"] == "true");
    characteristic.value = String({char(2), char(1)}); callbacks->onWrite(&characteristic, &peer); read();
    assert(last_json.network->fields["ssid"] == "guest" && last_json.network->fields["secure"] == "false");
    characteristic.value = String({char(2), char(99)}); callbacks->onWrite(&characteristic, &peer); assert(scan_index == 1);

    busy = true; request(); assert(!scan_running && scan_state == ScanState::Failed);
    read(); assert(last_json.fields["code"] == "WIFI_BUSY" && last_json.fields["count"] == "0");
    busy = false; frames.active = true; request(); assert(tasks == 1); frames.active = false;
    task_failed = true; request(); assert(!scan_running && scan_error == ESP_ERR_NO_MEM); task_failed = false;
    allocation_failed = true; request(); finish(); assert(scan_state == ScanState::Failed && scans == 1);
    allocation_failed = false; network_result = ESP_ERR_WIFI_STATE; request(); finish();
    read(); assert(last_json.fields["code"] == "WIFI_BUSY");
    network_result = ESP_ERR_WIFI_TIMEOUT; request(); finish();
    read(); assert(last_json.fields["code"] == "SCAN_FAILED");
    network_result = ESP_OK; found_count = 0; request(); finish();
    read(); assert(last_json.fields["state"] == "ready" && last_json.fields["count"] == "0" && !last_json.network);

    found_count = 4; request(); reset(); request();
    assert(scan_state == ScanState::Failed && scan_error == ESP_ERR_WIFI_STATE);
    finish(); assert(scan_count == 0 && scan_state == ScanState::Failed);
    request(); finish(); assert(scan_count == 2 && scan_state == ScanState::Ready);
    reset(); read(); assert(last_json.fields["state"] == "idle" && last_json.fields["count"] == "0");
}
`;
  const directory = mkdtempSync(join(tmpdir(), 'coaster-ble-wifi-'));
  try {
    const filename = join(directory, 'scan.cpp');
    const executable = join(directory, 'scan');
    writeFileSync(filename, program);
    const compile = spawnSync(process.env.CXX || 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-pedantic', filename, '-o', executable], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    const run = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
