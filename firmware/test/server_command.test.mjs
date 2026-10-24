import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('实际 C 配置命令支持分步配置、空杯设置并保留安全边界', async (t) => {
  const device = readFileSync(new URL('../water_companion/coaster.c', import.meta.url), 'utf8');
  const network = readFileSync(new URL('../water_companion/network.c', import.meta.url), 'utf8');
  function actual(source, signature) {
    const start = source.indexOf(`${signature}(`);
    assert.notEqual(start, -1, signature);
    const end = source.indexOf('\n}', start);
    assert.notEqual(end, -1, signature);
    return source.slice(start, end + 2);
  }
  const root = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
  const firmware = fileURLToPath(new URL('../water_companion/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'server-command-'));
  try {
    // 使用实际配置/状态头文件和完整 C 函数；仅替代 JSON 对象、Flash、锁和网络硬件。
    writeFileSync(join(directory, 'esp_err.h'), '#pragma once\ntypedef int esp_err_t;\nenum { ESP_OK, ESP_ERR_NVS_NOT_FOUND };\n');
    writeFileSync(join(directory, 'esp_wifi.h'), '#pragma once\ntypedef struct { char ssid[33]; } wifi_ap_record_t;\n');
    writeFileSync(join(directory, 'cJSON.h'), `
#pragma once
#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
enum { JSON_NULL, JSON_STRING, JSON_NUMBER, JSON_TRUE, JSON_FALSE, JSON_OBJECT, JSON_ARRAY };
typedef struct cJSON {
    int type;
    char *string, *valuestring;
    double valuedouble;
    struct cJSON *child, *next;
} cJSON;
static char *copy_string(const char *value) {
    char *copy = malloc(strlen(value) + 1); assert(copy); strcpy(copy, value); return copy;
}
static cJSON *json_value(int type) {
    cJSON *value = calloc(1, sizeof(*value)); assert(value); value->type = type; return value;
}
static cJSON *cJSON_CreateObject(void) { return json_value(JSON_OBJECT); }
static cJSON *cJSON_GetObjectItemCaseSensitive(const cJSON *object, const char *name) {
    for (cJSON *item = object ? object->child : NULL; item; item = item->next)
        if (!strcmp(item->string, name)) return item;
    return NULL;
}
static bool cJSON_IsString(const cJSON *value) { return value && value->type == JSON_STRING; }
static bool cJSON_IsNumber(const cJSON *value) { return value && value->type == JSON_NUMBER; }
static bool cJSON_IsTrue(const cJSON *value) { return value && value->type == JSON_TRUE; }
static bool cJSON_IsBool(const cJSON *value) {
    return value && (value->type == JSON_TRUE || value->type == JSON_FALSE);
}
static cJSON *add_value(cJSON *object, const char *name, int type) {
    cJSON *value = json_value(type); value->string = copy_string(name);
    cJSON **slot = &object->child;
    while (*slot) slot = &(*slot)->next;
    *slot = value; return value;
}
static cJSON *cJSON_AddStringToObject(cJSON *object, const char *name, const char *text) {
    cJSON *value = add_value(object, name, JSON_STRING); value->valuestring = copy_string(text); return value;
}
static void cJSON_AddBoolToObject(cJSON *object, const char *name, bool flag) {
    add_value(object, name, flag ? JSON_TRUE : JSON_FALSE);
}
static void cJSON_AddNumberToObject(cJSON *object, const char *name, double number) {
    add_value(object, name, JSON_NUMBER)->valuedouble = number;
}
static void cJSON_AddNullToObject(cJSON *object, const char *name) { add_value(object, name, JSON_NULL); }
static cJSON *cJSON_AddObjectToObject(cJSON *object, const char *name) { return add_value(object, name, JSON_OBJECT); }
static void cJSON_Delete(cJSON *object) {
    if (!object) return;
    cJSON *item = object->child;
    while (item) { cJSON *next = item->next; cJSON_Delete(item); item = next; }
    free(object->string); free(object->valuestring); free(object);
}
`);
    const program = String.raw`
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <arpa/inet.h>
#include "device.h"
#include "storage.h"
#include "network.h"
#define portMAX_DELAY 0
#define SERVER_TIMEOUT_MS 90000
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
static device_config_t config, persisted, settings;
static weighing_t machine;
static int state_lock, lock_depth, writes, save_error;
static unsigned queued, queued_time;
static int32_t raw_samples[WEIGHING_SAMPLES];
static unsigned raw_count;
static unsigned raw_next;
static int64_t last_sample_ms, reboot_at_ms, last_activity_ms;
static bool sensor_ready, unsaved_event, watch, restart_required;
static saved_event_t pending_event;
static float weight = NAN, activity_weight = NAN;
static network_status_t network_status;
static int status_lock;
static int64_t last_confirmed_ms;
static cloud_command_t cloud_command;
static bool wifi_trial;
static char previous_ssid[33], previous_password[65];
static void xSemaphoreTake(int lock, int wait) {
    assert(lock == state_lock && wait == portMAX_DELAY && lock_depth == 0); ++lock_depth;
}
static void xSemaphoreGive(int lock) { assert(lock == state_lock && lock_depth == 1); --lock_depth; }
static int64_t esp_timer_get_time(void) { return 1000000; }
bool network_has_time(void) { return true; }
int64_t network_epoch_ms(void) { return 1800000000000LL; }
void storage_counts(unsigned *pending, unsigned *time_pending) { *pending = queued; *time_pending = queued_time; }
esp_err_t storage_save_config(const device_config_t *next) {
    assert(lock_depth == 1); ++writes;
    if (save_error) return save_error;
    persisted = *next; return ESP_OK;
}
esp_err_t storage_stage_wifi(const char *ssid, const char *password) {
    (void)ssid; (void)password; assert(!"server must not stage Wi-Fi"); return -1;
}
esp_err_t storage_load_command(cloud_command_t *state) { memset(state, 0, sizeof(*state)); return ESP_OK; }
esp_err_t storage_load_wifi(char ssid[33], char password[65]) {
    (void)ssid; (void)password; return ESP_ERR_NVS_NOT_FOUND;
}
static bool provisioning_busy(void) { return false; }
static esp_err_t start_wifi(void) { return ESP_OK; }
static const char *esp_err_to_name(esp_err_t error) { (void)error; return "test error"; }
static void console_println(const char *text) { assert(text); }
${actual(network, 'esp_err_t network_start')}
${actual(network, 'void network_snapshot')}
${actual(device, 'bool device_authorize')}
${actual(device, 'void device_snapshot')}
${actual(device, 'cJSON *device_status_json')}
${actual(device, 'static const char *field')}
${actual(device, 'static bool valid_id')}
${actual(device, 'static bool valid_url')}
${actual(device, 'static bool raw_average')}
${actual(device, 'static cJSON *reply')}
${actual(device, 'cJSON *device_command')}
static const char *new_url = "https://new.example:8443";
static const char *new_id = "coaster-new_2";
static const char *new_token = "new-device-token-0123456789";
static void prepare(bool fresh) {
    memset(&config, 0, sizeof(config)); config.version = CONFIG_VERSION;
    strcpy(config.device_id, "coaster-000000000001");
    if (!fresh) {
        strcpy(config.ssid, "saved-wifi"); strcpy(config.password, "saved-password");
        strcpy(config.server_url, "https://old.example"); strcpy(config.token, "old-device-token-0123456789");
        config.zero_set = config.calibrated = true; config.zero = -12345;
        config.counts_per_gram = -234.5; config.empty_cup = 105.5f;
    }
    persisted = config; writes = save_error = 0; queued = queued_time = 0;
    restart_required = unsaved_event = watch = false; reboot_at_ms = 0;
    memset(&machine, 0, sizeof(machine)); machine.has_baseline = true; machine.baseline = 345.0f;
    memset(&network_status, 0, sizeof(network_status)); wifi_trial = false;
    network_start(&config); assert(lock_depth == 0);
}
static cJSON *command(const char *url, const char *id, const char *token) {
    cJSON *json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "cmd", "server");
    if (url) cJSON_AddStringToObject(json, "url", url);
    if (id) cJSON_AddStringToObject(json, "id", id);
    if (token) cJSON_AddStringToObject(json, "token", token);
    return json;
}
static void run_command(cJSON *json, bool ok) {
    cJSON *response = device_command(json); assert(response && lock_depth == 0);
    const cJSON *result = cJSON_GetObjectItemCaseSensitive(response, "ok");
    assert(cJSON_IsBool(result) && cJSON_IsTrue(result) == ok);
    const char *text = field(response, ok ? "message" : "error"); assert(text && *text);
    assert(!cJSON_GetObjectItemCaseSensitive(response, "token"));
    cJSON_Delete(response); cJSON_Delete(json);
}
static void assert_config(const device_config_t *expected, const device_config_t *value) {
    assert(value->version == expected->version);
    assert(!strcmp(value->server_url, expected->server_url));
    assert(!strcmp(value->device_id, expected->device_id) && !strcmp(value->token, expected->token));
    assert(!strcmp(value->ssid, expected->ssid) && !strcmp(value->password, expected->password));
    assert(value->zero_set == expected->zero_set && value->calibrated == expected->calibrated);
    assert(value->zero == expected->zero && value->counts_per_gram == expected->counts_per_gram);
    assert(value->empty_cup == expected->empty_cup);
}
static void accepted(cJSON *json, const device_config_t *expected) {
    int previous = writes; run_command(json, true);
    assert(writes == previous + 1 && restart_required);
    assert_config(expected, &config); assert_config(expected, &persisted);
    assert(!machine.has_baseline && machine.empty_cup == expected->empty_cup);
}
static void rejected(cJSON *json, int save_attempts) {
    device_config_t before = config, disk_before = persisted;
    weighing_t machine_before = machine;
    bool restart_before = restart_required;
    int previous = writes;
    run_command(json, false);
    assert(writes == previous + save_attempts && restart_required == restart_before);
    assert_config(&before, &config); assert_config(&disk_before, &persisted);
    assert(!memcmp(&machine_before, &machine, sizeof(machine)));
}
static void status_is(bool configured, const char *url, bool restart) {
    cJSON *request = cJSON_CreateObject(); cJSON_AddStringToObject(request, "cmd", "status");
    cJSON *response = device_command(request); assert(response);
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(response, "serverConfigured")) == configured);
    assert(!strcmp(field(response, "cloudUrl"), url));
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(response, "restartRequired")) == restart);
    assert(!strcmp(field(response, "firmwareVersion"), FIRMWARE_VERSION));
    assert(!cJSON_GetObjectItemCaseSensitive(response, "token"));
    cJSON_Delete(response); cJSON_Delete(request); assert(lock_depth == 0);
}
static void full_config(void) {
    prepare(false); device_config_t expected = config;
    strcpy(expected.server_url, new_url); strcpy(expected.device_id, new_id); strcpy(expected.token, new_token);
    accepted(command("https://new.example:8443/", new_id, new_token), &expected);
    assert(device_authorize(new_id, "Bearer new-device-token-0123456789"));
    assert(!device_authorize("coaster-000000000001", "Bearer old-device-token-0123456789"));
    status_is(true, "https://old.example", true);
}
static void url_only(void) {
    prepare(false); device_config_t expected = config;
    strcpy(expected.server_url, "http://192.168.1.42:8787");
    accepted(command("http://192.168.1.42:8787/", NULL, NULL), &expected);
    assert(device_authorize(expected.device_id, "Bearer old-device-token-0123456789"));
    accepted(command("http://192.168.1.42:8787", NULL, NULL), &expected);
}
static void identity_only(void) {
    prepare(false); device_config_t expected = config;
    strcpy(expected.device_id, new_id); strcpy(expected.token, new_token);
    accepted(command(NULL, new_id, new_token), &expected);
    accepted(command(NULL, new_id, new_token), &expected);
    assert(device_authorize(new_id, "Bearer new-device-token-0123456789"));
}
static void fresh_config(void) {
    prepare(true); status_is(false, "", false);
    device_config_t expected = config;
    strcpy(expected.device_id, new_id); strcpy(expected.token, new_token);
    accepted(command(NULL, new_id, new_token), &expected);
    network_start(&persisted); restart_required = false;
    status_is(false, "", false);
    assert(device_authorize(new_id, "Bearer new-device-token-0123456789"));
    strcpy(expected.server_url, new_url);
    accepted(command(new_url, NULL, NULL), &expected);
    network_start(&persisted); restart_required = false; status_is(true, new_url, false);
    prepare(true); expected = config; strcpy(expected.server_url, new_url);
    accepted(command(new_url, NULL, NULL), &expected);
    network_start(&persisted); restart_required = false; status_is(false, new_url, false);
    strcpy(expected.device_id, new_id); strcpy(expected.token, new_token);
    accepted(command(NULL, new_id, new_token), &expected);
    network_start(&persisted); restart_required = false; status_is(true, new_url, false);
}
static void invalid_fields(void) {
    prepare(false);
    rejected(command(NULL, NULL, NULL), 0);
    rejected(command(NULL, new_id, NULL), 0); rejected(command(NULL, NULL, new_token), 0);
    rejected(command(new_url, new_id, NULL), 0); rejected(command(new_url, NULL, new_token), 0);
    rejected(command("", NULL, NULL), 0); rejected(command("", new_id, new_token), 0);
    rejected(command(NULL, "", new_token), 0); rejected(command(NULL, new_id, ""), 0);
    rejected(command(new_url, "", new_token), 0); rejected(command(new_url, new_id, ""), 0);
    const int types[] = { JSON_NULL, JSON_NUMBER, JSON_TRUE, JSON_FALSE, JSON_OBJECT, JSON_ARRAY };
    const char *fields[] = { "url", "id", "token" };
    for (unsigned f = 0; f < 3; ++f) {
        for (unsigned i = 0; i < sizeof(types) / sizeof(types[0]); ++i) {
            cJSON *json = command(f == 0 ? NULL : new_url, f == 1 ? NULL : new_id, f == 2 ? NULL : new_token);
            add_value(json, fields[f], types[i]); rejected(json, 0);
            json = command(NULL, f == 1 ? NULL : (f == 2 ? new_id : NULL), f == 1 ? new_token : NULL);
            add_value(json, fields[f], types[i]); rejected(json, 0);
        }
    }
    const char *bad_ids[] = { "has space", "../id", "coaster.id", "设备编号" };
    for (unsigned i = 0; i < sizeof(bad_ids) / sizeof(bad_ids[0]); ++i)
        rejected(command(NULL, bad_ids[i], new_token), 0);
    const char *bad_tokens[] = { "short", "123456789012345", "token with spaces!", "123456789012345\n", "凭证凭证凭证" };
    for (unsigned i = 0; i < sizeof(bad_tokens) / sizeof(bad_tokens[0]); ++i)
        rejected(command(new_url, new_id, bad_tokens[i]), 0);
    char id[66], token[130], url[193];
    memset(id, 'a', sizeof(id)); id[sizeof(id) - 1] = 0;
    memset(token, 't', sizeof(token)); token[sizeof(token) - 1] = 0;
    memset(url, 'a', sizeof(url)); memcpy(url, "https://", 8); url[sizeof(url) - 1] = 0;
    rejected(command(NULL, id, new_token), 0); rejected(command(NULL, new_id, token), 0);
    rejected(command(url, NULL, NULL), 0);
    restart_required = true; rejected(command(NULL, NULL, NULL), 0);
    prepare(true); rejected(command(NULL, "", new_token), 0); rejected(command("", new_id, new_token), 0);
}
static void url_boundaries(void) {
    const char *good[] = { "https://coaster.example", "https://coaster.example:443/", "https://192.168.1.2",
        "http://10.0.0.1", "http://10.255.255.254:65535", "http://172.16.0.1:1", "http://172.31.255.254",
        "http://192.168.0.1", "http://192.168.255.254:8787/" };
    for (unsigned i = 0; i < sizeof(good) / sizeof(good[0]); ++i) {
        prepare(false); device_config_t expected = config; strcpy(expected.server_url, good[i]);
        size_t length = strlen(expected.server_url);
        if (expected.server_url[length - 1] == '/') expected.server_url[length - 1] = 0;
        accepted(command(good[i], NULL, NULL), &expected);
    }
    const char *bad[] = { "http://8.8.8.8", "http://coaster.example", "http://localhost", "http://LOCALHOST:8787",
        "http://127.0.0.1", "http://127.10.20.30", "http://[::1]", "http://0.0.0.0", "http://169.254.1.1",
        "http://172.15.255.255", "http://172.32.0.1", "http://192.169.0.1", "http://100.64.0.1", "http://192.168.1.999",
        "https://coaster.example/path", "http://192.168.1.1/api", "https://coaster.example?query", "https://coaster.example#part",
        "https://user@coaster.example", "https://", "https://coaster.example:0", "https://coaster.example:65536",
        "https://coaster.example:", "https://coaster.example:abc", "https://coaster.example//", "ftp://coaster.example",
        "coaster.example", " https://coaster.example", "https://bad host", "http://192.168.1.1:8787?x" };
    prepare(false);
    for (unsigned i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) {
        rejected(command(bad[i], NULL, NULL), 0);
        rejected(command(bad[i], new_id, new_token), 0);
    }
    char id[65], token[129];
    memset(id, 'a', sizeof(id)); id[sizeof(id) - 1] = 0;
    memset(token, 't', sizeof(token)); token[sizeof(token) - 1] = 0;
    device_config_t expected = config; strcpy(expected.device_id, id); strcpy(expected.token, token);
    accepted(command(NULL, id, token), &expected);
    strcpy(expected.token, "1234567890123456"); accepted(command(NULL, id, expected.token), &expected);
}
static void save_failure(void) {
    for (int fresh = 0; fresh <= 1; ++fresh) {
        for (int restart = 0; restart <= 1; ++restart) {
            prepare(fresh); save_error = -1; restart_required = restart;
            rejected(command(new_url, new_id, new_token), 1);
            rejected(command(new_url, NULL, NULL), 1);
            rejected(command(NULL, new_id, new_token), 1);
            save_error = 0; device_config_t expected = config;
            strcpy(expected.server_url, new_url); accepted(command(new_url, NULL, NULL), &expected);
        }
    }
}
static void pending_protection(void) {
    for (int time_pending = 0; time_pending <= 1; ++time_pending) {
        prepare(false); queued = 2; queued_time = time_pending ? 2 : 0;
        rejected(command(NULL, new_id, new_token), 0);
        rejected(command(new_url, new_id, new_token), 0);
        device_config_t expected = config; strcpy(expected.server_url, new_url);
        accepted(command(new_url, NULL, NULL), &expected);
        strcpy(expected.token, new_token);
        accepted(command(NULL, expected.device_id, new_token), &expected);
        accepted(command(new_url, expected.device_id, new_token), &expected);
    }
    prepare(false); unsaved_event = true;
    rejected(command(new_url, NULL, NULL), 0); rejected(command(NULL, new_id, new_token), 0);
    unsaved_event = false; reboot_at_ms = 2000;
    rejected(command(new_url, NULL, NULL), 0); rejected(command(NULL, new_id, new_token), 0);
}
static void cup_config(void) {
    prepare(false);
    config.counts_per_gram = -100;
    sensor_ready = true; raw_count = WEIGHING_SAMPLES; last_sample_ms = 1000;
    for (unsigned i = 0; i < WEIGHING_SAMPLES; ++i) raw_samples[i] = config.zero - 12000;
    machine.removed = true;
    for (int failure = 1; failure >= 0; --failure) {
        cJSON *json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "cmd", "cup");
        save_error = failure ? -1 : 0;
        if (failure) rejected(json, 1);
        else run_command(json, true);
    }
    assert(config.empty_cup == 120 && persisted.empty_cup == 120 && !restart_required);
    unsigned events = 0;
    for (unsigned i = 0; i < 60; ++i) {
        weight_change_t change;
        if (weighing_sample(&machine, 320, 1000 + i * 100, &change)) {
            ++events;
            assert(!change.drink && change.amount == 200 && change.before == 120 && change.after == 320);
        }
    }
    assert(events == 1);
}
int main(int argc, char **argv) {
    assert(argc == 2);
    if (!strcmp(argv[1], "full")) full_config();
    else if (!strcmp(argv[1], "url")) url_only();
    else if (!strcmp(argv[1], "identity")) identity_only();
    else if (!strcmp(argv[1], "fresh")) fresh_config();
    else if (!strcmp(argv[1], "invalid")) invalid_fields();
    else if (!strcmp(argv[1], "boundaries")) url_boundaries();
    else if (!strcmp(argv[1], "save-failure")) save_failure();
    else if (!strcmp(argv[1], "pending")) pending_protection();
    else if (!strcmp(argv[1], "cup")) cup_config();
    else assert(!"unknown test");
    return 0;
}
`;
    const filename = join(directory, 'server-command.c');
    const executable = join(directory, 'server-command');
    writeFileSync(filename, program);
    const compile = spawnSync(process.env.CC || 'cc', [
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', directory, '-I', firmware,
      filename, join(firmware, 'weighing.c'), '-lm', '-o', executable,
    ], { encoding: 'utf8', env: { ...process.env, TMPDIR: directory } });
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    const cases = [
      ['full', '旧完整配置兼容、尾斜杠规范化及重启状态'],
      ['url', '仅 URL 更新保留身份、Wi-Fi、标定和空杯配置'],
      ['identity', '仅身份更新保留 URL，重复登记仍有效'],
      ['fresh', '新机无 URL 登记、两种配置顺序及真实 status'],
      ['invalid', '不完整、空、null、错误类型和越界字段均不写入'],
      ['boundaries', 'HTTPS 源地址及私网 HTTP 接受，公网 HTTP 与坏地址拒绝'],
      ['save-failure', '保存失败保留内存、持久配置、称重和重启状态'],
      ['pending', 'pending 禁止改 ID，允许同 ID 更新及仅 URL 更新'],
      ['cup', '空杯保存失败保留旧基准，成功后立即加水只记一次补水'],
    ];
    for (const [name, description] of cases) {
      await t.test(description, () => {
        const run = spawnSync(executable, [name], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.error?.message || run.stderr);
      });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
