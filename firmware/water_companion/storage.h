#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "weighing.h"
#include "cloud_command.h"
#include "provision_protocol.h"

#define EVENT_CAPACITY 4096
#define CONFIG_VERSION 1
#define EVENT_VERSION 2

typedef struct {
    uint32_t version;
    char ssid[33];
    char password[65];
    char server_url[192];
    char device_id[65];
    char token[129];
    bool zero_set;
    bool calibrated;
    int32_t zero;
    double counts_per_gram;
    float empty_cup;
} device_config_t;

typedef struct {
    uint32_t version;
    char id[37];
    uint64_t boot_id;
    int64_t uptime_ms;
    int64_t epoch_ms;
    weight_change_t change;
} legacy_event_t;

typedef struct {
    uint32_t version;
    char id[37];
    uint64_t boot_id;
    int64_t uptime_ms;
    int64_t epoch_ms;
    weight_change_t change;
    char binding_id[37];
} saved_event_t;

/* A single durable journal authorizes recovery only, never another claim after boot. */
typedef struct {
    uint32_t version;
    uint32_t phase; /* 1 accepted, 2 cloud claimed, 3 locally committed, 4 rollback */
    provision_candidate_t candidate;
    char binding_id[37];
    device_config_t previous;
    binding_state_t previous_binding;
} legacy_provision_record_t;

typedef struct {
    uint32_t version;
    uint32_t phase;
    provision_candidate_t candidate;
    char binding_id[37];
    device_config_t previous;
    binding_state_t previous_binding;
    char hardware_id[13];
    char device_id[65];
    char token[129];
} provision_record_t;

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t storage_load_trust(provision_trust_t *trust);
esp_err_t storage_save_trust(const provision_trust_t *trust);
esp_err_t storage_load_binding(binding_state_t *binding);
esp_err_t storage_save_binding(const binding_state_t *binding);
esp_err_t storage_load_provision(provision_record_t *record);
esp_err_t storage_save_provision(const provision_record_t *record);
esp_err_t storage_clear_provision(void);
esp_err_t storage_init(device_config_t *config, uint64_t *boot_id);
esp_err_t storage_load_command(cloud_command_t *state);
esp_err_t storage_save_command(const cloud_command_t *state);
esp_err_t storage_stage_wifi(const char *ssid, const char *password);
esp_err_t storage_load_wifi(char ssid[33], char password[65]);
esp_err_t storage_clear_wifi(void);
esp_err_t storage_ap_password(char password[13]);
esp_err_t storage_save_config(const device_config_t *config);
esp_err_t storage_resolve_time(int64_t epoch_offset_ms);
esp_err_t storage_append(const saved_event_t *event);
esp_err_t storage_next(saved_event_t *event, uint32_t *sequence, int64_t epoch_offset_ms);
esp_err_t storage_ack(uint32_t sequence);
void storage_counts(unsigned *pending, unsigned *time_pending);
void storage_dump_pending_time(void);

#ifdef __cplusplus
}
#endif
