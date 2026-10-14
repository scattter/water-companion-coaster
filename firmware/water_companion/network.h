#pragma once
#include "storage.h"
#include "esp_wifi.h"
#include "cJSON.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool wifi_configured;
    bool server_configured;
    bool wifi_connected;
    bool server_connected;
    bool waiting_for_time;
    bool ap_ready;
    bool bound;
    bool wifi_trial;
    bool wifi_rollback;
    char binding_code[9];
    int64_t binding_expires_at;
    char cloud_url[192];
    int wifi_reason;
    int http_status;
    esp_err_t wifi_error;
    esp_err_t server_error;
    esp_err_t control_error;
    char ip[16];
    char wifi_ssid[33];
    char ap_ssid[17];
    char ap_password[13];
} network_status_t;

#define CONTROL_IP "192.168.4.1"


esp_err_t network_provision_request(const char *origin, const char *path, const cJSON *body, cJSON **reply, int *http_status);
esp_err_t network_use_wifi(const char *ssid, const char *password);
void network_apply_config(const device_config_t *config);
void network_start(const device_config_t *config);
void network_provision(void);
esp_err_t network_request_binding(void);
void network_snapshot(network_status_t *status);
esp_err_t network_scan(wifi_ap_record_t *records, uint16_t *count);
bool network_has_time(void);
int64_t network_epoch_ms(void);
bool network_set_time(int64_t epoch_ms);

#ifdef __cplusplus
}
#endif
