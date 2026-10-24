import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const firmware = fileURLToPath(new URL('../water_companion/', import.meta.url));
const network = readFileSync(join(firmware, 'network.c'), 'utf8');
const oldTest = readFileSync(new URL('./server_command.test.mjs', import.meta.url), 'utf8');
const jsonShim = oldTest.split("writeFileSync(join(directory, 'cJSON.h'), `")[1].split('`);')[0]
  + '\nstatic bool cJSON_IsObject(const cJSON *j) { return j && j->type == JSON_OBJECT; }\n'
  + 'static bool cJSON_IsNull(const cJSON *j) { return j && j->type == JSON_NULL; }\n';
const actual = signature => {
  const start = network.indexOf(`${signature}(`);
  assert.notEqual(start, -1);
  return network.slice(start, network.indexOf('\n}', start) + 2);
};
const structure = (file, name) => readFileSync(join(firmware, file), 'utf8')
  .match(new RegExp(`typedef struct \\{[\\s\\S]*?\\} ${name};`))[0];

function run(source) {
  const dir = mkdtempSync(join(tmpdir(), 'coaster-summary-'));
  try {
    writeFileSync(join(dir, 'cJSON.h'), jsonShim);
    writeFileSync(join(dir, 'test.c'), source);
    const compiled = spawnSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror',
      '-Wno-unused-function', '-I', dir, '-I', firmware, join(dir, 'test.c'),
      join(firmware, 'daily_summary.c'), '-lm', '-o', join(dir, 'test')], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(join(dir, 'test'), [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const fixtures = `
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "daily_summary.h"
static const int64_t epoch = ${Date.parse('2026-10-24T02:00:00Z')}LL;
static const char *owner = "11111111-1111-4111-8111-111111111111";
static const char *other = "22222222-2222-4222-8222-222222222222";
static cJSON *sample(void) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "date", "2026-10-24");
    cJSON_AddNumberToObject(j, "expiresAtMs", epoch + 14 * 3600000);
    cJSON_AddNumberToObject(j, "drinkMl", 1280.5);
    cJSON_AddNumberToObject(j, "drinkCount", 6);
    cJSON *last = cJSON_AddObjectToObject(j, "lastDrink");
    cJSON_AddNumberToObject(last, "amountMl", 120.5);
    cJSON_AddNumberToObject(last, "occurredAtMs", epoch - 25 * 60000);
    return j;
}
`;

test('真实摘要解析及缓存：保留精度、缺字段兼容、跨日/重启/换绑失效', () => {
  run(`${fixtures}
int main(void) {
    daily_summary_t cached, result;
    cJSON *j = sample();
    daily_summary_parse(&cached, j, owner, epoch, 1000);
    assert(cached.received && cached.valid && cached.synced);
    assert(cached.drink_ml == 1280.5 && cached.drink_count == 6 && cached.last_drink_ml == 120.5);
    daily_summary_read(&cached, &result, owner, 61000);
    assert(result.valid && result.server_time_ms == epoch + 60000);
    assert(cached.server_time_ms == epoch);
    daily_summary_read(&cached, &result, owner, 1000 + 14 * 3600000 - 1);
    assert(result.valid);
    daily_summary_read(&cached, &result, owner, 1000 + 14 * 3600000);
    assert(!result.valid && !result.received);
    daily_summary_read(&cached, &result, other, 1000);
    assert(!result.valid && !result.received);
    daily_summary_read(&cached, &result, "", 1000); assert(!result.valid);
    daily_summary_read(&cached, &result, owner, 0); assert(!result.valid);
    daily_summary_parse(&cached, NULL, owner, epoch, 1000);
    daily_summary_read(&cached, &result, owner, 2000);
    assert(result.received && !result.valid);
    cJSON_GetObjectItemCaseSensitive(j, "drinkCount")->valuedouble = -1;
    daily_summary_parse(&cached, j, owner, epoch, 1000); assert(!cached.valid);
    cJSON_GetObjectItemCaseSensitive(j, "drinkCount")->valuedouble = 6.5;
    daily_summary_parse(&cached, j, owner, epoch, 1000); assert(!cached.valid);
    cJSON_GetObjectItemCaseSensitive(j, "drinkCount")->valuedouble = 6;
    cJSON_GetObjectItemCaseSensitive(j, "drinkMl")->valuedouble = NAN;
    daily_summary_parse(&cached, j, owner, epoch, 1000); assert(!cached.valid);
    cJSON_GetObjectItemCaseSensitive(j, "drinkMl")->valuedouble = 1280.5;
    cJSON_GetObjectItemCaseSensitive(j, "expiresAtMs")->valuedouble = epoch;
    daily_summary_parse(&cached, j, owner, epoch, 1000); assert(!cached.valid);
    cJSON_GetObjectItemCaseSensitive(j, "expiresAtMs")->valuedouble = epoch + 86400000;
    cJSON_GetObjectItemCaseSensitive(j, "drinkCount")->valuedouble = 0;
    cJSON_GetObjectItemCaseSensitive(j, "drinkMl")->valuedouble = 0;
    cJSON_GetObjectItemCaseSensitive(j, "lastDrink")->type = JSON_NULL;
    daily_summary_parse(&cached, j, owner, epoch, 1000);
    assert(cached.valid && !cached.drink_count && !cached.last_drink_at_ms);
    daily_summary_parse(&cached, j, owner, 0, 1000); assert(!cached.valid);
    cJSON_Delete(j);
}
`);
});

test('真实心跳只接纳当前连接/绑定摘要，网络失败保留缓存，重配清除缓存', () => {
  run(`${fixtures}
typedef int esp_err_t;
enum { ESP_OK, ESP_ERR_INVALID_RESPONSE, ESP_FAIL };
#define FIRMWARE_VERSION "test"
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
#define ESP_LOGW(...) ((void)0)
${structure('network.h', 'network_status_t')}
${structure('device.h', 'device_status_t')}
typedef struct { char binding_id[37]; } binding_state_t;
typedef struct { char ssid[33], server_url[192], token[129]; } device_config_t;
typedef struct { bool pending, ok; char id[37], binding_id[37], message[96]; } cloud_command_t;
static network_status_t network_status;
static daily_summary_t daily_summary;
static device_config_t settings;
static binding_state_t local_binding;
static cloud_command_t cloud_command;
static uint32_t connection_generation;
static int status_lock, transport_error, commit_error, commands;
static bool binding_requested, binding_attempted, busy, stale;
static int64_t last_confirmed_ms, uptime = 1000;
static cJSON *reply_body;
static int64_t esp_timer_get_time(void) { return uptime * 1000; }
static bool network_has_time(void) { return true; }
static bool network_set_time(int64_t time) { (void)time; return true; }
static bool provisioning_busy(void) { return busy; }
static bool provision_uuid(const char *s) { return strlen(s) == 36; }
static void device_snapshot(device_status_t *s) { memset(s, 0, sizeof(*s)); }
static void storage_counts(unsigned *pending, unsigned *time) { *pending = *time = 0; }
static void device_config_snapshot(device_config_t *config, binding_state_t *binding) {
    if (config) *config = settings;
    if (binding) *binding = local_binding;
}
static esp_err_t storage_save_command(const cloud_command_t *command) { (void)command; return 0; }
static void cloud_command_ack(cloud_command_t *command, esp_err_t (*save)(const cloud_command_t *)) { (void)command; (void)save; }
static esp_err_t device_change_binding(const char *id) {
    if (commit_error) return commit_error;
    strcpy(local_binding.binding_id, id); return ESP_OK;
}
static void receive_command(const cJSON *j) { (void)j; ++commands; }
static const char *esp_err_to_name(esp_err_t error) { (void)error; return "error"; }
static esp_err_t post(const char *path, const cJSON *body, cJSON **reply, int *status) {
    (void)body; assert(!strcmp(path, "/api/device/heartbeat"));
    *reply = reply_body; reply_body = NULL; *status = transport_error ? 503 : 200;
    if (stale) ++connection_generation;
    return transport_error;
}
${actual('void network_daily_summary')}
${actual('void network_apply_config')}
${actual('static bool heartbeat')}
static void response(const char *id, bool summary) {
    reply_body = cJSON_CreateObject();
    cJSON_AddBoolToObject(reply_body, "ok", true);
    cJSON_AddBoolToObject(reply_body, "bound", id[0]);
    cJSON_AddNumberToObject(reply_body, "serverTimeMs", epoch);
    if (id[0]) cJSON_AddStringToObject(reply_body, "bindingId", id);
    else cJSON_AddNullToObject(reply_body, "bindingId");
    if (summary) {
        cJSON *item = sample(); item->string = copy_string("dailySummary");
        item->next = reply_body->child; reply_body->child = item;
    }
}
int main(void) {
    daily_summary_t shown;
    network_status.wifi_connected = true;
    strcpy(local_binding.binding_id, owner);
    response(owner, true); assert(heartbeat());
    network_daily_summary(&shown, owner); assert(shown.valid && shown.drink_ml == 1280.5);
    transport_error = ESP_FAIL; response(owner, true); assert(!heartbeat());
    network_daily_summary(&shown, owner); assert(shown.valid && !network_status.server_connected);
    transport_error = ESP_OK;
    stale = true; response(other, true); heartbeat();
    assert(!strcmp(local_binding.binding_id, owner));
    network_daily_summary(&shown, owner); assert(shown.valid);
    stale = false; busy = true; response(other, true); heartbeat();
    assert(!strcmp(local_binding.binding_id, owner)); busy = false;
    commit_error = ESP_FAIL; response(other, true); heartbeat();
    assert(!strcmp(local_binding.binding_id, owner));
    network_daily_summary(&shown, owner); assert(!shown.valid);
    commit_error = ESP_OK;
    response(other, true); heartbeat();
    assert(!strcmp(local_binding.binding_id, other));
    network_daily_summary(&shown, other); assert(!shown.valid && !shown.received);
    response(other, true); heartbeat();
    network_daily_summary(&shown, other); assert(shown.valid);
    response(other, false); heartbeat();
    network_daily_summary(&shown, other); assert(shown.received && !shown.valid);
    response(other, true); heartbeat();
    network_apply_config(&settings);
    network_daily_summary(&shown, other); assert(!shown.valid && !shown.received);
    response("", false); heartbeat(); assert(!local_binding.binding_id[0]);
    network_daily_summary(&shown, ""); assert(!shown.valid);
    assert(commands > 0);
}
`);
});
