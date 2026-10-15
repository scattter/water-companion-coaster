import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const firmware = fileURLToPath(new URL('../water_companion/', import.meta.url));
const testRoot = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
// Reuse the existing host JSON object shim. Parsing is a fixture boundary; the
// actual serial loop, command handlers, diagnostics and startup code run as C.
const jsonTest = readFileSync(new URL('./server_command.test.mjs', import.meta.url), 'utf8');
const jsonShim = jsonTest.split("writeFileSync(join(directory, 'cJSON.h'), `")[1]?.split('`);')[0];
assert.ok(jsonShim, 'existing host JSON object shim');

const headers = {
  'esp_err.h': String.raw`#pragma once
#include <stdint.h>
typedef int esp_err_t;
enum { ESP_OK = 0, ESP_ERR_NO_MEM = 0x101, ESP_ERR_INVALID_ARG,
       ESP_ERR_INVALID_STATE, ESP_ERR_INVALID_RESPONSE, ESP_ERR_NOT_FOUND,
       ESP_ERR_NVS_NOT_FOUND = 0x1102, ESP_ERR_NVS_NOT_ENOUGH_SPACE };
const char *esp_err_to_name(esp_err_t error);
void test_error_check(esp_err_t error, const char *file, int line);
#define ESP_ERROR_CHECK(value) test_error_check((value), __FILE__, __LINE__)
`,
  'esp_attr.h': '#pragma once\n#define DRAM_ATTR _Alignas(16)\n',
  'sdkconfig.h': '#pragma once\n#define CONFIG_IDF_TARGET_ESP32S3 1\n',
  'esp_wifi.h': '#pragma once\ntypedef struct { char ssid[33]; } wifi_ap_record_t;\n',
  'esp_system.h': '#pragma once\nvoid esp_restart(void);\n',
  'esp_timer.h': '#pragma once\n#include <stdint.h>\nint64_t esp_timer_get_time(void);\n',
  'esp_random.h': '#pragma once\n#include <stddef.h>\nvoid esp_fill_random(void *buffer, size_t size);\n',
  'lwip/inet.h': '#include <arpa/inet.h>\n',
  'lwip/sockets.h': '#include <sys/socket.h>\n',
  'esp_heap_caps.h': String.raw`#pragma once
#include <stddef.h>
#include <stdint.h>
#define MALLOC_CAP_8BIT (1U << 2)
#define MALLOC_CAP_SPIRAM (1U << 10)
#define MALLOC_CAP_INTERNAL (1U << 11)
void *heap_caps_calloc(size_t count, size_t size, uint32_t caps);
size_t heap_caps_get_total_size(uint32_t caps);
size_t heap_caps_get_free_size(uint32_t caps);
size_t heap_caps_get_largest_free_block(uint32_t caps);
size_t heap_caps_get_minimum_free_size(uint32_t caps);
`,
  'freertos/FreeRTOS.h': String.raw`#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef uint8_t StackType_t; /* Installed ESP32-S3 port uses byte stack units. */
typedef uint32_t TickType_t;
typedef int BaseType_t;
typedef unsigned UBaseType_t;
typedef struct { unsigned char bytes[352]; } StaticTask_t;
typedef void (*TaskFunction_t)(void *);
typedef struct test_task {
    TaskFunction_t entry;
    StackType_t *stack;
    StaticTask_t *tcb;
    size_t bytes;
    unsigned notifications;
} *TaskHandle_t;
typedef struct test_mutex { int depth; } *SemaphoreHandle_t;
#define pdTRUE 1
#define pdPASS 1
#define pdFAIL 0
#define portMAX_DELAY UINT32_MAX
#define pdMS_TO_TICKS(value) (value)
`,
  'freertos/task.h': String.raw`#pragma once
#include "FreeRTOS.h"
TaskHandle_t xTaskCreateStatic(TaskFunction_t entry, const char *name, uint32_t bytes,
    void *arg, UBaseType_t priority, StackType_t *stack, StaticTask_t *tcb);
BaseType_t xTaskCreate(TaskFunction_t entry, const char *name, uint32_t bytes,
    void *arg, UBaseType_t priority, TaskHandle_t *handle);
uint32_t ulTaskNotifyTake(BaseType_t clear, TickType_t wait);
void xTaskNotifyGive(TaskHandle_t task);
TickType_t xTaskGetTickCount(void);
void vTaskDelay(TickType_t ticks);
void vTaskDelayUntil(TickType_t *previous, TickType_t ticks);
`,
  'freertos/semphr.h': String.raw`#pragma once
#include "FreeRTOS.h"
SemaphoreHandle_t xSemaphoreCreateMutex(void);
BaseType_t xSemaphoreTake(SemaphoreHandle_t mutex, TickType_t wait);
void xSemaphoreGive(SemaphoreHandle_t mutex);
`,
  'cJSON.h': `${jsonShim}
static bool cJSON_IsObject(const cJSON *value) { return value && value->type == JSON_OBJECT; }
static cJSON *cJSON_ParseWithOpts(const char *text, const char **end, bool require_end);
static char *cJSON_PrintUnformatted(const cJSON *json);
#define cJSON_free free
`,
  'esp_mac.h': String.raw`#pragma once
#include <stdint.h>
#include "esp_err.h"
#define ESP_MAC_WIFI_STA 1
esp_err_t esp_read_mac(uint8_t mac[6], int type);
`,
  'nvs.h': String.raw`#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
typedef int nvs_handle_t;
typedef void *nvs_iterator_t;
typedef struct { char key[16]; } nvs_entry_info_t;
#define NVS_READWRITE 1
#define NVS_TYPE_BLOB 1
esp_err_t nvs_open_from_partition(const char *, const char *, int, nvs_handle_t *);
esp_err_t nvs_get_blob(nvs_handle_t, const char *, void *, size_t *);
esp_err_t nvs_set_blob(nvs_handle_t, const char *, const void *, size_t);
esp_err_t nvs_get_u64(nvs_handle_t, const char *, uint64_t *);
esp_err_t nvs_set_u64(nvs_handle_t, const char *, uint64_t);
esp_err_t nvs_commit(nvs_handle_t);
esp_err_t nvs_erase_key(nvs_handle_t, const char *);
esp_err_t nvs_entry_find(const char *, const char *, int, nvs_iterator_t *);
esp_err_t nvs_entry_next(nvs_iterator_t *);
void nvs_entry_info(nvs_iterator_t, nvs_entry_info_t *);
void nvs_release_iterator(nvs_iterator_t);
`,
  'nvs_flash.h': String.raw`#pragma once
#include "esp_err.h"
esp_err_t nvs_flash_init_partition(const char *);
esp_err_t nvs_flash_erase(void);
esp_err_t nvs_flash_erase_partition(const char *);
`,
};

function runC(program, cases, extraFiles = []) {
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(join(testRoot, 'startup-'));
  try {
    for (const [name, contents] of Object.entries(headers)) {
      const target = join(directory, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    const source = join(directory, 'test.c');
    const executable = join(directory, 'test');
    writeFileSync(source, program);
    const compile = spawnSync(process.env.CC || 'cc', [
      '-std=c11', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-pedantic',
      '-I', directory, '-I', firmware, source,
      ...extraFiles.map(name => join(firmware, name)), '-lm', '-o', executable,
    ], { encoding: 'utf8', env: { ...process.env, TMPDIR: directory }, timeout: 30000 });
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    for (const scenario of cases) {
      const run = spawnSync(executable, [scenario], { encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, `${scenario}: ${run.error?.message || run.stderr || run.signal || run.stdout}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('actual startup reserves full internal stacks, survives every failed phase and gates serial recovery', () => {
  const source = readFileSync(join(firmware, 'coaster.c'), 'utf8');
  // Host C cannot establish ESP memory placement. Check the target annotation in
  // addition to executing the actual declarations and checking byte sizes below.
  assert.match(source, /static\s+DRAM_ATTR\s+StackType_t\s+serial_stack\[/);
  assert.match(source, /static\s+DRAM_ATTR\s+StackType_t\s+sampling_stack\[/);
  assert.match(source, /static\s+DRAM_ATTR\s+StaticTask_t\s+serial_task_buffer/);
  runC(String.raw`
#include <assert.h>
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "coaster.c"

_Static_assert(sizeof(serial_stack) == 8192, "serial stack must not shrink");
_Static_assert(sizeof(sampling_stack) == 4096, "sampling stack must not shrink");
enum phase { NONE, SERIAL, STATE_LOCK, STORAGE, BINDING, TRUST, RECOVERY, HX711, BLE, NETWORK, SAMPLING };
static const char *const stages[] = { "ready", "serial", "state-lock", "storage", "binding", "trust",
    "provision-recovery", "hx711", "ble", "network", "sampling" };
static enum phase fail_phase;
static unsigned phase_calls, static_calls, dynamic_calls, task_heap_bytes, gate_waits, notifications;
static unsigned lock_takes, storage_reads, storage_writes, network_reads, dumps, wifi_writes, trust_writes, restarts;
static size_t internal_free = 24000, internal_largest = 16000;
static struct test_mutex state_mutex;
static struct test_task serial_slot, sample_slot, legacy_slot;
static TaskHandle_t running_task;
static bool parking;
static jmp_buf gate_parked, console_done;
static char log_text[32768], input_text[8192];
static size_t input_offset;
static struct { char *line; cJSON *json; } requests[32];
static cJSON *responses[32];
static unsigned request_count, parsed_count, response_count;
static const char *const deployment = "11111111-1111-4111-8111-111111111111";
static const char *const public_key =
    "04f3269fd9fa579a7e21029ee8454739712911f50d95f16f32b248964484e83e2ba664fe740e49e5de301958f39e02e833913ca22156413c7064afe37fcd6eee5a";

static esp_err_t injected_error(enum phase phase) {
    if (phase == NONE) return ESP_OK;
    if (phase == SERIAL || phase == STATE_LOCK || phase == SAMPLING) return ESP_ERR_NO_MEM;
    return 0x7000 + phase;
}
static esp_err_t enter_phase(enum phase phase) {
    assert((unsigned)phase == ++phase_calls && notifications == 0);
    if (phase != SERIAL) assert(gate_waits == 1 && serial_slot.entry == serial_task);
    return fail_phase == phase ? injected_error(phase) : ESP_OK;
}
void test_error_check(esp_err_t error, const char *file, int line) {
    (void)file; (void)line;
    assert(error == ESP_OK && "initialization must return errors instead of aborting");
}
const char *esp_err_to_name(esp_err_t error) {
    if (error == ESP_OK) return "ESP_OK";
    if (error == ESP_ERR_NO_MEM) return "ESP_ERR_NO_MEM";
    if (error == ESP_ERR_INVALID_STATE) return "ESP_ERR_INVALID_STATE";
    return "INJECTED_FAILURE";
}
void console_println(const char *text) {
    assert(text && strlen(log_text) + strlen(text) + 2 < sizeof(log_text));
    strcat(log_text, text); strcat(log_text, "\n");
}
size_t heap_caps_get_free_size(uint32_t caps) {
    if (caps == MALLOC_CAP_SPIRAM) return 8 * 1024 * 1024 - 32768;
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)); return internal_free;
}
size_t heap_caps_get_largest_free_block(uint32_t caps) {
    if (caps == MALLOC_CAP_SPIRAM) return 4 * 1024 * 1024;
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)); return internal_largest;
}
size_t heap_caps_get_minimum_free_size(uint32_t caps) {
    assert(caps == (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)); return 1000;
}
size_t heap_caps_get_total_size(uint32_t caps) { assert(caps == MALLOC_CAP_SPIRAM); return 8 * 1024 * 1024; }
TaskHandle_t xTaskCreateStatic(TaskFunction_t entry, const char *name, uint32_t bytes,
    void *arg, UBaseType_t priority, StackType_t *stack, StaticTask_t *tcb) {
    ++static_calls;
    assert(!arg && stack && tcb && (uintptr_t)stack % 16 == 0);
    if (entry == serial_task) {
        assert(!strcmp(name, "coaster-serial") && bytes == 8192 && priority == 5);
        assert(stack == serial_stack && tcb == &serial_task_buffer);
        if (enter_phase(SERIAL) != ESP_OK) return NULL;
        serial_slot = (struct test_task){ entry, stack, tcb, bytes, 0 };
        // Simulate immediate scheduling, before xTaskCreateStatic returns. The
        // first operation must park at the notification without touching state.
        running_task = &serial_slot; parking = true;
        if (setjmp(gate_parked) == 0) { entry(NULL); assert(!"serial must block on its startup gate"); }
        parking = false;
        return &serial_slot;
    }
    assert(entry == sample_task && !strcmp(name, "coaster-sampling") && bytes == 4096 && priority == 6);
    assert(stack == sampling_stack && tcb == &sampling_task_buffer && stack != serial_stack);
    if (enter_phase(SAMPLING) != ESP_OK) return NULL;
    sample_slot = (struct test_task){ entry, stack, tcb, bytes, 0 };
    return &sample_slot;
}
BaseType_t xTaskCreate(TaskFunction_t entry, const char *name, uint32_t bytes,
    void *arg, UBaseType_t priority, TaskHandle_t *handle) {
    (void)entry; (void)name; (void)arg; (void)priority;
    ++dynamic_calls;
    if (bytes > internal_largest || bytes + sizeof(StaticTask_t) > internal_free) return pdFAIL;
    internal_free -= bytes + sizeof(StaticTask_t);
    if (internal_largest > internal_free) internal_largest = internal_free;
    task_heap_bytes += bytes + sizeof(StaticTask_t);
    if (handle) *handle = &legacy_slot;
    return pdPASS;
}
uint32_t ulTaskNotifyTake(BaseType_t clear, TickType_t wait) {
    assert(clear == pdTRUE && wait == portMAX_DELAY && running_task == &serial_slot);
    ++gate_waits;
    if (parking) {
        assert(!running_task->notifications && !lock_takes && !input_offset && !storage_reads && !network_reads);
        longjmp(gate_parked, 1);
    }
    assert(running_task->notifications == 1 && notifications == 1);
    running_task->notifications = 0;
    return 1;
}
void xTaskNotifyGive(TaskHandle_t task) {
    assert(task == &serial_slot && !notifications && !task->notifications);
    assert(startup_error == injected_error(fail_phase));
    assert(!strcmp(startup_stage, stages[fail_phase]));
    ++notifications; ++task->notifications;
}
SemaphoreHandle_t xSemaphoreCreateMutex(void) {
    return enter_phase(STATE_LOCK) == ESP_OK ? &state_mutex : NULL;
}
BaseType_t xSemaphoreTake(SemaphoreHandle_t mutex, TickType_t wait) {
    assert(startup_error == ESP_OK && mutex == &state_mutex && wait == portMAX_DELAY && !mutex->depth);
    ++lock_takes; ++mutex->depth; return pdTRUE;
}
void xSemaphoreGive(SemaphoreHandle_t mutex) { assert(mutex == &state_mutex && mutex->depth == 1); --mutex->depth; }
TickType_t xTaskGetTickCount(void) { return 0; }
void vTaskDelay(TickType_t ticks) { assert(ticks > 0); }
void vTaskDelayUntil(TickType_t *previous, TickType_t ticks) { *previous += ticks; }
int64_t esp_timer_get_time(void) { return 1000000; }
esp_err_t esp_read_mac(uint8_t mac[6], int type) { assert(type == ESP_MAC_WIFI_STA); memset(mac, 0x12, 6); return ESP_OK; }
void esp_restart(void) { ++restarts; assert(!"no implicit restart on initialization failure"); }
void esp_fill_random(void *buffer, size_t size) { memset(buffer, 0x12, size); }
esp_err_t storage_init(device_config_t *value, uint64_t *id) {
    esp_err_t result = enter_phase(STORAGE);
    // Failed NVS may leave unvalidated bytes, not a safe configuration object.
    memset(value, 0xff, sizeof(*value));
    if (result != ESP_OK) return result;
    memset(value, 0, sizeof(*value)); value->version = CONFIG_VERSION;
    strcpy(value->device_id, "coaster-test"); strcpy(value->token, "device-secret-0123456789");
    strcpy(value->server_url, "https://old.example"); *id = 123;
    return ESP_OK;
}
esp_err_t storage_load_binding(binding_state_t *value) {
    memset(value, 0, sizeof(*value)); return enter_phase(BINDING);
}
esp_err_t storage_load_trust(provision_trust_t *value) {
    memset(value, 0, sizeof(*value)); return enter_phase(TRUST);
}
esp_err_t provisioning_start(void) { return enter_phase(RECOVERY); }
bool provisioning_busy(void) { return false; }
esp_err_t hx711_init(int dout, int sck) {
    assert(dout == HX711_DOUT_PIN && sck == HX711_SCK_PIN); return enter_phase(HX711);
}
esp_err_t hx711_read(int32_t *raw, uint32_t timeout) { (void)raw; (void)timeout; return ESP_ERR_INVALID_STATE; }
esp_err_t ble_provision_start(const char *id, const provision_trust_t *root, bool initial) {
    assert(!strcmp(id, "coaster-test") && root == &trust && initial);
    // Model the post-radio internal heap that allowed the old 4 KiB sampling
    // task but could not also allocate its later 8 KiB serial task.
    internal_free = 6000; internal_largest = 4096;
    return enter_phase(BLE);
}
esp_err_t network_start(const device_config_t *value) { assert(value == &config); return enter_phase(NETWORK); }
void network_snapshot(network_status_t *value) {
    assert(startup_error == ESP_OK); ++network_reads; memset(value, 0, sizeof(*value));
}
bool network_has_time(void) { assert(startup_error == ESP_OK); return false; }
int64_t network_epoch_ms(void) { assert(startup_error == ESP_OK); return 0; }
void storage_counts(unsigned *pending, unsigned *time_pending) {
    assert(startup_error == ESP_OK); ++storage_reads; *pending = 2; *time_pending = 1;
}
void storage_dump_pending_time(void) { assert(startup_error == ESP_OK); ++dumps; }
esp_err_t storage_save_config(const device_config_t *value) {
    assert(startup_error == ESP_OK && state_mutex.depth == 1 && value); ++storage_writes; return ESP_OK;
}
esp_err_t storage_stage_wifi(const char *ssid, const char *password) {
    assert(startup_error == ESP_OK && state_mutex.depth == 1);
    assert(!strcmp(ssid, "new-wifi") && !strcmp(password, "new-password")); ++wifi_writes; return ESP_OK;
}
esp_err_t storage_save_trust(const provision_trust_t *value) {
    assert(startup_error == ESP_OK && state_mutex.depth == 1 && value->version == 1);
    assert(!strcmp(value->deployment_id, deployment) && !strcmp(value->public_key, public_key));
    ++trust_writes; return ESP_OK;
}
esp_err_t storage_save_binding(const binding_state_t *value) { (void)value; assert(!"unexpected binding write"); return ESP_OK; }
esp_err_t storage_append(const saved_event_t *value) { (void)value; assert(!"unexpected event write"); return ESP_OK; }
bool provision_public_key(const char *key) { return key && !strcmp(key, public_key); }
bool provision_fingerprint(const char *text, char output[65]) {
    assert(startup_error == ESP_OK && text); memset(output, 'a', 64); output[64] = 0; return true;
}

static cJSON *clone_json(const cJSON *source) {
    cJSON *copy = json_value(source->type); copy->valuedouble = source->valuedouble;
    if (source->string) copy->string = copy_string(source->string);
    if (source->valuestring) copy->valuestring = copy_string(source->valuestring);
    cJSON **next = &copy->child;
    for (const cJSON *child = source->child; child; child = child->next) {
        *next = clone_json(child); next = &(*next)->next;
    }
    return copy;
}
static cJSON *cJSON_ParseWithOpts(const char *text, const char **end, bool require_end) {
    assert(!end && require_end && parsed_count < request_count);
    assert(!strcmp(text, requests[parsed_count].line));
    cJSON *value = requests[parsed_count].json; requests[parsed_count++].json = NULL; return value;
}
static char *cJSON_PrintUnformatted(const cJSON *json) {
    assert(response_count < 32); responses[response_count++] = clone_json(json); return copy_string("{}");
}
int coaster_console_read(void) {
    assert(!parking && gate_waits == 2 && !serial_slot.notifications);
    if (!input_text[input_offset]) longjmp(console_done, 1);
    return (unsigned char)input_text[input_offset++];
}
static cJSON *command(const char *name) {
    cJSON *json = cJSON_CreateObject(); cJSON_AddStringToObject(json, "cmd", name); return json;
}
static void enqueue(const char *line, cJSON *json) {
    assert(request_count < 32 && strlen(input_text) + strlen(line) + 2 < sizeof(input_text));
    requests[request_count].line = copy_string(line); requests[request_count++].json = json;
    strcat(input_text, line); strcat(input_text, "\n");
}
static void drive_serial(void) {
    running_task = &serial_slot;
    if (setjmp(console_done) == 0) { serial_slot.entry(NULL); assert(!"serial task must not return"); }
    assert(parsed_count == request_count && !state_mutex.depth && !restarts);
}
static void assert_diagnostics(const cJSON *json) {
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "startupOk")) == (startup_error == ESP_OK));
    assert(!strcmp(field(json, "startupStage"), stages[fail_phase]));
    assert(!strcmp(field(json, "startupError"), esp_err_to_name(startup_error)));
    assert(!strcmp(field(json, "firmwareVersion"), FIRMWARE_VERSION));
    assert(cJSON_GetObjectItemCaseSensitive(json, "internalHeapFree")->valuedouble == internal_free);
    assert(cJSON_GetObjectItemCaseSensitive(json, "internalHeapLargest")->valuedouble == internal_largest);
    assert(cJSON_GetObjectItemCaseSensitive(json, "internalHeapMinimum")->valuedouble == 1000);
    assert(cJSON_GetObjectItemCaseSensitive(json, "psramTotal")->valuedouble == 8 * 1024 * 1024);
    assert(cJSON_GetObjectItemCaseSensitive(json, "psramFree")->valuedouble == 8 * 1024 * 1024 - 32768);
}
static void failed_serial(void) {
    const char *names[] = { "status", "diagnostics", "pending-time", "factory-info", "trust", "wifi", "server",
        "tare", "calibrate", "cup", "watch", "reboot", "unknown" };
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        char line[80]; snprintf(line, sizeof(line), "{\"cmd\":\"%s\"}", names[i]); enqueue(line, command(names[i]));
    }
    enqueue("not-json", NULL);
    drive_serial();
    assert(response_count == request_count);
    assert_diagnostics(responses[0]); assert_diagnostics(responses[1]);
    for (unsigned i = 2; i < response_count; ++i) {
        assert(!cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(responses[i], "ok")));
        assert(strstr(field(responses[i], "error"), "仅允许 status 或 diagnostics"));
    }
    assert(!lock_takes && !storage_reads && !storage_writes && !network_reads && !dumps && !wifi_writes && !trust_writes);
    assert(!reboot_at_ms && !restart_required && !watch);
}
static void normal_serial(void) {
    enqueue("{\"cmd\":\"status\"}", command("status"));
    enqueue("{\"cmd\":\"diagnostics\"}", command("diagnostics"));
    enqueue("{\"cmd\":\"pending-time\"}", command("pending-time"));
    enqueue("{\"cmd\":\"factory-info\"}", command("factory-info"));
    cJSON *json = command("watch"); cJSON_AddBoolToObject(json, "enabled", true);
    enqueue("{\"cmd\":\"watch\",\"enabled\":true}", json);
    json = command("trust"); cJSON_AddStringToObject(json, "deploymentId", deployment); cJSON_AddStringToObject(json, "publicKey", public_key);
    char line[384]; snprintf(line, sizeof(line), "{\"cmd\":\"trust\",\"deploymentId\":\"%s\",\"publicKey\":\"%s\"}", deployment, public_key);
    enqueue(line, json);
    json = command("wifi"); cJSON_AddStringToObject(json, "ssid", "new-wifi"); cJSON_AddStringToObject(json, "password", "new-password");
    enqueue("{\"cmd\":\"wifi\",\"ssid\":\"new-wifi\",\"password\":\"new-password\"}", json);
    json = command("server"); cJSON_AddStringToObject(json, "url", "https://new.example");
    enqueue("{\"cmd\":\"server\",\"url\":\"https://new.example\"}", json);
    enqueue("{\"cmd\":\"reboot\"}", command("reboot"));
    drive_serial();
    assert(response_count == 8 && storage_reads == 2 && network_reads == 1 && dumps == 1);
    assert(cJSON_GetObjectItemCaseSensitive(responses[0], "pendingCount")->valuedouble == 2);
    assert(!cJSON_GetObjectItemCaseSensitive(responses[0], "startupOk"));
    assert_diagnostics(responses[1]);
    assert(!strcmp(field(responses[2], "deviceId"), "coaster-test"));
    assert(field(responses[2], "tokenFingerprint") && !cJSON_GetObjectItemCaseSensitive(responses[2], "token"));
    for (unsigned i = 2; i < response_count; ++i) assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(responses[i], "ok")));
    assert(storage_writes == 1 && wifi_writes == 1 && trust_writes == 1 && lock_takes > 0);
    assert(watch && restart_required && reboot_at_ms == 2000);
    assert(!strcmp(config.server_url, "https://new.example") && !strcmp(config.token, "device-secret-0123456789"));
}
int main(int argc, char **argv) {
    assert(argc == 2);
    if (!strcmp(argv[1], "legacy-heap")) {
        internal_free = 6000; internal_largest = 4096;
        assert(xTaskCreate(sample_task, "old-sampling", 4096, NULL, 6, NULL) == pdPASS);
        assert(xTaskCreate(serial_task, "old-serial", 8192, NULL, 5, NULL) == pdFAIL);
        assert(dynamic_calls == 2 && task_heap_bytes > 4096);
        dynamic_calls = task_heap_bytes = 0; internal_free = 24000; internal_largest = 16000;
    } else {
        bool found = false;
        for (unsigned i = 0; i < sizeof(stages) / sizeof(stages[0]); ++i) {
            if (!strcmp(argv[1], stages[i])) { fail_phase = (enum phase)i; found = true; break; }
        }
        assert(found);
    }
    esp_err_t result = device_start();
    assert(result == injected_error(fail_phase) && startup_error == result);
    assert(phase_calls == (unsigned)(fail_phase == NONE ? SAMPLING : fail_phase));
    assert(static_calls == (unsigned)(fail_phase == NONE || fail_phase == SAMPLING ? 2 : 1));
    assert(!dynamic_calls && !task_heap_bytes);
    assert(strstr(log_text, "boot[before-init] internal free=24000 largest=16000 min=1000; PSRAM total=8388608"));
    char final_log[64]; snprintf(final_log, sizeof(final_log), "boot[%s]", stages[fail_phase]);
    assert(strstr(log_text, final_log));
    if (fail_phase == SERIAL) { assert(!serial_handle && !notifications && !gate_waits); return 0; }
    assert(serial_handle == &serial_slot && notifications == 1 && gate_waits == 1);
    if (fail_phase != NONE) failed_serial();
    else {
        assert(sample_slot.entry == sample_task && internal_free == 6000 && internal_largest == 4096);
        normal_serial();
    }
    for (unsigned i = 0; i < request_count; ++i) { free(requests[i].line); cJSON_Delete(requests[i].json); }
    for (unsigned i = 0; i < response_count; ++i) cJSON_Delete(responses[i]);
    return 0;
}
`, ['ready', 'legacy-heap', 'serial', 'state-lock', 'storage', 'binding', 'trust',
    'provision-recovery', 'hx711', 'ble', 'network', 'sampling'], ['weighing.c', 'provision_protocol.c']);
});

test('actual PSRAM queue allocation uses 32 KiB without internal fallback or flash writes on failure', () => {
  runC(String.raw`
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void *forbidden_malloc(size_t bytes);
static void *forbidden_calloc(size_t count, size_t bytes);
// Catch ordinary-heap fallback as well as a heap_caps call with internal flags.
#define malloc forbidden_malloc
#define calloc forbidden_calloc
#include "storage.c"
#undef malloc
#undef calloc

_Static_assert(EVENT_CAPACITY * sizeof(queue_entry_t) == 32768, "event index is 32 KiB");
static size_t available_psram, allocated_bytes;
static uint32_t allocated_caps;
static unsigned allocations, mutex_creates, nvs_calls, partition_inits, writes, commits, erases, messages;
static bool fail_nvs, corrupt_config;
static struct test_mutex storage_mutex;
static char last_message[256];
static void *forbidden_malloc(size_t bytes) { (void)bytes; assert(!"no internal heap fallback"); return NULL; }
static void *forbidden_calloc(size_t count, size_t bytes) { (void)count; (void)bytes; assert(!"no internal heap fallback"); return NULL; }
void *heap_caps_calloc(size_t count, size_t bytes, uint32_t caps) {
    ++allocations; allocated_bytes = count * bytes; allocated_caps = caps;
    assert(count == EVENT_CAPACITY && bytes == sizeof(queue_entry_t));
    assert(caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    assert(!nvs_calls && !mutex_creates);
    return allocated_bytes <= available_psram ? calloc(count, bytes) : NULL;
}
void console_println(const char *text) { ++messages; snprintf(last_message, sizeof(last_message), "%s", text); }
SemaphoreHandle_t xSemaphoreCreateMutex(void) { assert(queue); ++mutex_creates; return &storage_mutex; }
BaseType_t xSemaphoreTake(SemaphoreHandle_t mutex, TickType_t wait) { assert(mutex == &storage_mutex && wait == portMAX_DELAY); return pdTRUE; }
void xSemaphoreGive(SemaphoreHandle_t mutex) { assert(mutex == &storage_mutex); }
esp_err_t nvs_flash_init_partition(const char *name) {
    assert(queue && mutex_creates == 1 && (!strcmp(name, "settings") || !strcmp(name, "events")));
    ++nvs_calls; ++partition_inits; return fail_nvs ? ESP_ERR_INVALID_STATE : ESP_OK;
}
esp_err_t nvs_open_from_partition(const char *partition, const char *name, int mode, nvs_handle_t *handle) {
    assert(mode == NVS_READWRITE); ++nvs_calls;
    if (!strcmp(partition, "settings")) { assert(!strcmp(name, "coaster")); *handle = 1; }
    else { assert(!strcmp(partition, "events") && !strcmp(name, "queue")); *handle = 2; }
    return ESP_OK;
}
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *value, size_t *size) {
    assert(handle == 1 && !strcmp(key, "config") && *size == sizeof(device_config_t)); ++nvs_calls;
    if (!corrupt_config) return ESP_ERR_NVS_NOT_FOUND;
    device_config_t invalid = { .version = CONFIG_VERSION };
    memset(invalid.ssid, 'x', sizeof(invalid.ssid)); memcpy(value, &invalid, sizeof(invalid)); return ESP_OK;
}
esp_err_t nvs_get_u64(nvs_handle_t handle, const char *key, uint64_t *value) {
    assert(handle == 1 && !strcmp(key, "boot") && value); ++nvs_calls; return ESP_ERR_NVS_NOT_FOUND;
}
esp_err_t nvs_entry_find(const char *partition, const char *name, int type, nvs_iterator_t *iterator) {
    assert(!strcmp(partition, "events") && !strcmp(name, "queue") && type == NVS_TYPE_BLOB);
    ++nvs_calls; *iterator = NULL; return ESP_ERR_NVS_NOT_FOUND;
}
void nvs_release_iterator(nvs_iterator_t iterator) { assert(!iterator); }
void nvs_entry_info(nvs_iterator_t iterator, nvs_entry_info_t *info) { (void)iterator; (void)info; assert(!"empty event partition"); }
esp_err_t nvs_entry_next(nvs_iterator_t *iterator) { (void)iterator; assert(!"empty event partition"); return ESP_ERR_NVS_NOT_FOUND; }
esp_err_t nvs_set_u64(nvs_handle_t handle, const char *key, uint64_t value) {
    assert(handle == 1 && !strcmp(key, "boot") && value == 1); ++nvs_calls; ++writes; return ESP_OK;
}
esp_err_t nvs_commit(nvs_handle_t handle) { assert(handle == 1); ++nvs_calls; ++commits; return ESP_OK; }
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t size) {
    (void)handle; (void)key; (void)value; (void)size; ++nvs_calls; ++writes; assert(!"unexpected flash mutation"); return ESP_OK;
}
esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key) { (void)handle; (void)key; ++erases; assert(!"must preserve flash"); return ESP_OK; }
esp_err_t nvs_flash_erase(void) { ++erases; assert(!"must preserve flash"); return ESP_OK; }
esp_err_t nvs_flash_erase_partition(const char *partition) { (void)partition; ++erases; assert(!"must preserve flash"); return ESP_OK; }
esp_err_t esp_read_mac(uint8_t mac[6], int type) { assert(type == ESP_MAC_WIFI_STA); memset(mac, 0x12, 6); return ESP_OK; }
void esp_fill_random(void *buffer, size_t size) { memset(buffer, 0x12, size); }
bool provision_public_key(const char *key) { (void)key; assert(!"queue startup must not validate trust"); return false; }

int main(int argc, char **argv) {
    assert(argc == 2);
    available_psram = !strcmp(argv[1], "missing-psram") ? 0 : !strcmp(argv[1], "psram-full") ? 32767 : 32768;
    fail_nvs = !strcmp(argv[1], "nvs-failure"); corrupt_config = !strcmp(argv[1], "corrupt-config");
    device_config_t config, original; memset(&config, 0xa5, sizeof(config)); original = config;
    uint64_t boot = 0x12345678;
    if (available_psram < 32768) {
        assert(allocate_queue() == ESP_ERR_NO_MEM && !queue && allocations == 1);
        assert(allocated_bytes == 32768 && allocated_caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        assert(storage_init(&config, &boot) == ESP_ERR_NO_MEM && !queue && allocations == 2);
        assert(!nvs_calls && !writes && !commits && !erases && !mutex_creates);
        assert(!memcmp(&config, &original, sizeof(config)) && boot == 0x12345678);
        assert(messages == 2 && strstr(last_message, "OPI PSRAM") && strstr(last_message, "保留 Flash 数据"));
        return 0;
    }
    assert(allocate_queue() == ESP_OK && queue && allocations == 1);
    for (size_t i = 0; i < allocated_bytes; ++i) assert(((unsigned char *)queue)[i] == 0);
    queue_entry_t *first = queue; queue[0].sequence = 42;
    assert(allocate_queue() == ESP_OK && queue == first && allocations == 1 && queue[0].sequence == 42);
    memset(queue, 0, allocated_bytes);
    esp_err_t result = storage_init(&config, &boot);
    assert(allocations == 1 && mutex_creates == 1 && !erases);
    if (fail_nvs || corrupt_config) {
        assert(result == (fail_nvs ? ESP_ERR_INVALID_STATE : ESP_ERR_INVALID_RESPONSE));
        assert(!writes && !commits && boot == 0x12345678);
    } else {
        assert(result == ESP_OK && boot == 1 && config.version == CONFIG_VERSION);
        assert(partition_inits == 2 && writes == 1 && commits == 1 && !messages);
        assert(!strcmp(config.device_id, "coaster-121212121212"));
    }
    free(queue); return 0;
}
`, ['missing-psram', 'psram-full', 'ready', 'nvs-failure', 'corrupt-config'], ['provision_protocol.c']);
});
