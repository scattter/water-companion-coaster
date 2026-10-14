#pragma once
#include "provision_protocol.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    bool window_open;
    bool pairing;
    uint32_t passkey;
    char stage[24];
} ble_provision_display_t;
esp_err_t ble_provision_start(const char *device_id, const provision_trust_t *trust, bool initial_window);
void ble_provision_open(void);
void ble_provision_poll(void);
void ble_provision_snapshot(ble_provision_display_t *status);
void ble_provision_status(const char *operation_id, const char *stage, const char *message, const char *code);
#ifdef __cplusplus
}
#endif
