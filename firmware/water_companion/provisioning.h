#pragma once
#include "storage.h"
#include "cJSON.h"
#ifdef __cplusplus
extern "C" {
#endif
esp_err_t provisioning_start(void);
bool provisioning_busy(void);
esp_err_t provisioning_submit(const char *json, const char *challenge, int64_t challenge_ms, int64_t window_until_ms);
/* Called only by the network task; BLE callbacks never perform HTTP/Wi-Fi/NVS work. */
void provisioning_poll(int64_t now_ms, bool wifi_connected);
#ifdef __cplusplus
}
#endif
