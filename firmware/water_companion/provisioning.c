#include "provisioning.h"
#include "ble_provision.h"
#include "device.h"
#include "network.h"
#include "esp_timer.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

/* All persistent and network transitions run on network_task. The BLE task only
 * deposits an immutable message; busy is visible before that task can send again. */
static portMUX_TYPE provision_lock = portMUX_INITIALIZER_UNLOCKED;
static bool busy, inbox_ready;
static struct {
    char json[PROVISION_MESSAGE_MAX + 1];
    char challenge[65];
    int64_t challenge_ms, window_until_ms;
} inbox;
static provision_record_t record;
static enum { P_IDLE, P_INPUT, P_STAGE, P_CONNECT, P_CLAIM, P_QUERY, P_SAVE,
    P_COMPLETE, P_ROLLBACK, P_FINISH } phase;
static bool recovered, query_before_save;
static int64_t next_action_ms, connect_started_ms, acceptance_deadline_ms;
static const char *failure_code = "INTERRUPTED";

bool provisioning_busy(void)
{
    portENTER_CRITICAL(&provision_lock);
    bool value = busy;
    portEXIT_CRITICAL(&provision_lock);
    return value;
}

static void set_busy(bool value)
{
    portENTER_CRITICAL(&provision_lock);
    busy = value;
    portEXIT_CRITICAL(&provision_lock);
}

static void status(const char *stage, const char *message, const char *code)
{
    ble_provision_status(record.candidate.operation_id, stage, message, code);
}

static void release(void)
{
    memset(&record, 0, sizeof(record));
    memset(&inbox, 0, sizeof(inbox));
    phase = P_IDLE;
    inbox_ready = false;
    set_busy(false);
}

esp_err_t provisioning_start(void)
{
    esp_err_t result = storage_load_provision(&record);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result; // Preserve malformed journals for factory diagnosis.
    recovered = true;
    query_before_save = true;
    network_set_time(record.candidate.expires_at_ms - PROVISION_CHALLENGE_MS);
    set_busy(true);
    phase = record.phase == 4 ? P_ROLLBACK : P_STAGE;
    status("recovering", "Resuming accepted operation", NULL);
    return ESP_OK;
}

esp_err_t provisioning_submit(const char *json, const char *challenge, int64_t challenge_ms, int64_t window_until_ms)
{
    if (!json || strlen(json) > PROVISION_MESSAGE_MAX || !provision_hex(challenge, 32, NULL)
        || !provision_fresh(esp_timer_get_time() / 1000, challenge_ms, window_until_ms)) return ESP_ERR_INVALID_ARG;
    portENTER_CRITICAL(&provision_lock);
    bool available = !busy;
    if (available) busy = true;
    portEXIT_CRITICAL(&provision_lock);
    if (!available) return ESP_ERR_INVALID_STATE;
    strcpy(inbox.json, json);
    strcpy(inbox.challenge, challenge);
    inbox.challenge_ms = challenge_ms;
    inbox.window_until_ms = window_until_ms;
    portENTER_CRITICAL(&provision_lock);
    inbox_ready = true;
    portEXIT_CRITICAL(&provision_lock);
    return ESP_OK;
}

static const char *text(const cJSON *object, const char *key)
{
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(object, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}

static bool exact_keys(const cJSON *object, const char *const *keys, unsigned count)
{
    if (!cJSON_IsObject(object)) return false;
    unsigned seen = 0, n = 0;
    for (const cJSON *item = object->child; item; item = item->next) {
        unsigned i;
        for (i = 0; i < count; ++i) if (item->string && !strcmp(item->string, keys[i])) break;
        if (i == count || (seen & (1u << i))) return false;
        seen |= 1u << i;
        ++n;
    }
    return n == count;
}

static bool utf8(const unsigned char *s)
{
    while (*s) {
        uint32_t value = *s++;
        if (value < 128) continue;
        unsigned n;
        uint32_t minimum;
        if (value >= 0xc2 && value <= 0xdf) { n = 1; minimum = 0x80; value &= 31; }
        else if (value >= 0xe0 && value <= 0xef) { n = 2; minimum = 0x800; value &= 15; }
        else if (value >= 0xf0 && value <= 0xf4) { n = 3; minimum = 0x10000; value &= 7; }
        else return false;
        while (n--) { if ((*s & 0xc0) != 0x80) return false; value = (value << 6) | (*s++ & 63); }
        if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    }
    return true;
}

static bool bounded_json(const char *source)
{
    unsigned depth = 0;
    bool string = false, escape = false;
    for (const unsigned char *p = (const unsigned char *)source; *p; ++p) {
        if (string) {
            if (*p < 0x20) return false;
            if (escape) escape = false;
            else if (*p == '\\') escape = true;
            else if (*p == '"') string = false;
        } else if (*p == '"') string = true;
        else if (*p == '{' || *p == '[') { if (++depth > 4) return false; }
        else if (*p == '}' || *p == ']') { if (!depth) return false; --depth; }
    }
    return !string && !depth;
}

static bool accept_input(void)
{
    static const char *const keys[] = {"protocolVersion", "operationId", "ssid", "password", "authorization"};
    static const char *const enrollment_keys[] = {"protocolVersion", "operationId", "ssid", "password", "hardwareId", "challenge", "serverUrl", "ticket", "expiresAt"};
    static const char *const auth_keys[] = {"payload", "signature"};
    // cJSON strings cannot represent embedded NUL. Reject its escape before parsing.
    if (strstr(inbox.json, "\\u0000") || !bounded_json(inbox.json) || !utf8((const unsigned char *)inbox.json)) return false;
    cJSON *json = cJSON_ParseWithOpts(inbox.json, NULL, true);
    const cJSON *version = cJSON_GetObjectItemCaseSensitive(json, "protocolVersion");
    const cJSON *auth = cJSON_GetObjectItemCaseSensitive(json, "authorization");
    const char *operation = text(json, "operationId"), *ssid = text(json, "ssid"), *password = text(json, "password");
    const char *payload = text(auth, "payload"), *signature = text(auth, "signature");
    provision_trust_t trust;
    device_status_t device;
    device_snapshot(&device);
    network_status_t network;
    network_snapshot(&network);
    memset(&record, 0, sizeof(record));
    // Echo only a syntactically valid UUID on rejection; it is not authorization.
    if (provision_uuid(operation)) strcpy(record.candidate.operation_id, operation);
    device_config_snapshot(&record.previous, &record.previous_binding);
    bool valid = cJSON_IsNumber(version) && provision_uuid(operation) && ssid && *ssid && strlen(ssid) <= 32 && password
        && (strlen(password) == 0 || (strlen(password) >= 8 && strlen(password) <= 63))
        && !device.restart_required && !device.unsaved_event && !network.wifi_trial
        && provision_fresh(esp_timer_get_time() / 1000, inbox.challenge_ms, inbox.window_until_ms);
    if (valid && version->valuedouble == 2) {
        const char *hardware = text(json, "hardwareId"), *challenge = text(json, "challenge");
        const char *url = text(json, "serverUrl"), *ticket = text(json, "ticket");
        const cJSON *expires = cJSON_GetObjectItemCaseSensitive(json, "expiresAt");
        valid = exact_keys(json, enrollment_keys, 9) && device_hardware_id(record.hardware_id) == ESP_OK
            && hardware && !strcmp(hardware, record.hardware_id) && challenge && !strcmp(challenge, inbox.challenge)
            && enrollment_origin(url) && provision_hex(ticket, 32, NULL) && cJSON_IsNumber(expires)
            && isfinite(expires->valuedouble) && expires->valuedouble >= 1600000000000.0 && expires->valuedouble <= 4102444800000.0
            && floor(expires->valuedouble) == expires->valuedouble;
        // Existing credentials stay tied to their saved server. Fresh devices establish
        // that address through the physically confirmed, encrypted BLE connection.
        if (valid && record.previous.token[0] && record.previous.server_url[0]
            && strcmp(record.previous.server_url, url)) valid = false;
        if (valid) {
            record.version = 2;
            strcpy(record.candidate.server_url, url);
            strcpy(record.candidate.ticket, ticket);
            record.candidate.expires_at_ms = (int64_t)expires->valuedouble;
        }
    } else if (valid && version->valuedouble == 1) {
        valid = exact_keys(json, keys, 5) && exact_keys(auth, auth_keys, 2) && strlen(record.previous.token) >= 16
            && storage_load_trust(&trust) == ESP_OK && trust.version == 1
            && provision_payload(payload, &trust, record.previous.device_id, inbox.challenge, operation,
                network_has_time() ? network_epoch_ms() : 0, &record.candidate)
            && provision_verify_signature(payload, signature, trust.public_key);
        record.version = 1;
    } else valid = false;
    valid = valid && provision_fresh(esp_timer_get_time() / 1000, inbox.challenge_ms, inbox.window_until_ms);
    if (valid) {
        record.phase = 1;
        strcpy(record.candidate.ssid, ssid);
        strcpy(record.candidate.password, password);
        acceptance_deadline_ms = inbox.challenge_ms + PROVISION_CHALLENGE_MS;
        if (inbox.window_until_ms < acceptance_deadline_ms) acceptance_deadline_ms = inbox.window_until_ms;
        // V2 receives this clock hint over confirmed BLE; the server enforces ticket expiry.
        network_set_time(record.candidate.expires_at_ms - PROVISION_CHALLENGE_MS);
    }
    cJSON_Delete(json);
    memset(&inbox, 0, sizeof(inbox));
    return valid;
}

static void rollback(const char *code)
{
    failure_code = code;
    phase = P_ROLLBACK;
    next_action_ms = 0;
    status("recovering", "Restoring previous configuration", code);
}

static bool cloud_result(const cJSON *reply)
{
    const char *operation = text(reply, "operationId"), *state = text(reply, "status");
    if (!operation || strcmp(operation, record.candidate.operation_id) || !state) return false;
    if (!strcmp(state, "claimed") || !strcmp(state, "completed")) {
        const char *binding = text(reply, "bindingId");
        if (!provision_uuid(binding) || (record.binding_id[0] && strcmp(binding, record.binding_id))) return false;
        if (record.version == 2) {
            const char *hardware = text(reply, "hardwareId"), *id = text(reply, "deviceId"), *token = text(reply, "token");
            if (!hardware || strcmp(hardware, record.hardware_id) || !id || !*id || strlen(id) > 64
                || strspn(id, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != strlen(id)
                || (record.device_id[0] && strcmp(id, record.device_id))) return false;
            if (token) {
                if (!provision_hex(token, 32, NULL)) return false;
                strcpy(record.token, token);
            } else if (!record.token[0] && !strcmp(id, record.previous.device_id)) {
                // An authenticated existing device keeps its credential on Wi-Fi changes.
                strcpy(record.token, record.previous.token);
            }
            if (strlen(record.token) < 16) return false;
            strcpy(record.device_id, id);
        }
        strcpy(record.binding_id, binding);
        record.phase = 2;
        phase = P_SAVE;
        query_before_save = false;
        status("bound", "Cloud binding verified", NULL);
        return true;
    }
    if (!strcmp(state, "issued") || !strcmp(state, "cancelled") || !strcmp(state, "expired") || !strcmp(state, "failed")) {
        rollback(!strcmp(state, "issued") ? "INTERRUPTED" : "OPERATION_CANCELLED");
        return true;
    }
    return false;
}

void provisioning_poll(int64_t now, bool connected)
{
    if (!provisioning_busy()) return;
    portENTER_CRITICAL(&provision_lock);
    bool ready = inbox_ready;
    inbox_ready = false;
    portEXIT_CRITICAL(&provision_lock);
    if (ready) phase = P_INPUT;
    if (now < next_action_ms) return;
    next_action_ms = now + 1000;
    if (phase == P_INPUT) {
        if (!accept_input()) { status("failed", "Authorization or configuration rejected", "INVALID_AUTHORIZATION"); release(); return; }
        // Must be durable before any candidate connection or token-bearing HTTP.
        if (storage_save_provision(&record) != ESP_OK) {
            // An ambiguous flash failure may have written the record; keep busy and clean it durably.
            rollback("STORAGE_FAILED"); return;
        }
        recovered = false;
        query_before_save = false;
        phase = P_STAGE;
        status("received", "Authorized configuration received", NULL);
    }
    if (phase == P_STAGE) {
        network_status_t network;
        network_snapshot(&network);
        if (network.wifi_trial) { rollback("WIFI_TRIAL_ACTIVE"); return; }
        esp_err_t result = network_use_wifi(record.candidate.ssid, record.candidate.password);
        connect_started_ms = now;
        phase = P_CONNECT;
        status(recovered ? "recovering" : "wifi_connecting", "Connecting candidate Wi-Fi", NULL);
        if (result != ESP_OK) next_action_ms = now + 5000;
        return;
    }
    if (phase == P_CONNECT) {
        if (!connected) {
            if (now - connect_started_ms >= 45000) {
                if (!recovered) { rollback("WIFI_FAILED"); return; }
                network_use_wifi(record.candidate.ssid, record.candidate.password);
                connect_started_ms = now;
                status("recovering", "Waiting for candidate network", NULL);
            }
            return;
        }
        phase = recovered ? P_QUERY : P_CLAIM;
    }
    if (phase == P_CLAIM) {
        if (now >= acceptance_deadline_ms || (network_has_time() && network_epoch_ms() >= record.candidate.expires_at_ms)) {
            rollback("AUTHORIZATION_EXPIRED"); return;
        }
        status("cloud_verifying", "Verifying cloud binding", NULL);
        cJSON *body = cJSON_CreateObject(), *reply = NULL;
        cJSON_AddStringToObject(body, "operationId", record.candidate.operation_id);
        cJSON_AddStringToObject(body, "ticket", record.candidate.ticket);
        bool proof_ok = true;
        if (record.version == 2) {
            cJSON_AddStringToObject(body, "hardwareId", record.hardware_id);
            if (record.previous.token[0]) {
                char proof[65];
                proof_ok = provision_identity_proof(record.previous.token, record.candidate.operation_id,
                    record.hardware_id, record.candidate.ticket, proof);
                if (proof_ok) {
                    cJSON_AddStringToObject(body, "deviceId", record.previous.device_id);
                    cJSON_AddStringToObject(body, "identityProof", proof);
                }
                memset(proof, 0, sizeof(proof));
            }
        }
        if (!proof_ok) { cJSON_Delete(body); rollback("INVALID_AUTHORIZATION"); return; }
        // After this point uncertainty is resolved by querying, never another claim.
        phase = P_QUERY;
        recovered = true;
        int http = 0;
        esp_err_t result = !body ? ESP_ERR_NO_MEM : record.version == 2
            ? network_enrollment_request(record.candidate.server_url, "/api/enrollment/claim", body, NULL, NULL, &reply, &http)
            : network_provision_request(record.candidate.server_url, "/api/device/provisioning/claim", body, &reply, &http);
        if (result == ESP_OK) cloud_result(reply);
        else if (http >= 400 && http < 500 && http != 408 && http != 429) rollback("CLAIM_REJECTED");
        cJSON_Delete(body);
        cJSON_Delete(reply);
        return;
    }
    if (phase == P_QUERY || (phase == P_SAVE && query_before_save)) {
        status("recovering", "Querying accepted operation", NULL);
        if (!connected) { phase = P_STAGE; recovered = true; return; }
        char path[96];
        snprintf(path, sizeof(path), "/api/device/provisioning/operations/%s", record.candidate.operation_id);
        cJSON *reply = NULL;
        int http = 0;
        cJSON *query = NULL;
        esp_err_t result;
        if (record.version == 2) {
            query = cJSON_CreateObject();
            cJSON_AddStringToObject(query, "operationId", record.candidate.operation_id);
            cJSON_AddStringToObject(query, "hardwareId", record.hardware_id);
            cJSON_AddStringToObject(query, "ticket", record.candidate.ticket);
            result = query ? network_enrollment_request(record.candidate.server_url, "/api/enrollment/query", query, NULL, NULL, &reply, &http) : ESP_ERR_NO_MEM;
        } else result = network_provision_request(record.candidate.server_url, path, NULL, &reply, &http);
        if (result == ESP_OK) cloud_result(reply);
        else if (http == 404 || http == 409 || http == 410) rollback("OPERATION_CANCELLED");
        cJSON_Delete(query);
        cJSON_Delete(reply);
        next_action_ms = now + 5000;
        return;
    }
    if (phase == P_SAVE) {
        status("saving", "Saving configuration and binding", NULL);
        if (storage_save_provision(&record) != ESP_OK || device_commit_provision(&record, false) != ESP_OK) {
            status("recovering", "Flash save pending; retain power", "STORAGE_FAILED");
            query_before_save = true;
            return;
        }
        record.phase = 3;
        if (storage_save_provision(&record) != ESP_OK) { query_before_save = true; return; }
        phase = P_COMPLETE;
    }
    if (phase == P_COMPLETE) {
        cJSON *body = cJSON_CreateObject(), *reply = NULL;
        cJSON_AddStringToObject(body, "operationId", record.candidate.operation_id);
        cJSON_AddStringToObject(body, "bindingId", record.binding_id);
        int http = 0;
        esp_err_t result = !body ? ESP_ERR_NO_MEM : record.version == 2
            ? network_enrollment_request(record.candidate.server_url, "/api/device/enrollment/complete", body,
                record.device_id, record.token, &reply, &http)
            : network_provision_request(record.candidate.server_url, "/api/device/provisioning/complete", body, &reply, &http);
        const char *state = text(reply, "status");
        if (result == ESP_OK && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(reply, "ok"))
            && state && !strcmp(state, "completed")) phase = P_FINISH;
        else { phase = P_QUERY; status("recovering", "Waiting for cloud completion", NULL); }
        cJSON_Delete(reply);
        cJSON_Delete(body);
        return;
    }
    if (phase == P_FINISH) {
        // USB Wi-Fi staging predates this grouped transaction and must not override it at next boot.
        if (storage_clear_wifi() != ESP_OK || storage_clear_provision() != ESP_OK) {
            status("recovering", "Finalizing saved configuration", "STORAGE_FAILED"); return;
        }
        device_config_t active;
        device_config_snapshot(&active, NULL);
        network_apply_config(&active);
        status("completed", "Configuration saved and binding completed", NULL);
        release();
    } else if (phase == P_ROLLBACK) {
        record.phase = 4;
        if (storage_save_provision(&record) != ESP_OK || device_commit_provision(&record, true) != ESP_OK
            || storage_clear_provision() != ESP_OK) {
            status("recovering", "Rollback save pending; retain power", "STORAGE_FAILED"); return;
        }
        network_apply_config(&record.previous);
        network_use_wifi(record.previous.ssid, record.previous.password);
        status("failed", "Previous configuration restored", failure_code);
        release();
    }
}
