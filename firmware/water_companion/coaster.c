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
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "sdkconfig.h"
#include "device.h"
#include "hx711.h"
#include "network.h"
#include "storage.h"
#include "weighing.h"

static SemaphoreHandle_t state_lock;
static device_config_t config;
static weighing_t machine;
static uint64_t boot_id;
static int32_t raw_samples[WEIGHING_SAMPLES];
static unsigned raw_count, raw_next;
static int64_t last_sample_ms;
static bool sensor_ready, unsaved_event, watch, restart_required;
static int64_t reboot_at_ms;
static saved_event_t pending_event;
static float weight = NAN;

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

void device_snapshot(device_status_t *status)
{
    xSemaphoreTake(state_lock, portMAX_DELAY);
    bool fresh = sensor_ready && esp_timer_get_time() / 1000 - last_sample_ms <= 500;
    *status = (device_status_t){
        .sensor_ready = fresh, .calibrated = config.calibrated, .weight = weight,
        .empty_cup = config.empty_cup, .stable = fresh && machine.stable && !unsaved_event,
        .cup_present = fresh && config.calibrated && isfinite(weight) && weight > 5,
        .unsaved_event = unsaved_event, .raw_ready = fresh && raw_count > 0,
        .restart_required = restart_required,
        .raw = raw_count ? raw_samples[(raw_next + WEIGHING_SAMPLES - 1) % WEIGHING_SAMPLES] : 0,
    };
    if (!fresh) status->error = "HX711 未就绪，请检查接线和供电";
    else if (unsaved_event) status->error = "事件保存失败或缓存已满，已暂停识别";
    else if (restart_required) status->error = "联网设置已保存，请重启设备";
    else if (!config.calibrated) status->error = "出厂标定异常，请联系售后";
    else if (config.empty_cup < 5) status->error = "请先登记空杯重量";
    else if (!isfinite(weight) || weight < -2 || weight > WEIGHING_MAX_GRAMS)
        status->error = "重量超出有效范围，请检查承重和校准";
    xSemaphoreGive(state_lock);
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
        if (result != ESP_OK) {
            sensor_ready = false;
            raw_count = raw_next = 0;
            weight = NAN;
            weighing_init(&machine, config.empty_cup);
        } else {
            if (sensor_ready && now - last_sample_ms > 350) raw_count = raw_next = 0;
            sensor_ready = true;
            last_sample_ms = now;
            raw_samples[raw_next] = raw;
            raw_next = (raw_next + 1) % WEIGHING_SAMPLES;
            if (raw_count < WEIGHING_SAMPLES) ++raw_count;
            weight = config.calibrated ? (float)((raw - (double)config.zero) / config.counts_per_gram) : NAN;
            if (unsaved_event) {
                unsaved_event = storage_append(&pending_event) != ESP_OK;
                weighing_init(&machine, config.empty_cup);
            } else if (config.calibrated && config.empty_cup >= 5 && !restart_required) {
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

cJSON *device_command(const cJSON *json)
{
    const char *name = field(json, "cmd");
    if (!name) return reply("缺少 cmd", NULL);
    if (!strcmp(name, "status")) return device_status_json();
    xSemaphoreTake(state_lock, portMAX_DELAY);
    if (!strcmp(name, "watch")) {
        const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(json, "enabled");
        cJSON *response;
        if (!cJSON_IsBool(enabled)) response = reply("enabled 必须为布尔值", NULL);
        else { watch = cJSON_IsTrue(enabled); response = reply(NULL, watch ? "已开启实时读数" : "已关闭实时读数"); }
        xSemaphoreGive(state_lock);
        return response;
    }
    if (unsaved_event || reboot_at_ms) {
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
        const char *url = field(json, "url"), *id = field(json, "id"), *token = field(json, "token");
        bool token_valid = token && strlen(token) >= 16 && strlen(token) <= 128;
        if (token_valid) {
            for (const unsigned char *p = (const unsigned char *)token; *p; ++p)
                if (*p < 33 || *p > 126) token_valid = false;
        }
        if (!valid_url(url) || !valid_id(id) || !token_valid)
            error = "需提供 HTTPS 地址或局域网 IPv4 HTTP 地址、设备编号及 16–128 位凭证；地址不带路径";
        else {
            strcpy(next.server_url, url);
            size_t length = strlen(next.server_url);
            if (next.server_url[length - 1] == '/') next.server_url[length - 1] = 0;
            strcpy(next.device_id, id);
            strcpy(next.token, token);
            unsigned pending, time_pending;
            storage_counts(&pending, &time_pending);
            if (pending && strcmp(next.device_id, config.device_id))
                error = "仍有待处理记录，上传完成前不能修改设备编号";
        }
    } else if (!strcmp(name, "tare") || !strcmp(name, "calibrate") || !strcmp(name, "cup")) {
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
        } else if (!config.calibrated) error = "出厂标定异常，请联系售后";
        else {
            double grams = (average - config.zero) / config.counts_per_gram;
            if (grams < 5 || grams > 1995 || spread > fabs(config.counts_per_gram))
                error = "空杯重量超出范围或尚未稳定";
            else {
                next.empty_cup = roundf((float)grams * 10) / 10;
                reset_weighing = true;
                message = "空杯重量已保存，可以加水后开始正常取放";
            }
        }
    } else error = "未知命令：status、watch、wifi、server、tare、calibrate、cup、pending-time、reboot";
    if (!error) {
        esp_err_t result = storage_save_config(&next);
        if (result != ESP_OK) error = "配置写入失败；请保留设备数据并检查 Flash";
        else {
            config = next;
            if (!strcmp(name, "wifi") || !strcmp(name, "server")) restart_required = true;
            if (reset_weighing || restart_required) weighing_init(&machine, config.empty_cup);
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

static void serial_task(void *arg)
{
    (void)arg;
    char line[768] = {0};
    unsigned length = 0;
    bool overflow = false;
    for (;;) {
        xSemaphoreTake(state_lock, portMAX_DELAY);
        bool reboot = reboot_at_ms && esp_timer_get_time() / 1000 >= reboot_at_ms;
        xSemaphoreGive(state_lock);
        if (reboot) esp_restart();
        int character = coaster_console_read();
        if (character < 0) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (character == '\r' || character == '\n') {
            if (overflow) print_json(reply("命令过长，整行已忽略", NULL));
            else if (length) {
                line[length] = 0;
                cJSON *json = cJSON_ParseWithOpts(line, NULL, true);
                const char *name = field(json, "cmd");
                if (name && !strcmp(name, "pending-time")) storage_dump_pending_time();
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

esp_err_t device_start(void)
{
    state_lock = xSemaphoreCreateMutex();
    if (!state_lock) return ESP_ERR_NO_MEM;
    esp_err_t result = storage_init(&config, &boot_id);
    if (result != ESP_OK) return result;
    weighing_init(&machine, config.empty_cup);
    result = hx711_init(HX711_DOUT_PIN, HX711_SCK_PIN);
    if (result != ESP_OK) return result;
    char message[192];
    snprintf(message, sizeof(message), "水伴固件 " FIRMWARE_VERSION " 已启动：微雪 ESP32-S3-LCD-1.47B，"
             "HX711 DOUT=GP%d、SCK=GP%d。", HX711_DOUT_PIN, HX711_SCK_PIN);
    console_println(message);
    console_println("通过 Type-C USB 串口输入 {\"cmd\":\"status\"} 查看真实采样。");
    network_start(&config);
    ESP_ERROR_CHECK(xTaskCreate(sample_task, "coaster-sampling", 4096, NULL, 6, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    ESP_ERROR_CHECK(xTaskCreate(serial_task, "coaster-serial", 8192, NULL, 5, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    return ESP_OK;
}
