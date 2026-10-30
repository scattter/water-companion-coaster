#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "cJSON.h"
#include "storage.h"

#define FIRMWARE_VERSION "0.8.1"
#define DEVICE_IDLE_MS 30000

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
    bool active;
    int32_t raw;
    float weight;
    float empty_cup;
    cup_config_t cups;
    cup_setup_t cup_setup;
    char cup_notice[96];
    const char *error;
} device_status_t;

void device_config_snapshot(device_config_t *config, binding_state_t *binding);
esp_err_t device_hardware_id(char output[13]);
esp_err_t device_change_binding(const char *binding_id);
esp_err_t device_commit_provision(const provision_record_t *record, bool rollback);
void device_snapshot(device_status_t *status);
void device_wake(void);
void device_next_cup(void);
void device_cancel_cup_setup(void);
void device_cups_json(cJSON *json, const device_status_t *status);
cJSON *device_status_json(void);
cJSON *device_command(const cJSON *json);
esp_err_t device_save_wifi(const char *ssid, const char *password);
bool device_authorize(const char *id, const char *authorization);
esp_err_t device_start(void);

#ifdef __cplusplus
}
#endif
