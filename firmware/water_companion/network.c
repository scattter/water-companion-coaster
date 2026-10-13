#include "network.h"
#include "device.h"
#include "console.h"
#include "control.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define CONNECTED BIT0
static EventGroupHandle_t wifi_state;
static SemaphoreHandle_t wifi_lock;
static device_config_t settings;
static const char *TAG = "coaster-network";
static portMUX_TYPE status_lock = portMUX_INITIALIZER_UNLOCKED;
static network_status_t network_status;
static uint32_t connection_generation;
static int64_t last_confirmed_ms;

typedef struct {
    char data[2048];
    size_t length;
    bool overflow;
} response_buffer_t;

bool network_has_time(void)
{
    return time(NULL) >= 1704067200; // 2024-01-01；避免把冷启动时间记成 1970 年。
}

int64_t network_epoch_ms(void)
{
    struct timeval now;
    gettimeofday(&now, NULL);
    return (int64_t)now.tv_sec * 1000 + now.tv_usec / 1000;
}

bool network_set_time(int64_t epoch_ms)
{
    if (epoch_ms < 1704067200000LL || epoch_ms >= 4102444800000LL) return false;
    if (network_has_time()) return true;
    struct timeval now = { .tv_sec = epoch_ms / 1000, .tv_usec = (epoch_ms % 1000) * 1000 };
    return settimeofday(&now, NULL) == 0;
}

void network_snapshot(network_status_t *status)
{
    portENTER_CRITICAL(&status_lock);
    *status = network_status;
    int64_t confirmed = last_confirmed_ms;
    portEXIT_CRITICAL(&status_lock);
    status->server_connected = status->server_connected && status->wifi_connected
        && esp_timer_get_time() / 1000 - confirmed <= 15000;
    status->waiting_for_time = status->server_configured
        && strncmp(settings.server_url, "https://", 8) == 0 && !network_has_time();
}

static esp_err_t on_http(esp_http_client_event_t *event)
{
    response_buffer_t *response = event->user_data;
    if (event->event_id == HTTP_EVENT_ON_DATA && event->data_len > 0) {
        if (response->length + event->data_len >= sizeof(response->data)) {
            response->overflow = true;
            return ESP_ERR_INVALID_SIZE;
        }
        memcpy(response->data + response->length, event->data, event->data_len);
        response->length += event->data_len;
        response->data[response->length] = '\0';
    }
    return ESP_OK;
}

static esp_err_t post(const char *path, const cJSON *body, cJSON **reply, int *http_status)
{
    *reply = NULL;
    if (http_status) *http_status = 0;
    char url[256], authorization[144];
    snprintf(url, sizeof(url), "%s%s", settings.server_url, path);
    snprintf(authorization, sizeof(authorization), "Bearer %s", settings.token);
    char *json = cJSON_PrintUnformatted(body);
    if (!json) return ESP_ERR_NO_MEM;
    response_buffer_t response = {0};
    esp_http_client_config_t config = {
        .url = url, .method = HTTP_METHOD_POST, .timeout_ms = 2000,
        .event_handler = on_http, .user_data = &response,
        .disable_auto_redirect = true, .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) { cJSON_free(json); return ESP_ERR_NO_MEM; }
    esp_err_t result = esp_http_client_set_header(client, "Content-Type", "application/json");
    if (result == ESP_OK) result = esp_http_client_set_header(client, "Authorization", authorization);
    if (result == ESP_OK) result = esp_http_client_set_header(client, "X-Device-ID", settings.device_id);
    if (result == ESP_OK) result = esp_http_client_set_post_field(client, json, strlen(json));
    if (result == ESP_OK) result = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    if (http_status) *http_status = status;
    esp_http_client_cleanup(client);
    cJSON_free(json);
    memset(authorization, 0, sizeof(authorization));
    if (result != ESP_OK) return result;
    if (status != 200 || response.overflow) {
        ESP_LOGW(TAG, "设备上报失败：HTTP %d", status);
        return ESP_ERR_INVALID_RESPONSE;
    }
    *reply = cJSON_Parse(response.data);
    if (cJSON_IsObject(*reply)) return ESP_OK;
    cJSON_Delete(*reply);
    *reply = NULL;
    return ESP_ERR_INVALID_RESPONSE;
}

static void heartbeat(void)
{
    portENTER_CRITICAL(&status_lock);
    uint32_t generation = connection_generation;
    portEXIT_CRITICAL(&status_lock);
    device_status_t status;
    device_snapshot(&status);
    unsigned pending, time_pending;
    storage_counts(&pending, &time_pending);
    cJSON *body = cJSON_CreateObject(), *reply = NULL;
    if (!body) return;
    if (status.sensor_ready && status.calibrated && isfinite(status.weight)
        && status.weight >= -2000 && status.weight <= 4000)
        cJSON_AddNumberToObject(body, "weightGrams", roundf(status.weight * 10) / 10);
    else cJSON_AddNullToObject(body, "weightGrams");
    cJSON_AddBoolToObject(body, "stable", status.stable);
    cJSON_AddBoolToObject(body, "cupPresent", status.cup_present);
    cJSON_AddStringToObject(body, "source", "hx711");
    cJSON_AddBoolToObject(body, "calibrated", status.calibrated);
    if (status.empty_cup >= 5) cJSON_AddNumberToObject(body, "emptyCupGrams", status.empty_cup);
    else cJSON_AddNullToObject(body, "emptyCupGrams");
    cJSON_AddNumberToObject(body, "pendingCount", pending + (status.unsaved_event ? 1 : 0));
    cJSON_AddNumberToObject(body, "timePendingCount", time_pending);
    cJSON_AddBoolToObject(body, "clockSynced", network_has_time());
    if (status.error) cJSON_AddStringToObject(body, "error", status.error);
    else cJSON_AddNullToObject(body, "error");
    cJSON_AddStringToObject(body, "firmwareVersion", FIRMWARE_VERSION);
    int http_status;
    esp_err_t result = post("/api/device/heartbeat", body, &reply, &http_status);
    bool confirmed = result == ESP_OK && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply, "ok"));
    if (!confirmed && result == ESP_OK) result = ESP_ERR_INVALID_RESPONSE;
    portENTER_CRITICAL(&status_lock);
    // 断线前发出的请求不能把重新连接后的状态误标为成功。
    if (generation == connection_generation && network_status.wifi_connected) {
        network_status.server_connected = confirmed;
        network_status.server_error = result;
        network_status.http_status = http_status;
        if (confirmed) last_confirmed_ms = esp_timer_get_time() / 1000;
    }
    portEXIT_CRITICAL(&status_lock);
    if (confirmed) {
        cJSON *server_time = cJSON_GetObjectItemCaseSensitive(reply, "serverTimeMs");
        // 局域网调试可用电脑时间启动时钟；HTTPS 需先由 SNTP 或手机完成校时。
        if (!network_has_time() && cJSON_IsNumber(server_time)
            && server_time->valuedouble >= 1704067200000.0 && server_time->valuedouble < 4102444800000.0) {
            network_set_time((int64_t)server_time->valuedouble);
        }
    } else ESP_LOGW(TAG, "心跳未确认：%s", esp_err_to_name(result));
    cJSON_Delete(reply);
    cJSON_Delete(body);
}

static esp_err_t upload_one(void)
{
    saved_event_t event;
    uint32_t sequence;
    int64_t offset = network_has_time() ? network_epoch_ms() - esp_timer_get_time() / 1000 : 0;
    esp_err_t result = storage_next(&event, &sequence, offset);
    if (result == ESP_ERR_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    time_t seconds = (time_t)(event.epoch_ms / 1000);
    struct tm utc;
    if (!gmtime_r(&seconds, &utc)) return ESP_ERR_INVALID_STATE;
    char base[24], occurred_at[32];
    strftime(base, sizeof(base), "%Y-%m-%dT%H:%M:%S", &utc);
    snprintf(occurred_at, sizeof(occurred_at), "%s.%03dZ", base, (int)(event.epoch_ms % 1000));
    cJSON *body = cJSON_CreateObject(), *entries = cJSON_CreateArray(), *item = cJSON_CreateObject();
    if (!body || !entries || !item) {
        cJSON_Delete(body); cJSON_Delete(entries); cJSON_Delete(item);
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddItemToObject(body, "events", entries);
    cJSON_AddItemToArray(entries, item);
    cJSON_AddStringToObject(item, "id", event.id);
    cJSON_AddStringToObject(item, "kind", event.change.drink ? "drink" : "refill");
    cJSON_AddNumberToObject(item, "amountMl", roundf(event.change.amount * 10) / 10);
    cJSON_AddNumberToObject(item, "beforeGrams", roundf(event.change.before * 10) / 10);
    cJSON_AddNumberToObject(item, "afterGrams", roundf(event.change.after * 10) / 10);
    cJSON_AddStringToObject(item, "occurredAt", occurred_at);
    cJSON *reply = NULL;
    result = post("/api/device/events", body, &reply, NULL);
    if (result == ESP_OK) {
        cJSON *ids = cJSON_GetObjectItemCaseSensitive(reply, "acknowledged");
        bool acknowledged = false;
        if (cJSON_IsArray(ids)) {
            cJSON *id;
            cJSON_ArrayForEach(id, ids) {
                if (cJSON_IsString(id) && strcmp(id->valuestring, event.id) == 0) acknowledged = true;
            }
        }
        result = acknowledged ? storage_ack(sequence) : ESP_ERR_INVALID_RESPONSE;
    }
    cJSON_Delete(reply);
    cJSON_Delete(body);
    return result;
}

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && (id == WIFI_EVENT_AP_START || id == WIFI_EVENT_AP_STOP)) {
        portENTER_CRITICAL(&status_lock);
        network_status.ap_ready = id == WIFI_EVENT_AP_START;
        portEXIT_CRITICAL(&status_lock);
    }
    if ((base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED)
        || (base == IP_EVENT && id == IP_EVENT_STA_LOST_IP)) {
        int reason = base == WIFI_EVENT ? ((wifi_event_sta_disconnected_t *)data)->reason : 0;
        xEventGroupClearBits(wifi_state, CONNECTED);
        portENTER_CRITICAL(&status_lock);
        ++connection_generation;
        network_status.wifi_connected = false;
        network_status.server_connected = false;
        network_status.wifi_reason = reason;
        network_status.http_status = 0;
        network_status.server_error = ESP_OK;
        network_status.ip[0] = '\0';
        portEXIT_CRITICAL(&status_lock);
    }
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *event = data;
        char ip[16];
        snprintf(ip, sizeof(ip), IPSTR, IP2STR(&event->ip_info.ip));
        portENTER_CRITICAL(&status_lock);
        network_status.wifi_connected = true;
        network_status.wifi_reason = 0;
        memcpy(network_status.ip, ip, sizeof(ip));
        portEXIT_CRITICAL(&status_lock);
        xEventGroupSetBits(wifi_state, CONNECTED);
    }
}

esp_err_t network_scan(wifi_ap_record_t *records, uint16_t *count)
{
    if (!records || !count || !*count) return ESP_ERR_INVALID_ARG;
    if (!wifi_lock) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(wifi_lock, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_WIFI_STATE;
    // 扫描期间不发起自动重连；已有连接保持，正在连接时由页面提示稍后重试。
    esp_err_t result = esp_wifi_scan_start(NULL, true);
    if (result == ESP_OK) {
        result = esp_wifi_scan_get_ap_records(count, records);
        if (result != ESP_OK) esp_wifi_clear_ap_list();
    } else if (result == ESP_ERR_WIFI_TIMEOUT) {
        esp_wifi_scan_stop();
        esp_wifi_clear_ap_list();
    }
    xSemaphoreGive(wifi_lock);
    return result;
}

static void network_task(void *arg)
{
    (void)arg;
    int64_t last_connect = -5000, last_heartbeat = -5000, next_upload = 0;
    unsigned backoff_ms = 1000;
    for (;;) {
        int64_t now = esp_timer_get_time() / 1000;
        if (network_has_time()) storage_resolve_time(network_epoch_ms() - now);
        if (settings.ssid[0] && !(xEventGroupGetBits(wifi_state) & CONNECTED)) {
            if ((last_connect < 0 || now - last_connect >= 30000)
                && xSemaphoreTake(wifi_lock, 0) == pdTRUE) {
                esp_wifi_connect();
                last_connect = now;
                xSemaphoreGive(wifi_lock);
            }
        } else if ((xEventGroupGetBits(wifi_state) & CONNECTED) && settings.server_url[0] && settings.token[0]
            && (strncmp(settings.server_url, "https://", 8) != 0 || network_has_time())) {
            if (now - last_heartbeat >= 5000) {
                heartbeat();
                last_heartbeat = now;
            }
            if (now >= next_upload) {
                esp_err_t result = upload_one();
                if (result == ESP_OK) backoff_ms = 1000;
                else {
                    ESP_LOGW(TAG, "记录尚未确认，保留重试：%s", esp_err_to_name(result));
                    if (backoff_ms < 30000) backoff_ms = backoff_ms * 2 > 30000 ? 30000 : backoff_ms * 2;
                }
                next_upload = now + (result == ESP_OK ? 500 : backoff_ms);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}

static esp_err_t start_wifi(void)
{
    wifi_state = xEventGroupCreate();
    ESP_RETURN_ON_ERROR(wifi_state ? ESP_OK : ESP_ERR_NO_MEM, TAG, "创建网络状态失败");
    wifi_lock = xSemaphoreCreateMutex();
    ESP_RETURN_ON_ERROR(wifi_lock ? ESP_OK : ESP_ERR_NO_MEM, TAG, "创建 Wi-Fi 锁失败");
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "网络接口初始化失败");
    ESP_RETURN_ON_ERROR(esp_event_loop_create_default(), TAG, "网络事件初始化失败");
    esp_netif_t *ap = esp_netif_create_default_wifi_ap();
    ESP_RETURN_ON_ERROR(ap ? ESP_OK : ESP_ERR_NO_MEM, TAG, "创建热点失败");
    esp_netif_ip_info_t ap_ip = {0};
    esp_netif_str_to_ip4(CONTROL_IP, &ap_ip.ip);
    esp_netif_str_to_ip4(CONTROL_IP, &ap_ip.gw);
    esp_netif_str_to_ip4("255.255.255.0", &ap_ip.netmask);
    ESP_RETURN_ON_ERROR(esp_netif_dhcps_stop(ap), TAG, "停止热点 DHCP 失败");
    ESP_RETURN_ON_ERROR(esp_netif_set_ip_info(ap, &ap_ip), TAG, "设置热点地址失败");
    ESP_RETURN_ON_ERROR(esp_netif_dhcps_start(ap), TAG, "启动热点 DHCP 失败");
    ESP_RETURN_ON_ERROR(esp_netif_create_default_wifi_sta() ? ESP_OK : ESP_ERR_NO_MEM, TAG, "创建 Wi-Fi 接口失败");
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "Wi-Fi 初始化失败");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "设置 Wi-Fi 存储失败");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL), TAG, "注册 Wi-Fi 事件失败");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL), TAG, "注册 IP 事件失败");
    uint8_t mac[6];
    ESP_RETURN_ON_ERROR(esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP), TAG, "读取热点编号失败");
    char ssid[17];
    snprintf(ssid, sizeof(ssid), "Water-%02X%02X%02X", mac[3], mac[4], mac[5]);
    wifi_config_t hotspot = {0};
    strcpy((char *)hotspot.ap.ssid, ssid);
    strcpy((char *)hotspot.ap.password, CONTROL_PASSWORD);
    hotspot.ap.ssid_len = strlen(ssid);
    hotspot.ap.channel = 1;
    hotspot.ap.max_connection = 2;
    hotspot.ap.authmode = WIFI_AUTH_WPA2_PSK;
    portENTER_CRITICAL(&status_lock);
    strcpy(network_status.ap_ssid, ssid);
    strcpy(network_status.ap_password, CONTROL_PASSWORD);
    portEXIT_CRITICAL(&status_lock);
    wifi_config_t wifi = {0};
    memcpy(wifi.sta.ssid, settings.ssid, strlen(settings.ssid));
    memcpy(wifi.sta.password, settings.password, strlen(settings.password));
    wifi.sta.pmf_cfg.capable = true;
    // 扫描依赖 STA 接口；未配网时也保留 AP+STA，但不主动连接路由器。
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_APSTA), TAG, "设置 Wi-Fi 模式失败");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_AP, &hotspot), TAG, "设置热点失败");
    if (settings.ssid[0])
        ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wifi), TAG, "设置 Wi-Fi 参数失败");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "启动 Wi-Fi 失败");
    esp_err_t control_result = control_start();
    portENTER_CRITICAL(&status_lock);
    network_status.control_error = control_result;
    portEXIT_CRITICAL(&status_lock);
    if (control_result != ESP_OK) ESP_LOGE(TAG, "手机控制页启动失败：%s", esp_err_to_name(control_result));
    if (settings.ssid[0]) {
        esp_sntp_config_t time_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
        esp_err_t time_result = esp_netif_sntp_init(&time_config);
        if (time_result != ESP_OK) ESP_LOGW(TAG, "校时服务初始化失败：%s", esp_err_to_name(time_result));
    }
    return xTaskCreate(network_task, "coaster-network", 8192, NULL, 4, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

void network_start(const device_config_t *config)
{
    settings = *config;
    portENTER_CRITICAL(&status_lock);
    network_status.wifi_configured = settings.ssid[0] != '\0';
    strcpy(network_status.wifi_ssid, settings.ssid);
    network_status.server_configured = settings.server_url[0] && settings.token[0];
    portEXIT_CRITICAL(&status_lock);
    esp_err_t result = start_wifi();
    portENTER_CRITICAL(&status_lock);
    network_status.wifi_error = result;
    portEXIT_CRITICAL(&status_lock);
    if (result != ESP_OK) {
        char message[96];
        snprintf(message, sizeof(message), "联网初始化失败：%s；请查看屏幕或串口。", esp_err_to_name(result));
        console_println(message);
    } else {
        console_println("手机连接屏幕上的 Water- 热点，浏览器打开 http://" CONTROL_IP "；无路由器也可控制和记录。");
    }
}
