#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PROVISION_MESSAGE_MAX 4096
#define PROVISION_CHALLENGE_MS 300000LL
#define PROVISION_WINDOW_MS 600000LL
#define PROVISION_FRAME_MS 10000LL
#define PROVISION_SERVICE_UUID "7d2a0001-7b9c-4e6a-9f21-531bd67a0c10"
#define PROVISION_INFO_UUID "7d2a0002-7b9c-4e6a-9f21-531bd67a0c10"
#define PROVISION_CONFIG_UUID "7d2a0003-7b9c-4e6a-9f21-531bd67a0c10"
#define PROVISION_STATUS_UUID "7d2a0004-7b9c-4e6a-9f21-531bd67a0c10"
#define PROVISION_WIFI_UUID "7d2a0005-7b9c-4e6a-9f21-531bd67a0c10"

typedef struct {
    uint32_t version;
    char deployment_id[37];
    char public_key[131];
} provision_trust_t;

typedef struct {
    uint32_t version;
    char binding_id[37];
} binding_state_t;

typedef struct {
    char operation_id[37];
    char ssid[33];
    char password[65];
    char server_url[192];
    char ticket[65];
    uint64_t config_version;
    int64_t expires_at_ms;
} provision_candidate_t;

typedef struct {
    char data[PROVISION_MESSAGE_MAX + 1];
    size_t length;
    uint16_t next_sequence;
    int64_t started_ms;
    bool active;
} provision_frames_t;

typedef enum { PROVISION_FRAME_ERROR = -1, PROVISION_FRAME_MORE, PROVISION_FRAME_DONE } provision_frame_result_t;

#ifdef __cplusplus
extern "C" {
#endif
bool provision_uuid(const char *value);
bool provision_hex(const char *value, size_t bytes, uint8_t *output);
bool provision_origin(const char *value);
bool enrollment_origin(const char *value);
bool provision_fresh(int64_t now_ms, int64_t challenge_ms, int64_t window_until_ms);
void provision_frames_reset(provision_frames_t *frames);
provision_frame_result_t provision_frame(provision_frames_t *frames, const uint8_t *data, size_t size, int64_t now_ms);
/* Parses the exact signed LF-delimited bytes. Does not perform cryptography. */
bool provision_payload(const char *payload, const provision_trust_t *trust, const char *device_id,
    const char *challenge, const char *operation_id, int64_t epoch_ms, provision_candidate_t *candidate);
bool provision_verify_signature(const char *payload, const char *signature, const char *public_key);
bool provision_public_key(const char *public_key);
bool provision_fingerprint(const char *text, char output[65]);
bool provision_identity_proof(const char *token, const char *operation, const char *hardware, const char *ticket, char output[65]);
#ifdef __cplusplus
}
#endif
