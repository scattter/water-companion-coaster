#include <ctype.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "board_config.h"
#include "console.h"
#include "esp_random.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include "sdkconfig.h"
#include "device.h"
#include "hx711.h"
#include "network.h"
#include "storage.h"
#include "weighing.h"
#include "ble_provision.h"
#include "provisioning.h"

static SemaphoreHandle_t state_lock;
static device_config_t config;
static cup_config_t cups;
static cup_setup_t cup_setup;
static int64_t empty_since_ms = -1;
static char cup_notice[96];
static int64_t cup_notice_until;
static binding_state_t binding;
static provision_trust_t trust;
static weighing_t machine;
static uint64_t boot_id;
static int32_t raw_samples[WEIGHING_SAMPLES];
static unsigned raw_count, raw_next;
static int64_t last_sample_ms;
static bool sensor_ready, unsaved_event, watch, restart_required;
static int64_t reboot_at_ms;
static saved_event_t pending_event;
static float weight = NAN;
static float activity_weight = NAN;
static int64_t last_activity_ms;

// These tasks write Flash; their full stacks must remain in internal, cache-independent RAM.
static DRAM_ATTR StackType_t serial_stack[8192 / sizeof(StackType_t)];
static DRAM_ATTR StackType_t sampling_stack[4096 / sizeof(StackType_t)];
static DRAM_ATTR StaticTask_t serial_task_buffer, sampling_task_buffer;
static TaskHandle_t serial_handle;
static esp_err_t startup_error = ESP_ERR_INVALID_STATE;
static const char *startup_stage = "serial";

static void report_memory(const char *stage)
{
    const uint32_t internal = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    char message[240];
    snprintf(message, sizeof(message),
        "boot[%s] internal free=%u largest=%u min=%u; PSRAM total=%u free=%u largest=%u",
        stage, (unsigned)heap_caps_get_free_size(internal),
        (unsigned)heap_caps_get_largest_free_block(internal),
        (unsigned)heap_caps_get_minimum_free_size(internal),
        (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));
    console_println(message);
}

static cJSON *diagnostics_json(void)
{
    cJSON *json = cJSON_CreateObject();
    if (!json) return NULL;
    const uint32_t internal = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    cJSON_AddStringToObject(json, "firmwareVersion", FIRMWARE_VERSION);
    cJSON_AddBoolToObject(json, "startupOk", startup_error == ESP_OK);
    cJSON_AddStringToObject(json, "startupStage", startup_stage);
    cJSON_AddStringToObject(json, "startupError", esp_err_to_name(startup_error));
    cJSON_AddNumberToObject(json, "internalHeapFree", heap_caps_get_free_size(internal));
    cJSON_AddNumberToObject(json, "internalHeapLargest", heap_caps_get_largest_free_block(internal));
    cJSON_AddNumberToObject(json, "internalHeapMinimum", heap_caps_get_minimum_free_size(internal));
    cJSON_AddNumberToObject(json, "psramTotal", heap_caps_get_total_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(json, "psramFree", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    return json;
}

bool device_authorize(const char *id, const char *authorization)
{
    if (!id || !authorization || strncmp(authorization, "Bearer ", 7)) return false;
    const char *token = authorization + 7;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    size_t length = strlen(config.token);
    bool valid = length >= 16 && strlen(token) == length && config.device_id[0]
        && !strcmp(id, config.device_id);
    if (valid) {
        volatile unsigned difference = 0;
        for (size_t i = 0; i < length; ++i) difference = difference | (unsigned char)(token[i] ^ config.token[i]);
        valid = difference == 0;
    }
    xSemaphoreGive(state_lock);
    return valid;
}

void device_wake(void)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    last_activity_ms = esp_timer_get_time() / 1000;
    xSemaphoreGive(state_lock);
}

static void finish_cup_setup(void)
{
    memset(&cup_setup, 0, sizeof(cup_setup));
    weighing_init(&machine, config.empty_cup);
}

static void cup_message(const char *message)
{
    snprintf(cup_notice, sizeof(cup_notice), "%s", message);
    cup_notice_until = esp_timer_get_time() / 1000 + 3000;
    last_activity_ms = esp_timer_get_time() / 1000;
}

void device_cancel_cup_setup(void)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (cup_setup.id[0]) finish_cup_setup();
    xSemaphoreGive(state_lock);
}

static void update_activity(float grams, int64_t now)
{
    // 累计变化至少 5 g 才加快心跳，屏幕亮灭由按键独立控制。
    if (isfinite(grams) && (!isfinite(activity_weight) || fabsf(grams - activity_weight) >= 5)) {
        activity_weight = grams;
        last_activity_ms = now;
    }
}

void device_snapshot(device_status_t *status)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    bool fresh = sensor_ready && esp_timer_get_time() / 1000 - last_sample_ms <= 500;
    *status = (device_status_t){
        .sensor_ready = fresh, .calibrated = config.calibrated, .weight = weight,
        .empty_cup = config.empty_cup, .stable = fresh && machine.stable && !unsaved_event,
        .cups = cups, .cup_setup = cup_setup,
        .cup_present = fresh && config.calibrated && isfinite(weight) && weight > 5,
        .unsaved_event = unsaved_event, .raw_ready = fresh && raw_count > 0,
        .restart_required = restart_required,
        .active = esp_timer_get_time() / 1000 - last_activity_ms < DEVICE_IDLE_MS,
        .raw = raw_count ? raw_samples[(raw_next + WEIGHING_SAMPLES - 1) % WEIGHING_SAMPLES] : 0,
    };
    if (esp_timer_get_time() / 1000 < cup_notice_until)
        strcpy(status->cup_notice, cup_notice);
    if (!fresh) status->error = "HX711 未就绪，请检查接线和供电";
    else if (unsaved_event) status->error = "事件保存失败或缓存已满，已暂停识别";
    else if (restart_required) status->error = "联网设置已保存，请重启设备";
    else if (!config.calibrated) status->error = "出厂标定异常，请联系售后";
    else if (config.empty_cup < 5 && !cup_setup.id[0]) status->error = "请先登记空杯重量";
    else if (!isfinite(weight) || weight < -2 || weight > WEIGHING_MAX_GRAMS)
        status->error = "重量超出有效范围，请检查承重和校准";
    xSemaphoreGive(state_lock);
}

void device_cups_json(cJSON *json, const device_status_t *status)
{
    cJSON *list = cJSON_AddArrayToObject(json, "cups");
    for (unsigned id = 1; id <= CUP_CAPACITY; ++id) {
        const cup_t *cup = cups_get(&status->cups, id);
        if (!cup) continue;
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "id", id);
        cJSON_AddStringToObject(item, "name", cup->name);
        cJSON_AddNumberToObject(item, "emptyCupGrams", cup->empty_cup);
        cJSON_AddItemToArray(list, item);
    }
    if (status->cups.active_id) cJSON_AddNumberToObject(json, "activeCupId", status->cups.active_id);
    else cJSON_AddNullToObject(json, "activeCupId");
    if (status->cup_setup.id[0]) {
        cJSON *setup = cJSON_AddObjectToObject(json, "cupSetup");
        cJSON_AddStringToObject(setup, "id", status->cup_setup.id);
        cJSON_AddNumberToObject(setup, "cupId", status->cup_setup.cup_id);
        cJSON_AddStringToObject(setup, "name", status->cup_setup.name);
        cJSON_AddNumberToObject(setup, "expiresAt", status->cup_setup.expires_at);
    } else cJSON_AddNullToObject(json, "cupSetup");
}

cJSON *device_status_json(void)
{
    device_status_t status;
    device_snapshot(&status);
    unsigned pending, time_pending;
    storage_counts(&pending, &time_pending);
    cJSON *json = cJSON_CreateObject();
    if (!json) return NULL;
    cJSON_AddStringToObject(json, "firmwareVersion", FIRMWARE_VERSION);
    network_status_t network;
    network_snapshot(&network);
    cJSON_AddBoolToObject(json, "wifiConnected", network.wifi_connected);
    cJSON_AddBoolToObject(json, "serverConnected", network.server_connected);
    cJSON_AddStringToObject(json, "ip", network.ip);
    cJSON_AddNumberToObject(json, "wifiReason", network.wifi_reason);
    cJSON_AddNumberToObject(json, "httpStatus", network.http_status);
    cJSON_AddBoolToObject(json, "apReady", network.ap_ready);
    cJSON_AddStringToObject(json, "apSsid", network.ap_ssid);
    cJSON_AddStringToObject(json, "apIp", CONTROL_IP);
    cJSON_AddBoolToObject(json, "wifiConfigured", network.wifi_configured);
    cJSON_AddStringToObject(json, "wifiSsid", network.wifi_ssid);
    cJSON_AddBoolToObject(json, "serverConfigured", network.server_configured);
    cJSON_AddBoolToObject(json, "bound", network.bound);
    if (network.binding_code[0]) cJSON_AddStringToObject(json, "bindingCode", network.binding_code);
    else cJSON_AddNullToObject(json, "bindingCode");
    cJSON_AddNumberToObject(json, "bindingExpiresAt", network.binding_expires_at);
    cJSON_AddStringToObject(json, "cloudUrl", network.cloud_url);
    cJSON_AddBoolToObject(json, "wifiTrial", network.wifi_trial);
    cJSON_AddBoolToObject(json, "wifiRollback", network.wifi_rollback);
    cJSON_AddBoolToObject(json, "wifiSaveError", network.wifi_error != ESP_OK);
    cJSON_AddBoolToObject(json, "restartRequired", status.restart_required);
    if (status.raw_ready) cJSON_AddNumberToObject(json, "raw", status.raw);
    else cJSON_AddNullToObject(json, "raw");
    if (status.sensor_ready && status.calibrated && isfinite(status.weight))
        cJSON_AddNumberToObject(json, "weightGrams", roundf(status.weight * 10) / 10);
    else cJSON_AddNullToObject(json, "weightGrams");
    cJSON_AddBoolToObject(json, "stable", status.stable);
    cJSON_AddBoolToObject(json, "calibrated", status.calibrated);
    cJSON_AddBoolToObject(json, "cupPresent", status.cup_present);
    cJSON_AddNumberToObject(json, "emptyCupGrams", status.empty_cup);
    device_cups_json(json, &status);
    cJSON_AddBoolToObject(json, "clockSynced", network_has_time());
    cJSON_AddNumberToObject(json, "pendingCount", pending + (status.unsaved_event ? 1 : 0));
    cJSON_AddNumberToObject(json, "timePendingCount", time_pending);
    if (status.error) cJSON_AddStringToObject(json, "error", status.error);
    else cJSON_AddNullToObject(json, "error");
    xSemaphoreTake(state_lock, portMAX_DELAY);
    saved_event_t last = pending_event;
    bool saved = !unsaved_event;
    xSemaphoreGive(state_lock);
    if (last.id[0]) {
        cJSON *event = cJSON_AddObjectToObject(json, "lastEvent");
        cJSON_AddStringToObject(event, "kind", last.change.drink ? "drink" : "refill");
        cJSON_AddNumberToObject(event, "amountMl", last.change.amount);
        cJSON_AddNumberToObject(event, "beforeGrams", last.change.before);
        cJSON_AddNumberToObject(event, "afterGrams", last.change.after);
        cJSON_AddBoolToObject(event, "saved", saved);
    } else cJSON_AddNullToObject(json, "lastEvent");
    return json;
}

static void print_json(cJSON *json)
{
    if (!json) return;
    char *text = cJSON_PrintUnformatted(json);
    if (text) { console_println(text); cJSON_free(text); }
    cJSON_Delete(json);
}

static void create_event(const weight_change_t *change, int64_t uptime_ms)
{
    pending_event = (saved_event_t){
        .version = EVENT_VERSION, .boot_id = boot_id, .uptime_ms = uptime_ms,
        .epoch_ms = network_has_time() ? network_epoch_ms() : 0, .change = *change,
    };
    strcpy(pending_event.binding_id, binding.binding_id);
    uint8_t id[16];
    esp_fill_random(id, sizeof(id));
    id[6] = (id[6] & 0x0f) | 0x40;
    id[8] = (id[8] & 0x3f) | 0x80;
    snprintf(pending_event.id, sizeof(pending_event.id),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        id[0], id[1], id[2], id[3], id[4], id[5], id[6], id[7],
        id[8], id[9], id[10], id[11], id[12], id[13], id[14], id[15]);
    unsaved_event = storage_append(&pending_event) != ESP_OK;
}

static void sample_task(void *arg)
{
    (void)arg;
    TickType_t tick = xTaskGetTickCount();
    int64_t last_print = 0;
    for (;;) {
        int32_t raw;
        esp_err_t result = hx711_read(&raw, 500);
        int64_t now = esp_timer_get_time() / 1000;
        xSemaphoreTake(state_lock, portMAX_DELAY);
        if (cup_setup.id[0] && now >= cup_setup.expires_ms) {
            finish_cup_setup();
            cup_message("设置已超时");
        }
        if (result != ESP_OK) {
            empty_since_ms = -1;
            cup_setup.stable_since_ms = -1;
            sensor_ready = false;
            raw_count = raw_next = 0;
            weight = NAN;
            activity_weight = NAN;
            weighing_init(&machine, config.empty_cup);
        } else {
            if (sensor_ready && now - last_sample_ms > 350) {
                raw_count = raw_next = 0;
                empty_since_ms = -1;
                cup_setup.stable_since_ms = -1;
            }
            sensor_ready = true;
            last_sample_ms = now;
            raw_samples[raw_next] = raw;
            raw_next = (raw_next + 1) % WEIGHING_SAMPLES;
            if (raw_count < WEIGHING_SAMPLES) ++raw_count;
            weight = config.calibrated ? (float)((raw - (double)config.zero) / config.counts_per_gram) : NAN;
            if (isfinite(weight) && weight >= -2 && weight <= 5) {
                if (empty_since_ms < 0) empty_since_ms = now;
            } else empty_since_ms = -1;
            if (cup_setup.id[0]) {
                if (!isfinite(weight) || weight < 5 || weight > 1995) cup_setup.stable_since_ms = -1;
                else if (cup_setup.stable_since_ms < 0
                    || fmaxf(cup_setup.maximum, weight) - fminf(cup_setup.minimum, weight) > 1) {
                    cup_setup.stable_since_ms = now;
                    cup_setup.minimum = cup_setup.maximum = weight;
                } else {
                    cup_setup.minimum = fminf(cup_setup.minimum, weight);
                    cup_setup.maximum = fmaxf(cup_setup.maximum, weight);
                }
            }
            update_activity(weight, now);
            if (unsaved_event) {
                unsaved_event = storage_append(&pending_event) != ESP_OK;
                weighing_init(&machine, config.empty_cup);
            } else if (config.calibrated && config.empty_cup >= 5 && !cup_setup.id[0] && !restart_required && !provisioning_busy()) {
                weight_change_t change;
                if (weighing_sample(&machine, weight, now, &change)) create_event(&change, now);
            }
        }
        bool print = watch && now - last_print >= 1000;
        xSemaphoreGive(state_lock);
        if (print) { print_json(device_status_json()); last_print = now; }
        vTaskDelayUntil(&tick, pdMS_TO_TICKS(100));
    }
}

static const char *field(const cJSON *json, const char *name)
{
    const cJSON *value = cJSON_GetObjectItemCaseSensitive(json, name);
    return cJSON_IsString(value) ? value->valuestring : NULL;
}

static bool valid_id(const char *id)
{
    if (!id || !*id || strlen(id) > 64) return false;
    for (const unsigned char *p = (const unsigned char *)id; *p; ++p)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z')
            || (*p >= '0' && *p <= '9') || *p == '_' || *p == '-')) return false;
    return true;
}

static bool valid_url(const char *url)
{
    if (!url || strlen(url) >= sizeof(config.server_url)) return false;
    bool secure = strncmp(url, "https://", 8) == 0;
    if (!secure && strncmp(url, "http://", 7) != 0) return false;
    char host[192];
    strcpy(host, url + (secure ? 8 : 7));
    size_t length = strlen(host);
    if (length && host[length - 1] == '/') host[--length] = 0;
    if (!length || strpbrk(host, "/?#@[]") != NULL) return false;
    char *port = strchr(host, ':');
    if (port) {
        *port++ = 0;
        char *end;
        long value = strtol(port, &end, 10);
        if (!*port || *end || value < 1 || value > 65535) return false;
    }
    if (!*host) return false;
    for (const unsigned char *p = (const unsigned char *)host; *p; ++p)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z')
            || (*p >= '0' && *p <= '9') || *p == '-' || *p == '.')) return false;
    if (secure) return true;
    struct in_addr address;
    if (inet_pton(AF_INET, host, &address) != 1) return false;
    uint32_t ip = ntohl(address.s_addr);
    return (ip >> 24) == 10 || (ip >> 20) == 0xac1 || (ip >> 16) == 0xc0a8;
}

static bool raw_average(double *average, double *spread)
{
    if (!sensor_ready || raw_count < WEIGHING_SAMPLES
        || esp_timer_get_time() / 1000 - last_sample_ms > 350) return false;
    int32_t minimum = raw_samples[0], maximum = minimum;
    int64_t sum = 0;
    for (unsigned i = 0; i < WEIGHING_SAMPLES; ++i) {
        if (raw_samples[i] < minimum) minimum = raw_samples[i];
        if (raw_samples[i] > maximum) maximum = raw_samples[i];
        sum += raw_samples[i];
    }
    *average = (double)sum / WEIGHING_SAMPLES;
    *spread = (double)maximum - minimum;
    return true;
}

static cJSON *reply(const char *error, const char *message)
{
    cJSON *json = cJSON_CreateObject();
    if (!json) return NULL;
    cJSON_AddBoolToObject(json, "ok", error == NULL);
    cJSON_AddStringToObject(json, error ? "error" : "message", error ? error : message);
    return json;
}

static const char *cup_available(void)
{
    if (unsaved_event) return "记录尚未保存";
    if (reboot_at_ms || restart_required || provisioning_busy()) return "设备正在忙碌";
    if (!config.calibrated) return "出厂标定异常，请联系售后";
    if (!sensor_ready || esp_timer_get_time() / 1000 - last_sample_ms > 350
        || !isfinite(weight) || weight < -2 || weight > WEIGHING_MAX_GRAMS) return "重量异常，请检查";
    return NULL;
}

static bool cup_removed(void)
{
    int64_t now = esp_timer_get_time() / 1000;
    return empty_since_ms >= 0 && now - empty_since_ms >= 500 && now - last_sample_ms <= 350;
}

static const char *save_cups(const cup_config_t *next, bool reset)
{
    if (storage_save_cups(next) != ESP_OK) return "杯子保存失败";
    cups = *next;
    config.empty_cup = cups_weight(&cups);
    if (reset) weighing_init(&machine, config.empty_cup);
    last_activity_ms = esp_timer_get_time() / 1000;
    return NULL;
}

static const char *select_cup(unsigned id)
{
    const char *error = cup_available();
    if (error) return error;
    if (cup_setup.id[0]) return "请先完成杯子设置";
    if (!cups_get(&cups, id)) return "请先设置杯子";
    if (id == cups.active_id) return NULL;
    if (!cup_removed()) return "请先拿开杯子";
    cup_config_t next = cups;
    next.active_id = id;
    return save_cups(&next, true);
}

void device_next_cup(void)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    unsigned id = cups_next(&cups, cups.active_id);
    unsigned previous = cups.active_id;
    const char *error = select_cup(id);
    cup_message(error ? error : previous == id ? "已是当前杯子" : "已切换杯子");
    xSemaphoreGive(state_lock);
}

static cJSON *cup_command(const cJSON *json)
{
    const char *action = field(json, "action");
    if (!action && cJSON_GetObjectItemCaseSensitive(json, "action")) return reply("杯子操作无效", NULL);
    const char *setup_id = field(json, "setupId");
    int64_t now = esp_timer_get_time() / 1000;
    if (cup_setup.id[0] && now >= cup_setup.expires_ms) finish_cup_setup();
    if (action && (!strcmp(action, "cancel") || !strcmp(action, "save"))) {
        if (!setup_id || !cup_setup.id[0] || strcmp(setup_id, cup_setup.id))
            return reply("杯子设置已结束，请重新开始", NULL);
        if (!strcmp(action, "cancel")) {
            finish_cup_setup();
            return reply(NULL, "已取消杯子设置");
        }
    } else if (cup_setup.id[0]) return reply("请先完成或取消当前杯子设置", NULL);
    const char *error = cup_available();
    if (error) return reply(error, NULL);
    const cJSON *target = cJSON_GetObjectItemCaseSensitive(json, "cupId");
    unsigned id = cJSON_IsNumber(target) && target->valuedouble >= 1 && target->valuedouble <= CUP_CAPACITY
        && floor(target->valuedouble) == target->valuedouble ? (unsigned)target->valuedouble : 0;
    const char *name = field(json, "name");
    cup_config_t next = cups;
    if (!action || !strcmp(action, "save")) {
        double average, spread;
        if (!raw_average(&average, &spread)) return reply("请放上空杯并静置至少三秒", NULL);
        double grams = (average - config.zero) / config.counts_per_gram;
        if (grams < 5 || grams > 1995 || spread > fabs(config.counts_per_gram)
            || (action && (cup_setup.stable_since_ms < 0 || now - cup_setup.stable_since_ms < 3000)))
            return reply("空杯重量超出范围或尚未稳定", NULL);
        id = action ? cup_setup.cup_id : cups.active_id ? cups.active_id : 1;
        cup_t *cup = &next.items[id - 1];
        if (action) strcpy(cup->name, cup_setup.name);
        else if (!cup->name[0]) strcpy(cup->name, "默认杯");
        cup->empty_cup = roundf((float)grams * 10) / 10;
        next.active_id = id;
        error = save_cups(&next, true);
        if (!error) {
            memset(&cup_setup, 0, sizeof(cup_setup));
            machine.baseline = config.empty_cup;
            machine.has_baseline = true;
        }
        return reply(error, "空杯重量已保存，可以加水后开始正常取放");
    }
    if (!id) return reply("杯子编号需为 1–3", NULL);
    if (!strcmp(action, "manual")) {
        const cJSON *grams = cJSON_GetObjectItemCaseSensitive(json, "emptyCupGrams");
        if (!cup_name_valid(name)) return reply("杯名需为一至五个汉字、字母或数字", NULL);
        if (!cJSON_IsNumber(grams) || !isfinite(grams->valuedouble)
            || grams->valuedouble < 5 || grams->valuedouble > 1995)
            return reply("空杯重量需为 5–1995 g", NULL);
        const cup_t *existing = cups_get(&cups, id);
        if (existing && strcmp(name, existing->name)) return reply("杯名已变化，请刷新后重新设置", NULL);
        if (!cup_removed()) return reply("请先拿开杯子", NULL);
        cup_t *cup = &next.items[id - 1];
        strcpy(cup->name, name);
        cup->empty_cup = (float)(round(grams->valuedouble * 10) / 10);
        next.active_id = id;
        // 手动设置时瓶中可能已有水；首次放回只建立基准，不能以空瓶重量补记加水。
        return reply(save_cups(&next, true), "空杯重量已保存，请放回杯子或水瓶，首次放稳后开始记录");
    }
    if (!strcmp(action, "prepare")) {
        const char *operation_id = field(json, "id");
        if (!operation_id || !provision_uuid(operation_id) || !cup_name_valid(name))
            return reply("杯名需为一至五个汉字、字母或数字", NULL);
        const cup_t *existing = cups_get(&cups, id);
        if (existing && strcmp(name, existing->name)) return reply("杯名已变化，请刷新后重新设置", NULL);
        if (!cup_removed()) return reply("请先拿开杯子", NULL);
        if (!network_has_time()) return reply("请等待杯垫校时", NULL);
        strcpy(cup_setup.id, operation_id);
        cup_setup.cup_id = id;
        strcpy(cup_setup.name, name);
        cup_setup.expires_ms = now + CUP_SETUP_MS;
        cup_setup.expires_at = network_epoch_ms() + CUP_SETUP_MS;
        cup_setup.stable_since_ms = -1;
        weighing_init(&machine, config.empty_cup);
        raw_count = raw_next = 0;
        last_activity_ms = now;
        return reply(NULL, "已暂停记录，请放上空杯并静置三秒后保存");
    }
    if (!cups_get(&cups, id)) return reply("杯子不存在，请刷新后重试", NULL);
    if (!strcmp(action, "select")) {
        error = select_cup(id);
        cup_message(error ? error : "已切换杯子");
        return reply(error, "已切换杯子");
    }
    if (!strcmp(action, "rename")) {
        if (!cup_name_valid(name)) return reply("杯名需为一至五个汉字、字母或数字", NULL);
        strcpy(next.items[id - 1].name, name);
        return reply(save_cups(&next, false), "杯名已保存");
    }
    if (!strcmp(action, "delete")) {
        bool active = cups.active_id == id;
        if (active && !cup_removed()) return reply("请先拿开杯子", NULL);
        memset(&next.items[id - 1], 0, sizeof(cup_t));
        if (active) next.active_id = cups_next(&next, id);
        return reply(save_cups(&next, active), "杯子已删除");
    }
    return reply("未知杯子操作", NULL);
}

cJSON *device_command(const cJSON *json)
{
    const char *name = field(json, "cmd");
    if (!name) return reply("缺少 cmd", NULL);
    if (!strcmp(name, "status")) return device_status_json();
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (!strcmp(name, "cup")) {
        cJSON *response = cup_command(json);
        xSemaphoreGive(state_lock);
        return response;
    }
    if (!strcmp(name, "watch")) {
        const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(json, "enabled");
        cJSON *response;
        if (!cJSON_IsBool(enabled)) response = reply("enabled 必须为布尔值", NULL);
        else { watch = cJSON_IsTrue(enabled); response = reply(NULL, watch ? "已开启实时读数" : "已关闭实时读数"); }
        xSemaphoreGive(state_lock);
        return response;
    }
    if (unsaved_event || reboot_at_ms || provisioning_busy() || cup_setup.id[0]) {
        xSemaphoreGive(state_lock);
        return reply("存在尚未保存的记录或设备正在重启，当前不可修改设置", NULL);
    }
    if (!strcmp(name, "reboot")) {
        // 留出时间返回手机或串口的确认，并暂停新事件，避免重启时丢失未写记录。
        restart_required = true;
        reboot_at_ms = esp_timer_get_time() / 1000 + 1000;
        xSemaphoreGive(state_lock);
        return reply(NULL, "正在重启，请稍后重新连接杯垫热点");
    }
    device_config_t next = config;
    const char *error = NULL;
    bool reset_weighing = false;
    const char *message = "已保存；执行 reboot 后联网配置生效";
    if (!strcmp(name, "wifi")) {
        const char *ssid = field(json, "ssid"), *password = field(json, "password");
        if (!ssid || !*ssid || strlen(ssid) > 32 || !password
            || (strlen(password) != 0 && (strlen(password) < 8 || strlen(password) > 63)))
            error = "SSID 需为 1–32 字节；密码为空或 8–63 字节";
        else {
            esp_err_t saved = storage_stage_wifi(ssid, password);
            if (saved != ESP_OK) error = "Wi-Fi 配置暂存失败，请重试";
            else {
                restart_required = true;
                message = "Wi-Fi 已暂存，重启后验证连接；失败时保留原网络";
            }
            xSemaphoreGive(state_lock);
            return reply(error, message);
        }
    } else if (!strcmp(name, "server")) {
        bool has_url = cJSON_GetObjectItemCaseSensitive(json, "url") != NULL;
        bool has_id = cJSON_GetObjectItemCaseSensitive(json, "id") != NULL;
        bool has_token = cJSON_GetObjectItemCaseSensitive(json, "token") != NULL;
        const char *url = field(json, "url"), *id = field(json, "id"), *token = field(json, "token");
        bool token_valid = token && strlen(token) >= 16 && strlen(token) <= 128;
        if (token_valid) {
            for (const unsigned char *p = (const unsigned char *)token; *p; ++p)
                if (*p < 33 || *p > 126) token_valid = false;
        }
        if ((!has_url && !has_id) || has_id != has_token)
            error = "至少提供 url 或成对的 id/token";
        else if ((has_url && !valid_url(url)) || (has_id && (!valid_id(id) || !token_valid)))
            error = "地址需为不带路径的 HTTPS 或局域网 IPv4 HTTP；设备编号及 16–128 位凭证不可为空";
        else {
            if (has_url) {
                strcpy(next.server_url, url);
                size_t length = strlen(next.server_url);
                if (next.server_url[length - 1] == '/') next.server_url[length - 1] = 0;
            }
            if (has_id) {
                strcpy(next.device_id, id);
                strcpy(next.token, token);
            }
            unsigned pending, time_pending;
            storage_counts(&pending, &time_pending);
            if (pending && strcmp(next.device_id, config.device_id))
                error = "仍有待处理记录，上传完成前不能修改设备编号";
        }
    } else if (!strcmp(name, "tare") || !strcmp(name, "calibrate")) {
        double average, spread;
        if (!raw_average(&average, &spread)) error = "传感器未就绪，请静置至少两秒";
        else if (!strcmp(name, "tare")) {
            double limit = config.calibrated ? fabs(config.counts_per_gram) : 1000;
            if (spread > limit) error = "零点采样不稳定，请检查承重平台并重试";
            else {
                next.zero = (int32_t)llround(average);
                next.zero_set = true;
                // 工厂修正零点不清除已验证的比例和用户空杯设置。
                reset_weighing = true;
                message = config.calibrated ? "零点已更新，原重量标定与空杯设置已保留" : "零点已保存；放上已知重量物品完成出厂标定";
            }
        } else if (!strcmp(name, "calibrate")) {
            const cJSON *grams = cJSON_GetObjectItemCaseSensitive(json, "grams");
            if (!config.zero_set) error = "请先移走杯子和砝码，执行 tare";
            else if (!cJSON_IsNumber(grams) || !isfinite(grams->valuedouble)
                || grams->valuedouble < 50 || grams->valuedouble > 2000)
                error = "已知质量需为 50–2000 g";
            else {
                double scale = (average - config.zero) / grams->valuedouble;
                if (fabs(scale) < 1 || spread > fabs(scale))
                    error = "砝码采样不稳定或信号不足，请检查接线和受力";
                else {
                    next.counts_per_gram = scale;
                    next.calibrated = true;
                    next.empty_cup = 0;
                    reset_weighing = true;
                    message = "重量校准已保存；放上日常空杯并更新空杯重量";
                }
            }
        }
    } else error = "未知命令：status、watch、wifi、server、tare、calibrate、cup、pending-time、reboot";
    if (!error) {
        bool clear_cups = !strcmp(name, "calibrate");
        cup_config_t cleared;
        cups_init(&cleared, binding.binding_id, 0);
        esp_err_t result = clear_cups ? storage_save_cups(&cleared) : ESP_OK;
        bool cups_cleared = clear_cups && result == ESP_OK;
        if (result == ESP_OK) result = storage_save_config(&next);
        if (result != ESP_OK) {
            error = "配置写入失败；请保留设备数据并检查 Flash";
            // 标定中断优先停用旧杯基准，不能用新比例继续解释旧杯重量。
            if (cups_cleared && storage_save_cups(&cups) != ESP_OK) {
                cups = cleared;
                config.empty_cup = 0;
                weighing_init(&machine, 0);
                error = "杯子配置恢复失败，请重新设置空杯";
            }
        }
        else {
            config = next;
            if (clear_cups) cups = cleared;
            if (!strcmp(name, "wifi") || !strcmp(name, "server")) restart_required = true;
            if (reset_weighing || restart_required) {
                weighing_init(&machine, config.empty_cup);
                activity_weight = NAN;
                last_activity_ms = esp_timer_get_time() / 1000;
            }
        }
    }
    xSemaphoreGive(state_lock);
    return reply(error, message);
}

esp_err_t device_save_wifi(const char *ssid, const char *password)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    device_config_t next = config;
    snprintf(next.ssid, sizeof(next.ssid), "%s", ssid);
    snprintf(next.password, sizeof(next.password), "%s", password);
    esp_err_t result = storage_save_config(&next);
    if (result == ESP_OK) config = next;
    xSemaphoreGive(state_lock);
    return result;
}

static cJSON *factory_command(const cJSON *json)
{
    const char *name = field(json, "cmd");
    if (!strcmp(name, "factory-info")) {
        xSemaphoreTake(state_lock, portMAX_DELAY);
        cJSON *result = cJSON_CreateObject();
        cJSON_AddBoolToObject(result, "ok", true);
        cJSON_AddStringToObject(result, "deviceId", config.device_id);
        cJSON_AddBoolToObject(result, "identityConfigured", config.token[0] != 0);
        cJSON_AddStringToObject(result, "serverUrl", config.server_url);
        cJSON_AddStringToObject(result, "firmwareVersion", FIRMWARE_VERSION);
        char fingerprint[65];
        if (config.token[0] && provision_fingerprint(config.token, fingerprint))
            cJSON_AddStringToObject(result, "tokenFingerprint", fingerprint);
        else cJSON_AddNullToObject(result, "tokenFingerprint");
        cJSON_AddBoolToObject(result, "trusted", trust.version == 1);
        cJSON_AddStringToObject(result, "deploymentId", trust.deployment_id);
        cJSON_AddStringToObject(result, "publicKey", trust.public_key);
        xSemaphoreGive(state_lock);
        return result;
    }
    const char *deployment = field(json, "deploymentId"), *key = field(json, "publicKey");
    if (!provision_uuid(deployment) || !provision_public_key(key))
        return reply("deploymentId 需为 UUID，publicKey 需为 P-256 未压缩小写 130 位 hex", NULL);
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (provisioning_busy()) {
        xSemaphoreGive(state_lock);
        return reply("配网恢复中，请稍后写入信任配置", NULL);
    }
    provision_trust_t next = { .version = 1 };
    strcpy(next.deployment_id, deployment);
    strcpy(next.public_key, key);
    esp_err_t result = storage_save_trust(&next);
    if (result == ESP_OK) { trust = next; restart_required = true; }
    xSemaphoreGive(state_lock);
    return reply(result == ESP_OK ? NULL : "信任配置保存失败", "信任配置已保存，请重启");
}

esp_err_t device_hardware_id(char output[13])
{
    uint8_t mac[6];
    esp_err_t result = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (result != ESP_OK) return result;
    snprintf(output, 13, "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return ESP_OK;
}

void device_config_snapshot(device_config_t *output, binding_state_t *owner)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (output) *output = config;
    if (owner) *owner = binding;
    xSemaphoreGive(state_lock);
}

esp_err_t device_change_binding(const char *id)
{
    if (!id || (*id && !provision_uuid(id))) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(state_lock, portMAX_DELAY);
    esp_err_t result = ESP_OK;
    if (strcmp(binding.binding_id, id)) {
        device_config_t next = config;
        next.empty_cup = 0;
        binding_state_t owner = { .version = 1 };
        strcpy(owner.binding_id, id);
        // Clear the old cup durably before writing the new owner. A crash can only clear twice.
        result = storage_save_config(&next);
        cup_config_t cleared;
        cups_init(&cleared, id, 0);
        if (result == ESP_OK) result = storage_save_cups(&cleared);
        if (result == ESP_OK) {
            config = next;
            cups = cleared;
            memset(&cup_setup, 0, sizeof(cup_setup));
            weighing_init(&machine, 0);
            result = storage_save_binding(&owner);
            if (result == ESP_OK) binding = owner;
        }
    }
    xSemaphoreGive(state_lock);
    return result;
}

esp_err_t device_commit_provision(const provision_record_t *record, bool rollback)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    device_config_t next = record->previous;
    binding_state_t owner = record->previous_binding;
    if (!rollback) {
        strcpy(next.ssid, record->candidate.ssid);
        strcpy(next.password, record->candidate.password);
        strcpy(next.server_url, record->candidate.server_url);
        if (record->version == 2) {
            strcpy(next.device_id, record->device_id);
            strcpy(next.token, record->token);
        }
        strcpy(owner.binding_id, record->binding_id);
        if (strcmp(record->previous_binding.binding_id, owner.binding_id)) next.empty_cup = 0;
    }
    cup_config_t next_cups = cups;
    if (strcmp(next_cups.binding_id, owner.binding_id)) cups_init(&next_cups, owner.binding_id, 0);
    next.empty_cup = cups_weight(&next_cups);
    esp_err_t result = storage_save_config(&next);
    if (result == ESP_OK) result = storage_save_cups(&next_cups);
    if (result == ESP_OK) result = storage_save_binding(&owner);
    if (result == ESP_OK) {
        config = next;
        cups = next_cups;
        memset(&cup_setup, 0, sizeof(cup_setup));
        binding = owner;
        weighing_init(&machine, next.empty_cup);
    }
    xSemaphoreGive(state_lock);
    return result;
}

static void serial_task(void *arg)
{
    (void)arg;
    // Storage and radio initialization may fail; wait for a final result before accepting commands.
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    char line[768] = {0};
    unsigned length = 0;
    bool overflow = false;
    for (;;) {
        if (startup_error == ESP_OK) {
            xSemaphoreTake(state_lock, portMAX_DELAY);
            bool reboot = reboot_at_ms && esp_timer_get_time() / 1000 >= reboot_at_ms;
            xSemaphoreGive(state_lock);
            if (reboot) esp_restart();
        }
        int character = coaster_console_read();
        if (character < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        if (character == '\r' || character == '\n') {
            if (overflow) print_json(reply("命令过长，整行已忽略", NULL));
            else if (length) {
                line[length] = 0;
                cJSON *json = cJSON_ParseWithOpts(line, NULL, true);
                const char *name = field(json, "cmd");
                if (startup_error != ESP_OK) {
                    if (name && (!strcmp(name, "status") || !strcmp(name, "diagnostics"))) print_json(diagnostics_json());
                    else print_json(reply("初始化失败：仅允许 status 或 diagnostics，保留 Flash 数据", NULL));
                } else if (name && !strcmp(name, "diagnostics")) print_json(diagnostics_json());
                else if (name && !strcmp(name, "pending-time")) storage_dump_pending_time();
                else if (name && (!strcmp(name, "trust") || !strcmp(name, "factory-info"))) print_json(factory_command(json));
                else if (cJSON_IsObject(json)) print_json(device_command(json));
                else print_json(reply("请输入单行 JSON 命令", NULL));
                cJSON_Delete(json);
            }
            memset(line, 0, sizeof(line));
            length = 0;
            overflow = false;
        } else if (character == 8 || character == 127) {
            if (length) --length;
        } else if (character >= 32 && !overflow) {
            if (length + 1 < sizeof(line)) line[length++] = (char)character;
            else overflow = true;
        }
    }
}

static esp_err_t load_cups(void)
{
    esp_err_t result = storage_load_cups(&cups);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        cups_init(&cups, binding.binding_id, config.empty_cup);
        result = storage_save_cups(&cups);
    } else if (result == ESP_OK && strcmp(cups.binding_id, binding.binding_id)) {
        cups_init(&cups, binding.binding_id, 0);
        result = storage_save_cups(&cups);
    }
    if (result == ESP_OK) config.empty_cup = cups_weight(&cups);
    return result;
}

esp_err_t device_start(void)
{
    esp_err_t result = ESP_ERR_NO_MEM;
    console_println("水伴固件 " FIRMWARE_VERSION " 正在初始化。");
    report_memory("before-init");
    serial_handle = xTaskCreateStatic(serial_task, "coaster-serial", sizeof(serial_stack), NULL, 5,
        serial_stack, &serial_task_buffer);
    if (!serial_handle) goto finished;
    startup_stage = "state-lock";
    state_lock = xSemaphoreCreateMutex();
    if (!state_lock) goto finished;
    startup_stage = "storage";
    result = storage_init(&config, &boot_id);
    if (result != ESP_OK) goto finished;
    startup_stage = "binding";
    result = storage_load_binding(&binding);
    if (result != ESP_OK) goto finished;
    startup_stage = "cups";
    result = load_cups();
    if (result != ESP_OK) goto finished;
    startup_stage = "trust";
    result = storage_load_trust(&trust);
    if (result != ESP_OK) goto finished;
    startup_stage = "provision-recovery";
    result = provisioning_start();
    if (result != ESP_OK) goto finished;
    weighing_init(&machine, config.empty_cup);
    startup_stage = "hx711";
    result = hx711_init(HX711_DOUT_PIN, HX711_SCK_PIN);
    if (result != ESP_OK) goto finished;
    report_memory("before-ble");
    startup_stage = "ble";
    result = ble_provision_start(config.device_id, &trust, !config.ssid[0] || !binding.binding_id[0]);
    if (result != ESP_OK) goto finished;
    report_memory("before-network");
    startup_stage = "network";
    result = network_start(&config);
    if (result != ESP_OK) goto finished;
    startup_stage = "sampling";
    if (!xTaskCreateStatic(sample_task, "coaster-sampling", sizeof(sampling_stack), NULL, 6,
        sampling_stack, &sampling_task_buffer)) {
        result = ESP_ERR_NO_MEM;
        goto finished;
    }
    startup_stage = "ready";
finished:
    startup_error = result;
    report_memory(startup_stage);
    if (result == ESP_OK) console_println("水伴固件 " FIRMWARE_VERSION " 已启动；发送 {\"cmd\":\"status\"} 查看状态。");
    else {
        char message[192];
        snprintf(message, sizeof(message), "启动失败[%s]: %s；发送 {\"cmd\":\"diagnostics\"} 查看内存，保留 Flash 数据。",
            startup_stage, esp_err_to_name(result));
        console_println(message);
    }
    if (serial_handle) xTaskNotifyGive(serial_handle);
    return result;
}
