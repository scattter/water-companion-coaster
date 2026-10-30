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
static bool cJSON_IsObject(const cJSON *value) { return value && value->type == JSON_OBJECT; }
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
static cJSON *cJSON_AddArrayToObject(cJSON *object, const char *name) { return add_value(object, name, JSON_ARRAY); }
static void cJSON_AddItemToArray(cJSON *array, cJSON *item) {
    cJSON **slot = &array->child; while (*slot) slot = &(*slot)->next; *slot = item;
}
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
#include <setjmp.h>
#include "device.h"
#include "storage.h"
#include "network.h"
#define portMAX_DELAY 0
#define SERVER_TIMEOUT_MS 90000
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
static device_config_t config, persisted, settings;
static cup_config_t cups, persisted_cups;
static cup_setup_t cup_setup;
static binding_state_t binding;
static int64_t empty_since_ms = -1, cup_notice_until, now = 1000;
static char cup_notice[96];
static weighing_t machine;
static int state_lock, lock_depth, writes, save_error, config_error;
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
static int64_t esp_timer_get_time(void) { return now * 1000; }
bool network_has_time(void) { return true; }
int64_t network_epoch_ms(void) { return 1800000000000LL; }
void storage_counts(unsigned *pending, unsigned *time_pending) { *pending = queued; *time_pending = queued_time; }
esp_err_t storage_save_config(const device_config_t *next) {
    assert(lock_depth == 1); ++writes;
    if (save_error) return save_error;
    if (config_error) return config_error;
    persisted = *next; return ESP_OK;
}
esp_err_t storage_save_cups(const cup_config_t *next) {
    assert(lock_depth == 1); ++writes;
    if (save_error) return save_error;
    assert(cups_valid(next)); persisted_cups = *next; return ESP_OK;
}
esp_err_t storage_load_cups(cup_config_t *value) { *value = persisted_cups; return ESP_OK; }
esp_err_t storage_stage_wifi(const char *ssid, const char *password) {
    (void)ssid; (void)password; assert(!"server must not stage Wi-Fi"); return -1;
}
esp_err_t storage_load_command(cloud_command_t *state) { memset(state, 0, sizeof(*state)); return ESP_OK; }
esp_err_t storage_save_command(const cloud_command_t *state) { (void)state; return ESP_OK; }
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
${actual(device, 'static void finish_cup_setup')}
${actual(device, 'static void cup_message')}
${actual(device, 'void device_snapshot')}
${actual(device, 'void device_cups_json')}
${actual(device, 'cJSON *device_status_json')}
${actual(device, 'static const char *field')}
${actual(device, 'static bool valid_id')}
${actual(device, 'static bool valid_url')}
${actual(device, 'static bool raw_average')}
${actual(device, 'static cJSON *reply')}
${actual(device, 'static const char *cup_available')}
${actual(device, 'static bool cup_removed')}
${actual(device, 'static const char *save_cups')}
${actual(device, 'static const char *select_cup')}
${actual(device, 'void device_next_cup')}
${actual(device, 'static cJSON *cup_command')}
${actual(device, 'cJSON *device_command')}
${actual(device, 'void device_config_snapshot')}
${actual(device, 'static esp_err_t load_cups')}
static const cJSON *received_cup_command;
${actual(network, 'static void execute_cup')}
${actual(network, 'static void receive_command')}
typedef int TickType_t;
#define pdMS_TO_TICKS(ms) (ms)
static int xTaskGetTickCount(void) { return 0; }
static jmp_buf sample_done;
static unsigned remaining, sample_events;
static float sample_weight;
static weight_change_t last_change;
static esp_err_t hx711_read(int32_t *raw, int timeout) {
    (void)timeout; now += 100;
    *raw = config.zero + (int32_t)lround(sample_weight * config.counts_per_gram); return ESP_OK;
}
static void vTaskDelayUntil(TickType_t *tick, int delay) {
    (void)tick; (void)delay; if (!--remaining) longjmp(sample_done, 1);
}
static void print_json(cJSON *json) { cJSON_Delete(json); }
esp_err_t storage_append(const saved_event_t *event) { (void)event; return ESP_OK; }
static void create_event(const weight_change_t *change, int64_t uptime) {
    (void)uptime; ++sample_events; last_change = *change;
}
${actual(device, 'static void update_activity')}
${actual(device, 'static void sample_task')}
static void samples(float grams, unsigned count) {
    sample_weight = grams; remaining = count;
    if (!setjmp(sample_done)) sample_task(NULL);
}
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
    persisted = config; writes = save_error = config_error = 0; queued = queued_time = 0;
    now = 1000; sample_events = 0; sensor_ready = true; last_sample_ms = now; weight = 0;
    empty_since_ms = 0; memset(&cup_setup, 0, sizeof(cup_setup));
    cups_init(&cups, "33333333-3333-4333-8333-333333333333", config.empty_cup);
    strcpy(binding.binding_id, cups.binding_id);
    persisted_cups = cups;
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
    assert(config.empty_cup == 120 && cups_weight(&persisted_cups) == 120 && !restart_required);
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
static const char *setup_id = "11111111-1111-4111-8111-111111111111";
static cJSON *cup_action(const char *action, unsigned id, const char *name, const char *setup) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "cmd", "cup"); cJSON_AddStringToObject(json, "action", action);
    cJSON_AddStringToObject(json, "id", setup_id);
    if (id) cJSON_AddNumberToObject(json, "cupId", id);
    if (name) cJSON_AddStringToObject(json, "name", name);
    if (setup) cJSON_AddStringToObject(json, "setupId", setup);
    return json;
}
static cJSON *manual_cup(unsigned id, const char *name, double grams) {
    cJSON *json = cup_action("manual", id, name, NULL);
    cJSON_AddNumberToObject(json, "emptyCupGrams", grams);
    return json;
}
static void manual_cups(void) {
    prepare(false);
    cup_config_t original = cups;
    raw_count = 0;
    save_error = -1;
    rejected(manual_cup(2, "水瓶", 25), 1);
    assert(!memcmp(&cups, &original, sizeof(cups)) && !memcmp(&persisted_cups, &original, sizeof(cups)));
    save_error = 0;
    run_command(manual_cup(2, "水瓶", 25), true);
    assert(cups.active_id == 2 && config.empty_cup == 25 && cups_weight(&persisted_cups) == 25);
    assert(!strcmp(cups.items[1].name, "水瓶") && !machine.has_baseline && !cup_setup.id[0]);
    assert(!memcmp(&cups.items[0], &original.items[0], sizeof(cup_t)));
    samples(525, 40);
    assert(sample_events == 0 && machine.has_baseline && machine.baseline == 525);
    samples(0, 10); samples(475, 40);
    assert(sample_events == 1 && last_change.drink && last_change.amount == 50);
    samples(525, 40);
    assert(sample_events == 2 && !last_change.drink && last_change.amount == 50);
    samples(0, 10);
    run_command(manual_cup(2, "水瓶", 30.06), true);
    assert(cups.active_id == 2 && config.empty_cup == 30.1f && !machine.has_baseline);
    samples(475, 40); assert(sample_events == 2 && machine.baseline == 475);
    memset(&cups, 0, sizeof(cups)); config.empty_cup = 999;
    assert(load_cups() == ESP_OK && cups.active_id == 2 && config.empty_cup == 30.1f);
    assert(!strcmp(cups.items[1].name, "水瓶"));
    weighing_init(&machine, config.empty_cup);
    samples(475, 40); assert(sample_events == 2 && machine.baseline == 475);
    samples(0, 10);
    run_command(manual_cup(1, "默认杯", 120), true);
    assert(cups.active_id == 1 && config.empty_cup == 120 && cups.items[1].empty_cup == 30.1f);
    samples(525, 40); assert(sample_events == 2);
}
static void manual_limits(void) {
    prepare(false);
    cup_config_t original = cups;
    const double bad[] = { -1, 0, 4.99, 1995.01, NAN, INFINITY, -INFINITY };
    for (unsigned i = 0; i < sizeof(bad) / sizeof(*bad); ++i)
        rejected(manual_cup(1, "默认杯", bad[i]), 0);
    rejected(cup_action("manual", 1, "默认杯", NULL), 0);
    cJSON *json = cup_action("manual", 1, "默认杯", NULL);
    cJSON_AddStringToObject(json, "emptyCupGrams", "25"); rejected(json, 0);
    json = cup_action("manual", 1, "默认杯", NULL);
    cJSON_AddNullToObject(json, "emptyCupGrams"); rejected(json, 0);
    rejected(manual_cup(0, "水瓶", 25), 0); rejected(manual_cup(4, "水瓶", 25), 0);
    json = manual_cup(1, "默认杯", 25);
    cJSON_GetObjectItemCaseSensitive(json, "cupId")->valuedouble = 1.5; rejected(json, 0);
    const char *names[] = { NULL, "", "123456", "水 瓶", "瓶!", "😀" };
    for (unsigned i = 0; i < sizeof(names) / sizeof(*names); ++i)
        rejected(manual_cup(2, names[i], 25), 0);
    rejected(manual_cup(1, "改名了", 25), 0);
    config.calibrated = false; rejected(manual_cup(2, "水瓶", 25), 0); config.calibrated = true;
    sensor_ready = false; rejected(manual_cup(2, "水瓶", 25), 0); sensor_ready = true;
    unsaved_event = true; rejected(manual_cup(2, "水瓶", 25), 0); unsaved_event = false;
    restart_required = true; rejected(manual_cup(2, "水瓶", 25), 0); restart_required = false;
    now += 351; rejected(manual_cup(2, "水瓶", 25), 0); last_sample_ms = now;
    assert(!memcmp(&cups, &original, sizeof(cups)) && !memcmp(&persisted_cups, &original, sizeof(cups)));
    run_command(cup_action("prepare", 2, "水瓶", NULL), true);
    rejected(manual_cup(2, "水瓶", 25), 0);
    run_command(cup_action("cancel", 0, NULL, setup_id), true);
    samples(525, 40); rejected(manual_cup(2, "水瓶", 25), 0);
    samples(0, 5); rejected(manual_cup(2, "水瓶", 25), 0);
    samples(0, 1); run_command(manual_cup(2, "水瓶", 25), true);
    const double valid[] = { 5, 1995, 25.05 };
    for (unsigned i = 0; i < sizeof(valid) / sizeof(*valid); ++i) {
        run_command(manual_cup(2, "水瓶", valid[i]), true);
        assert(config.empty_cup == (float)(round(valid[i] * 10) / 10));
        assert(cups_valid(&cups) && cups_valid(&persisted_cups));
    }
}
static void cloud_manual_cup(void) {
    prepare(false);
    cJSON *response = cJSON_CreateObject();
    cJSON *payload = cJSON_AddObjectToObject(response, "command");
    cJSON_AddStringToObject(payload, "cmd", "cup"); cJSON_AddStringToObject(payload, "id", setup_id);
    cJSON_AddStringToObject(payload, "bindingId", binding.binding_id);
    cJSON_AddNumberToObject(payload, "expiresAt", network_epoch_ms() + 120000);
    cJSON_AddStringToObject(payload, "action", "manual");
    cJSON_AddNumberToObject(payload, "cupId", 2); cJSON_AddStringToObject(payload, "name", "水瓶");
    cJSON_AddNumberToObject(payload, "emptyCupGrams", 25);
    receive_command(response);
    assert(cloud_command.pending && cloud_command.ok && cups.active_id == 2 && config.empty_cup == 25);
    samples(525, 40); assert(sample_events == 0 && machine.baseline == 525);
    unsigned previous = writes;
    cJSON_GetObjectItemCaseSensitive(payload, "emptyCupGrams")->valuedouble = 55;
    receive_command(response);
    assert(writes == (int)previous && config.empty_cup == 25 && machine.baseline == 525);
    assert(cloud_command_ack(&cloud_command, storage_save_command));
    receive_command(response);
    assert(writes == (int)previous && !cloud_command.pending && machine.baseline == 525);
    samples(0, 10); samples(475, 40);
    assert(sample_events == 1 && last_change.drink && last_change.amount == 50);
    cJSON_Delete(response);
}
static void multi_cups(void) {
    prepare(false);
    run_command(cup_action("prepare", 2, "保温杯A1", NULL), true);
    samples(120, 29); run_command(cup_action("save", 0, NULL, setup_id), false);
    samples(120, 11); assert(sample_events == 0);
    device_next_cup(); assert(cups.active_id == 1 && cup_setup.id[0]);
    run_command(cup_action("save", 0, NULL, "22222222-2222-4222-8222-222222222222"), false);
    save_error = -1;
    run_command(cup_action("save", 0, NULL, setup_id), false);
    assert(cups.active_id == 1 && cup_setup.id[0]); save_error = 0;
    run_command(cup_action("save", 0, NULL, setup_id), true);
    assert(cups.active_id == 2 && !cup_setup.id[0] && cups_weight(&cups) == 120);
    samples(320, 40); assert(sample_events == 1 && !last_change.drink && last_change.amount == 200);
    run_command(cup_action("select", 1, NULL, NULL), false);
    samples(0, 5); run_command(cup_action("select", 1, NULL, NULL), false);
    samples(0, 1); device_next_cup(); assert(cups.active_id == 1);
    samples(205.5, 40); assert(sample_events == 1);
    run_command(cup_action("rename", 1, "办公杯", NULL), true);
    assert(machine.has_baseline && machine.baseline == 205.5f);
    samples(0, 10); samples(185.5, 40);
    assert(sample_events == 2 && last_change.drink && last_change.amount == 20);
    run_command(cup_action("delete", 1, NULL, NULL), false);
    run_command(cup_action("delete", 2, NULL, NULL), true);
    assert(cups.active_id == 1 && machine.has_baseline);
    samples(0, 10); run_command(cup_action("delete", 1, NULL, NULL), true);
    assert(cups.active_id == 0 && config.empty_cup == 0 && !machine.has_baseline);
    assert(cups_valid(&persisted_cups));
}
static void cup_cancel(void) {
    prepare(false); run_command(cup_action("prepare", 2, "新杯子", NULL), true);
    samples(250, 40); assert(sample_events == 0);
    run_command(cup_action("cancel", 0, NULL, setup_id), true);
    samples(250, 40); assert(sample_events == 0 && cups.active_id == 1);
    samples(0, 10); run_command(cup_action("prepare", 2, "新杯子", NULL), true);
    samples(220, 40); now += CUP_SETUP_MS;
    samples(220, 40); assert(!cup_setup.id[0] && sample_events == 0);
    run_command(cup_action("save", 0, NULL, setup_id), false);
    samples(0, 10); cup_config_t before = cups;
    const char *bad[] = {"", "123456", "杯!", "水 杯", "😀", "杯\\n"};
    for (unsigned i = 0; i < sizeof(bad) / sizeof(*bad); ++i)
        run_command(cup_action("rename", 1, bad[i], NULL), false);
    assert(!memcmp(&before, &cups, sizeof(cups)));
}
static void cup_cycle(void) {
    prepare(false);
    strcpy(cups.items[1].name, "同名杯"); cups.items[1].empty_cup = 180;
    strcpy(cups.items[2].name, "同名杯"); cups.items[2].empty_cup = 240;
    const unsigned expected[] = {2, 3, 1};
    for (unsigned i = 0; i < 3; ++i) {
        device_next_cup();
        assert(cups.active_id == expected[i] && persisted_cups.active_id == expected[i]);
        assert(!machine.has_baseline && config.empty_cup == cups_weight(&cups));
    }
    samples(0, 10); samples(305.5, 40);
    assert(sample_events == 0 && machine.has_baseline);
    device_next_cup(); assert(cups.active_id == 1 && machine.has_baseline);
    samples(0, 10);
    unsaved_event = true; device_next_cup();
    assert(cups.active_id == 1 && !strcmp(cup_notice, "记录尚未保存"));
    unsaved_event = false; sensor_ready = false;
    device_next_cup(); assert(cups.active_id == 1);
    sensor_ready = true; weight = NAN;
    device_next_cup(); assert(cups.active_id == 1);
    weight = 0; save_error = -1;
    device_next_cup(); assert(cups.active_id == 1 && persisted_cups.active_id == 1);
    save_error = 0;
    run_command(cup_action("delete", 2, NULL, NULL), true);
    device_next_cup(); assert(cups.active_id == 3);
    run_command(cup_action("delete", 3, NULL, NULL), true);
    assert(cups.active_id == 1);
    samples(305.5, 40); assert(sample_events == 0 && machine.has_baseline);
    int before = writes;
    device_next_cup();
    assert(cups.active_id == 1 && writes == before && machine.has_baseline);
    samples(0, 10); run_command(cup_action("delete", 1, NULL, NULL), true);
    before = writes; device_next_cup();
    assert(!cups.active_id && writes == before && !strcmp(cup_notice, "请先设置杯子"));
}
static void cloud_cups(void) {
    prepare(false);
    cJSON *response = cJSON_CreateObject();
    cJSON *payload = cJSON_AddObjectToObject(response, "command");
    cJSON_AddStringToObject(payload, "cmd", "cup"); cJSON_AddStringToObject(payload, "id", setup_id);
    cJSON_AddStringToObject(payload, "bindingId", binding.binding_id);
    cJSON_AddNumberToObject(payload, "expiresAt", network_epoch_ms() + 120000);
    cJSON_AddStringToObject(payload, "action", "rename");
    cJSON_AddNumberToObject(payload, "cupId", 1); cJSON_AddStringToObject(payload, "name", "茶杯");
    receive_command(response);
    assert(cloud_command.pending && cloud_command.ok && !strcmp(cups.items[0].name, "茶杯"));
    unsigned previous = writes;
    receive_command(response); assert(writes == (int)previous);
    assert(cloud_command_ack(&cloud_command, storage_save_command));
    receive_command(response); assert(writes == (int)previous && !cloud_command.pending);
    cJSON_Delete(response);
}
static void factory_cups(void) {
    prepare(false);
    sensor_ready = true; weight = 200; raw_count = WEIGHING_SAMPLES; last_sample_ms = now;
    for (unsigned i = 0; i < WEIGHING_SAMPLES; ++i) raw_samples[i] = config.zero - 20000;
    cup_config_t original = cups;
    for (unsigned phase = 0; phase < 3; ++phase) {
        cJSON *json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "cmd", "calibrate");
        cJSON_AddNumberToObject(json, "grams", 200);
        save_error = phase == 0 ? -1 : 0; config_error = phase == 1 ? -1 : 0;
        run_command(json, phase == 2);
        if (phase < 2) {
            assert(!memcmp(&cups, &original, sizeof(cups)));
            assert(!memcmp(&persisted_cups, &original, sizeof(cups)));
            assert(config.empty_cup == 105.5f);
        }
    }
    assert(!cups.active_id && !persisted_cups.active_id && config.empty_cup == 0 && persisted.empty_cup == 0);
    assert(config.counts_per_gram == -100 && !machine.has_baseline);
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
    else if (!strcmp(argv[1], "manual")) manual_cups();
    else if (!strcmp(argv[1], "manual-limits")) manual_limits();
    else if (!strcmp(argv[1], "cloud-manual")) cloud_manual_cup();
    else if (!strcmp(argv[1], "multi")) multi_cups();
    else if (!strcmp(argv[1], "cancel")) cup_cancel();
    else if (!strcmp(argv[1], "cycle")) cup_cycle();
    else if (!strcmp(argv[1], "cloud-cups")) cloud_cups();
    else if (!strcmp(argv[1], "factory-cups")) factory_cups();
    else assert(!"unknown test");
    return 0;
}
`;
    const filename = join(directory, 'server-command.c');
    const executable = join(directory, 'server-command');
    writeFileSync(filename, program);
    const compile = spawnSync(process.env.CC || 'cc', [
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', directory, '-I', firmware,
      filename, join(firmware, 'weighing.c'), join(firmware, 'cups.c'), join(firmware, 'provision_protocol.c'), join(firmware, 'cloud_command.c'), '-lm', '-o', executable,
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
      ['manual', '手动重量保存失败回滚、新增与修改、整瓶水首次放回及重启均不误记'],
      ['manual-limits', '手动重量校验数字、范围、名称、设备状态与移杯时间，设置中禁止提交'],
      ['cloud-manual', '手动重量随心跳完整下发，重复命令不改重量或清除已建立的基准'],
      ['multi', '真实采样：设置暂停记录、保存与切换、改名及删除不误记饮水'],
      ['cancel', '真实采样：取消与超时重新建基准，过期设置和非法杯名拒绝'],
      ['cycle', '三杯循环、跳过空位、删除当前杯、单杯无杯及异常拒绝切换'],
      ['cloud-cups', '真实心跳命令透传目标和杯名，重复投递不重复写入'],
      ['factory-cups', '工厂重新标定清空杯子，两个存储阶段失败均保留原杯配置'],
    ];
    for (const [name, description] of cases) {
      await t.test(description, () => {
        const run = spawnSync(executable, [name], { encoding: 'utf8' });
        assert.equal(run.status, 0, run.error?.message || run.stderr);
      });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
