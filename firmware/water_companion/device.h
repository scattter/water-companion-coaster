#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "cJSON.h"

#define FIRMWARE_VERSION "0.5.0"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    bool sensor_ready;
    bool calibrated;
    bool stable;
    bool cup_present;
    bool unsaved_event;
    bool restart_required;
    bool raw_ready;
    int32_t raw;
    float weight;
    float empty_cup;
    const char *error;
} device_status_t;

void device_snapshot(device_status_t *status);
cJSON *device_status_json(void);
cJSON *device_command(const cJSON *json);
esp_err_t device_save_wifi(const char *ssid, const char *password);
bool device_authorize(const char *id, const char *authorization);
esp_err_t device_start(void);

#ifdef __cplusplus
}
#endif
