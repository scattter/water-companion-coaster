#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLESecurity.h>
#include <host/ble_hs.h>
#include <host/ble_hs_mbuf.h>
#include "esp_random.h"
#include "esp_timer.h"
#include "ble_provision.h"
#include "provisioning.h"
#include "cJSON.h"

#if !defined(CONFIG_NIMBLE_ENABLED)
#error "Use the ESP32-S3 Arduino 3.3.11 NimBLE board configuration"
#endif
#if CORE_DEBUG_LEVEL > 0
#error "Core Debug Level must be None: Arduino BLE logs include pairing/configuration bytes"
#endif

static SemaphoreHandle_t mutex;
static BLEServer *server;
static BLECharacteristic *info_characteristic, *status_characteristic;
static uint16_t connection_id = BLE_HS_CONN_HANDLE_NONE;
static bool authenticated, advertising, open_requested, pairing, subscribed;
static uint32_t passkey;
static int64_t window_until_ms, challenge_ms;
static char challenge[65], identity[65];
static provision_trust_t root;
static provision_frames_t frames;
static struct {
    char operation[37], stage[24], message[120], code[40];
    uint32_t sequence;
} current = {"", "idle", "Ready", "", 0};
static uint32_t notified_sequence;

static int64_t now_ms() { return esp_timer_get_time() / 1000; }
static bool open_locked() { return now_ms() < window_until_ms; }

void ble_provision_status(const char *operation, const char *stage, const char *message, const char *code)
{
    // Recovery starts before BLE and before any other task exists.
    if (mutex) xSemaphoreTake(mutex, portMAX_DELAY);
    if (strcmp(current.operation, operation ? operation : "") || strcmp(current.stage, stage)
        || strcmp(current.message, message) || strcmp(current.code, code ? code : "")) {
        snprintf(current.operation, sizeof(current.operation), "%s", operation ? operation : "");
        snprintf(current.stage, sizeof(current.stage), "%s", stage);
        snprintf(current.message, sizeof(current.message), "%s", message);
        snprintf(current.code, sizeof(current.code), "%s", code ? code : "");
        ++current.sequence;
    }
    if (mutex) xSemaphoreGive(mutex);
}

static void characteristic_json(BLECharacteristic *characteristic, cJSON *json)
{
    char *value = cJSON_PrintUnformatted(json);
    if (value) { characteristic->setValue(value); cJSON_free(value); }
    cJSON_Delete(json);
}

class Reads : public BLECharacteristicCallbacks {
    void onRead(BLECharacteristic *characteristic, ble_gap_conn_desc *desc) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        if (!authenticated || desc->conn_handle != connection_id) {
            characteristic->setValue("");
            xSemaphoreGive(mutex);
            return;
        }
        cJSON *json = cJSON_CreateObject();
        if (characteristic == info_characteristic) {
            cJSON_AddNumberToObject(json, "protocolVersion", 1);
            cJSON_AddStringToObject(json, "deviceId", identity);
            cJSON_AddStringToObject(json, "deploymentId", root.deployment_id);
            cJSON_AddStringToObject(json, "challenge", challenge);
            cJSON_AddBoolToObject(json, "trusted", root.version == 1);
        } else {
            cJSON_AddStringToObject(json, "operationId", current.operation);
            cJSON_AddStringToObject(json, "stage", current.stage);
            cJSON_AddStringToObject(json, "message", current.message);
            cJSON_AddNumberToObject(json, "sequence", current.sequence);
            if (current.code[0]) cJSON_AddStringToObject(json, "code", current.code);
        }
        // Arduino NimBLE invokes onRead only on the first part of a long read.
        characteristic_json(characteristic, json);
        xSemaphoreGive(mutex);
    }
    void onSubscribe(BLECharacteristic *, ble_gap_conn_desc *desc, uint16_t value) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        if (desc->conn_handle == connection_id) { subscribed = (value & 1) != 0; notified_sequence = current.sequence - 1; }
        xSemaphoreGive(mutex);
    }
};

class Writes : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *characteristic, ble_gap_conn_desc *desc) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        bool allowed = authenticated && connection_id == desc->conn_handle && open_locked()
            && desc->sec_state.encrypted && desc->sec_state.authenticated;
        if (!allowed || provisioning_busy()) {
            characteristic->setValue("");
            provision_frames_reset(&frames);
            xSemaphoreGive(mutex);
            return;
        }
        String data = characteristic->getValue();
        provision_frame_result_t result = provision_frame(&frames,
            reinterpret_cast<const uint8_t *>(data.c_str()), data.length(), now_ms());
        characteristic->setValue("");
        esp_err_t submitted = ESP_OK;
        if (result == PROVISION_FRAME_DONE) {
            submitted = provisioning_submit(frames.data, challenge, challenge_ms, window_until_ms);
            provision_frames_reset(&frames);
            // Consume once. info keeps the same challenge; reconnect obtains a fresh one.
            if (submitted == ESP_OK) challenge_ms = -PROVISION_CHALLENGE_MS;
        }
        xSemaphoreGive(mutex);
        if (result == PROVISION_FRAME_ERROR) ble_provision_status("", "failed", "Invalid or expired frame", "INVALID_FRAME");
        else if (submitted != ESP_OK) ble_provision_status("", "failed", "Reconnect for a fresh authorization", "CHALLENGE_EXPIRED");
    }
};

class Security : public BLESecurityCallbacks {
    uint32_t onPassKeyRequest() override { return 0; }
    void onPassKeyNotify(uint32_t value) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        passkey = value;
        pairing = open_locked();
        xSemaphoreGive(mutex);
    }
    bool onConfirmPIN(uint32_t) override { return false; }
    bool onSecurityRequest() override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        bool allowed = open_locked() && connection_id != BLE_HS_CONN_HANDLE_NONE;
        xSemaphoreGive(mutex);
        return allowed;
    }
    bool onAuthorizationRequest(uint16_t conn, uint16_t attribute, bool is_read) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        bool allowed = authenticated && conn == connection_id
            && ((is_read && status_characteristic && attribute == status_characteristic->getHandle()) || open_locked());
        xSemaphoreGive(mutex);
        return allowed;
    }
    void onAuthenticationComplete(ble_gap_conn_desc *desc) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        bool same = desc->conn_handle == connection_id;
        bool valid = same && open_locked() && desc->sec_state.encrypted && desc->sec_state.authenticated
            && desc->sec_state.key_size == 16;
        // SC-only is enforced by ble_hs_cfg.sm_sc_only; no legacy pairing fallback.
        if (same) { authenticated = valid; pairing = false; }
        xSemaphoreGive(mutex);
        if (!valid) server->disconnect(desc->conn_handle);
    }
};

class Connections : public BLEServerCallbacks {
    void onConnect(BLEServer *s, ble_gap_conn_desc *desc) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        bool allowed = open_locked() && connection_id == BLE_HS_CONN_HANDLE_NONE;
        if (allowed) {
            connection_id = desc->conn_handle;
            authenticated = pairing = subscribed = advertising = false;
            uint8_t random[32];
            esp_fill_random(random, sizeof(random));
            for (unsigned i = 0; i < sizeof(random); ++i) snprintf(challenge + i * 2, 3, "%02x", random[i]);
            challenge_ms = now_ms();
            provision_frames_reset(&frames);
            uint32_t value;
            do { value = esp_random() % 1000000; } while (value == 123456);
            BLESecurity::setPassKey(true, value);
        }
        xSemaphoreGive(mutex);
        if (!allowed) s->disconnect(desc->conn_handle);
        else BLESecurity::startSecurity(desc->conn_handle);
    }
    void onDisconnect(BLEServer *, ble_gap_conn_desc *desc) override {
        xSemaphoreTake(mutex, portMAX_DELAY);
        if (desc->conn_handle == connection_id) {
            connection_id = BLE_HS_CONN_HANDLE_NONE;
            authenticated = pairing = subscribed = false;
            memset(challenge, 0, sizeof(challenge));
            provision_frames_reset(&frames);
        }
        xSemaphoreGive(mutex);
    }
};

esp_err_t ble_provision_start(const char *device_id, const provision_trust_t *trust, bool initial)
{
    mutex = xSemaphoreCreateMutex();
    if (!mutex) return ESP_ERR_NO_MEM;
    snprintf(identity, sizeof(identity), "%s", device_id);
    root = *trust;
    if (!BLEDevice::init("Water-Coaster")) return ESP_FAIL;
    BLEDevice::setSecurityCallbacks(new Security());
    BLESecurity::setAuthenticationMode(false, true, true); // Fresh physical pairing, no old-owner bonds.
    BLESecurity::setCapability(ESP_IO_CAP_OUT);
    BLESecurity::setKeySize(16);
    BLESecurity::setForceAuthentication(false);
    ble_hs_cfg.sm_sc_only = 1;
    server = BLEDevice::createServer();
    server->advertiseOnDisconnect(false);
    server->setCallbacks(new Connections());
    BLEService *service = server->createService(PROVISION_SERVICE_UUID);
    uint32_t read_permissions = BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_READ_ENC
        | BLECharacteristic::PROPERTY_READ_AUTHEN | BLECharacteristic::PROPERTY_READ_AUTHOR;
    info_characteristic = service->createCharacteristic(PROVISION_INFO_UUID, read_permissions);
    BLECharacteristic *config = service->createCharacteristic(PROVISION_CONFIG_UUID,
        BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_ENC
        | BLECharacteristic::PROPERTY_WRITE_AUTHEN | BLECharacteristic::PROPERTY_WRITE_AUTHOR);
    status_characteristic = service->createCharacteristic(PROVISION_STATUS_UUID,
        read_permissions | BLECharacteristic::PROPERTY_NOTIFY);
    info_characteristic->setCallbacks(new Reads());
    status_characteristic->setCallbacks(new Reads());
    config->setCallbacks(new Writes());
    // NimBLE creates and owns the notification CCCD automatically.
    service->start();
    BLEDevice::getAdvertising()->addServiceUUID(PROVISION_SERVICE_UUID);
    BLEDevice::getAdvertising()->setScanResponse(true);
    if (initial) ble_provision_open();
    return ESP_OK;
}

void ble_provision_open(void)
{
    if (!mutex) return;
    xSemaphoreTake(mutex, portMAX_DELAY);
    open_requested = true;
    xSemaphoreGive(mutex);
}

void ble_provision_poll(void)
{
    if (!mutex) return;
    xSemaphoreTake(mutex, portMAX_DELAY);
    if (open_requested) { window_until_ms = now_ms() + PROVISION_WINDOW_MS; open_requested = false; }
    bool should_advertise = open_locked() && connection_id == BLE_HS_CONN_HANDLE_NONE;
    bool start = should_advertise && !advertising, stop = !should_advertise && advertising;
    advertising = should_advertise;
    if (!open_locked()) { provision_frames_reset(&frames); pairing = false; }
    if (frames.active && now_ms() - frames.started_ms >= PROVISION_FRAME_MS) provision_frames_reset(&frames);
    bool notify = authenticated && subscribed && current.sequence != notified_sequence;
    uint16_t conn = connection_id;
    uint32_t sequence = current.sequence;
    xSemaphoreGive(mutex);
    if (start) BLEDevice::startAdvertising();
    if (stop) BLEDevice::stopAdvertising();
    // A short hint does not replace the long-read snapshot in the characteristic value.
    if (notify) {
        uint8_t hint = 1;
        os_mbuf *buffer = ble_hs_mbuf_from_flat(&hint, 1);
        if (buffer && ble_gatts_notify_custom(conn, status_characteristic->getHandle(), buffer) == 0) {
            xSemaphoreTake(mutex, portMAX_DELAY);
            notified_sequence = sequence;
            xSemaphoreGive(mutex);
        }
    }
}

void ble_provision_snapshot(ble_provision_display_t *status)
{
    memset(status, 0, sizeof(*status));
    if (!mutex) return;
    xSemaphoreTake(mutex, portMAX_DELAY);
    status->window_open = open_locked();
    status->pairing = pairing;
    status->passkey = passkey;
    snprintf(status->stage, sizeof(status->stage), "%s", current.stage);
    xSemaphoreGive(mutex);
}
