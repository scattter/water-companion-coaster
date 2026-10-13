#pragma once
#include "storage.h"
#include "esp_wifi.h"

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
#define CONTROL_PASSWORD "12345678"

void network_start(const device_config_t *config);
void network_snapshot(network_status_t *status);
esp_err_t network_scan(wifi_ap_record_t *records, uint16_t *count);
bool network_has_time(void);
int64_t network_epoch_ms(void);
bool network_set_time(int64_t epoch_ms);

#ifdef __cplusplus
}
#endif
