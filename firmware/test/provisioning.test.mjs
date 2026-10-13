import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('实际配网状态机只在连接成功后保存，失败保留身份标定并回退旧网络', () => {
  const network = readFileSync(new URL('../water_companion/network.c', import.meta.url), 'utf8');
  const device = readFileSync(new URL('../water_companion/coaster.c', import.meta.url), 'utf8');
  const update = network.match(/static void update_provisioning\([\s\S]*?\n\}/)?.[0];
  const cleanup = network.match(/static void clear_wifi_candidate\([\s\S]*?\n\}/)?.[0];
  const saveWifi = device.match(/esp_err_t device_save_wifi\([\s\S]*?\n\}/)?.[0];
  assert.ok(update && saveWifi && cleanup);
  const root = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'provisioning-'));
  try {
    const program = `
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef int esp_err_t;
enum { ESP_OK, WIFI_MODE_APSTA, WIFI_MODE_STA, WIFI_IF_STA };
#define CONNECTED 1
#define portMAX_DELAY 0
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
typedef struct { char ssid[33]; char password[65]; char device_id[65]; char token[129];
    bool calibrated; int zero; double counts_per_gram; float empty_cup; } device_config_t;
typedef struct { struct { char ssid[33]; char password[65]; } sta; } wifi_config_t;
static device_config_t config, settings, persisted;
static struct { bool wifi_trial, wifi_rollback, wifi_configured, wifi_connected, server_connected;
    int wifi_error, wifi_reason, http_status, server_error; char ip[16], wifi_ssid[33]; } network_status;
static int state_lock, wifi_lock, status_lock, wifi_state;
static int64_t ap_until_ms, trial_started_ms, next_cleanup_ms;
static uint32_t connection_generation;
static bool wifi_cleanup_pending;
static bool provision_requested, wifi_trial;
static char previous_ssid[33], previous_password[65];
static int connected, mode, writes, clear_count, reconnects, save_error, config_calls, clear_error;
static void xSemaphoreTake(int lock, int wait) { (void)lock; (void)wait; }
static void xSemaphoreGive(int lock) { (void)lock; }
static int xEventGroupGetBits(int group) { (void)group; return connected; }
static void xEventGroupClearBits(int group, int flags) { (void)group; connected &= ~flags; }
static int esp_wifi_set_mode(int value) { mode = value; return ESP_OK; }
static int esp_wifi_disconnect(void) { connected = 0; return ESP_OK; }
static int esp_wifi_set_config(int interface, const wifi_config_t *value) {
    assert(interface == WIFI_IF_STA); assert(!strcmp(value->sta.ssid, previous_ssid));
    assert(!strcmp(value->sta.password, previous_password)); ++config_calls; return ESP_OK;
}
static int esp_wifi_connect(void) { ++reconnects; return ESP_OK; }
static int storage_clear_wifi(void) { ++clear_count; return clear_error; }
static int storage_save_config(const device_config_t *value) {
    ++writes; if (save_error) return save_error; persisted = *value; return ESP_OK;
}
${saveWifi}
${cleanup}
${update}
static void prepare(void) {
    memset(&config, 0, sizeof(config));
    strcpy(config.ssid, "old"); strcpy(config.password, "old-password");
    strcpy(config.device_id, "coaster-unique"); strcpy(config.token, "secret-device-token");
    config.calibrated = true; config.zero = 1234; config.counts_per_gram = -234.5; config.empty_cup = 105.5f;
    persisted = config; settings = config;
    strcpy(previous_ssid, config.ssid); strcpy(previous_password, config.password);
    strcpy(settings.ssid, "new"); strcpy(settings.password, "new-password");
    wifi_trial = true; network_status.wifi_trial = true; network_status.wifi_rollback = false;
    trial_started_ms = 0; connected = writes = clear_count = reconnects = save_error = config_calls = 0;
    ap_until_ms = 600000; provision_requested = false;
    clear_error = 0; wifi_cleanup_pending = false;
}
static void identity_unchanged(void) {
    assert(!strcmp(config.device_id, "coaster-unique") && !strcmp(config.token, "secret-device-token"));
    assert(config.calibrated && config.zero == 1234 && config.counts_per_gram == -234.5 && config.empty_cup == 105.5f);
}
int main(void) {
    prepare();
    update_provisioning(44999);
    assert(writes == 0 && wifi_trial && !strcmp(config.ssid, "old")); identity_unchanged();
    update_provisioning(45000);
    assert(writes == 0 && !wifi_trial && network_status.wifi_rollback && clear_count == 1);
    assert(!strcmp(settings.ssid, "old") && !strcmp(config.ssid, "old"));
    assert(config_calls == 1 && reconnects == 1); identity_unchanged();
    prepare(); connected = CONNECTED;
    update_provisioning(1000);
    assert(writes == 1 && !wifi_trial && !network_status.wifi_trial && clear_count == 1);
    assert(!strcmp(config.ssid, "new") && !strcmp(persisted.ssid, "new")); identity_unchanged();
    prepare(); connected = CONNECTED; save_error = -1;
    update_provisioning(1000);
    assert(wifi_trial && !strcmp(config.ssid, "old") && clear_count == 0); identity_unchanged();
    update_provisioning(45000);
    assert(!wifi_trial && network_status.wifi_rollback && !strcmp(config.ssid, "old")); identity_unchanged();
    assert(!network_status.wifi_connected && !network_status.server_connected && !network_status.ip[0]);
    prepare(); clear_error = -1;
    update_provisioning(45000);
    assert(wifi_cleanup_pending && network_status.wifi_error == -1 && clear_count == 1);
    update_provisioning(49999); assert(clear_count == 1);
    clear_error = 0; update_provisioning(50000);
    assert(!wifi_cleanup_pending && network_status.wifi_error == 0 && clear_count == 2);
    provision_requested = true; update_provisioning(50000);
    assert(mode == WIFI_MODE_APSTA && ap_until_ms == 650000);
    update_provisioning(649999); assert(mode == WIFI_MODE_APSTA);
    update_provisioning(650000); assert(mode == WIFI_MODE_STA && ap_until_ms == 0);
    provision_requested = true; update_provisioning(650001);
    assert(mode == WIFI_MODE_APSTA && ap_until_ms == 1250001);
}
`;
    const filename = join(directory, 'provisioning.c');
    const executable = join(directory, 'provisioning');
    writeFileSync(filename, program);
    const compile = spawnSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', filename, '-o', executable],
      { encoding: 'utf8', env: { ...process.env, TMPDIR: directory } });
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    const run = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
