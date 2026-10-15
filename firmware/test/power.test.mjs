import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const network = readFileSync(new URL('../water_companion/network.c', import.meta.url), 'utf8');
const device = readFileSync(new URL('../water_companion/coaster.c', import.meta.url), 'utf8');
const display = readFileSync(new URL('../water_companion/display.cpp', import.meta.url), 'utf8');
const ble = readFileSync(new URL('../water_companion/ble_provision.cpp', import.meta.url), 'utf8');
const actual = (source, signature) => {
  const start = source.indexOf(`${signature}(`);
  assert.notEqual(start, -1, signature);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
function run(program) {
  const root = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'power-'));
  try {
    const source = join(dir, 'test.cpp');
    const exe = join(dir, 'test');
    writeFileSync(source, program);
    const compiled = spawnSync(process.env.CXX || 'c++', ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-Wno-missing-field-initializers', source, '-o', exe], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(exe, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const common = `
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
using esp_err_t = int;
enum { ESP_OK, ESP_FAIL, ESP_ERR_NO_MEM, ESP_ERR_INVALID_ARG, ESP_ERR_INVALID_RESPONSE, ESP_ERR_INVALID_SIZE };
#define portENTER_CRITICAL(lock) ((void)(lock))
#define portEXIT_CRITICAL(lock) ((void)(lock))
#define portMAX_DELAY 0
#define pdTRUE 1
#define pdMS_TO_TICKS(ms) (ms)
static int mutex, lock_depth;
[[maybe_unused]] static void xSemaphoreTake(int, int) { assert(lock_depth == 0); ++lock_depth; }
static void xSemaphoreGive(int) { assert(lock_depth == 1); --lock_depth; }
`;

test('network task slows idle reports, backs failures off, accelerates receipts and recovers after reconnect', () => {
  run(`${common}
#include <csetjmp>
#define CONNECTED 1
#define ESP_LOGW(...) ((void)0)
${[...network.matchAll(/^#define (?:HEARTBEAT_\w+|SERVER_TIMEOUT_MS) .+$/gm)].map(m => m[0]).join('\n')}
static int wifi_state, wifi_lock, status_lock;
static uint32_t connection_generation;
static struct { char ssid[33], server_url[192], token[129]; } settings = {"wifi", "http://192.168.1.2", "token"};
static struct { bool pending; } cloud_command;
static bool binding_requested, fail, reconnect;
static int64_t now, until, active_until, receipt_at;
static std::vector<int64_t> beats;
static std::jmp_buf done;
struct device_status_t { bool active; };
static int64_t esp_timer_get_time() { return now * 1000; }
static bool provisioning_busy() { return false; }
static void provisioning_poll(int64_t, bool) {}
static void update_provisioning(int64_t) {}
static bool network_has_time() { return true; }
static int64_t network_epoch_ms() { return now; }
static void storage_resolve_time(int64_t) {}
static int xEventGroupGetBits(int) { return reconnect && now == 60000 ? 0 : CONNECTED; }
static int take_wifi(int, int) { return pdTRUE; }
#define xSemaphoreTake take_wifi
#define xSemaphoreGive(lock) ((void)(lock))
static void esp_wifi_connect() {}
static void close_http() {}
static void request_binding() {}
static int upload_one() { return ESP_OK; }
static void device_snapshot(device_status_t *s) { s->active = now < active_until; }
static bool heartbeat() { beats.push_back(now); cloud_command.pending = false; return !fail; }
static void vTaskDelay(int ms) {
    now += ms;
    if (reconnect && (now == 60000 || now == 60500)) ++connection_generation;
    if (receipt_at && now == receipt_at) cloud_command.pending = true;
    if (now >= until) std::longjmp(done, 1);
}
${actual(network, 'static void network_task')}
static void simulate(int64_t end) {
    beats.clear(); now = 0; until = end; connection_generation = 0; cloud_command.pending = false;
    if (!setjmp(done)) network_task(nullptr);
}
int main() {
    (void)mutex; (void)&xSemaphoreTake; (void)&xSemaphoreGive;
    active_until = 30000; simulate(100000);
    assert((beats == std::vector<int64_t>{0,5000,10000,15000,20000,25000,55000,85000}));
    active_until = 0; fail = true; simulate(200000);
    assert((beats == std::vector<int64_t>{0,5000,15000,35000,75000,135000,195000}));
    fail = false; receipt_at = 35000; simulate(40000);
    assert((beats == std::vector<int64_t>{0,30000,35000}));
    receipt_at = 0; fail = true; reconnect = true; simulate(66000);
    assert((beats == std::vector<int64_t>{0,5000,15000,35000,60500,65500}));
}
`);
});

test('persistent HTTP resets payloads and credentials, reuses only the same connection and discards failed responses', () => {
  run(`${common}
#include <map>
struct cJSON { std::string data; };
static char *cJSON_PrintUnformatted(const cJSON *body) { return strdup(body->data.c_str()); }
static void cJSON_free(void *ptr) { free(ptr); }
static cJSON *cJSON_Parse(const char *text) { return text[0] == '{' ? new cJSON{text} : nullptr; }
static bool cJSON_IsObject(const cJSON *json) { return json; }
static void cJSON_Delete(cJSON *json) { delete json; }
enum { HTTP_EVENT_ON_DATA, HTTP_METHOD_POST, HTTP_METHOD_GET };
struct esp_http_client_event_t { void *user_data; int event_id, data_len; const char *data; };
struct esp_http_client_config_t {
    const char *url; int timeout_ms;
    esp_err_t (*event_handler)(esp_http_client_event_t *); void *user_data;
    bool disable_auto_redirect; void (*crt_bundle_attach)();
};
struct Client {
    esp_http_client_config_t config;
    std::string url, sent_body; std::map<std::string,std::string> headers;
    const char *body = nullptr; int length = 0, method = 0;
};
using esp_http_client_handle_t = Client *;
static int opens, closes, status_code = 200, transport_error;
static std::string response = "{first}";
static int status_lock;
static uint32_t connection_generation;
static void esp_crt_bundle_attach() {}
static auto esp_http_client_init(const esp_http_client_config_t *config) { ++opens; return new Client{*config}; }
static void esp_http_client_cleanup(Client *client) { ++closes; delete client; }
static int esp_http_client_set_url(Client *c, const char *v) { c->url = v; return 0; }
static int esp_http_client_set_method(Client *c, int v) { c->method = v; return 0; }
static int esp_http_client_set_header(Client *c, const char *k, const char *v) { c->headers[k] = v; return 0; }
static void esp_http_client_delete_header(Client *c, const char *k) { c->headers.erase(k); }
static int esp_http_client_set_post_field(Client *c, const char *v, int n) { c->body = v; c->length = n; return 0; }
static int esp_http_client_get_status_code(Client *) { return status_code; }
static int esp_http_client_perform(Client *c) {
    c->sent_body.assign(c->body ? c->body : "", c->length);
    if (transport_error) return transport_error;
    esp_http_client_event_t event{c->config.user_data, HTTP_EVENT_ON_DATA, (int)response.size(), response.data()};
    return c->config.event_handler(&event);
}
#define ESP_LOGW(...) ((void)0)
${network.slice(network.indexOf('typedef struct {'), network.indexOf('bool network_has_time'))}
${actual(network, 'static esp_err_t on_http').replace('= event->user_data', '= static_cast<response_buffer_t *>(event->user_data)')}
${actual(network, 'static esp_err_t request_as')}
int main() {
    (void)mutex; (void)&xSemaphoreTake; (void)&xSemaphoreGive;
    const char *origin = "https://coaster.example";
    cJSON body{"{payload}"}, *reply = nullptr;
    assert(request_as(origin,"/heartbeat",&body,"device","secret",&reply,nullptr) == ESP_OK);
    assert(opens == 1 && closes == 0 && http_client->body == nullptr);
    assert(http_client->headers["Authorization"] == "Bearer secret");
    assert(reply->data == "{first}"); cJSON_Delete(reply);
    response = "{second}";
    assert(request_as(origin,"/query",nullptr,nullptr,nullptr,&reply,nullptr) == ESP_OK);
    assert(opens == 1 && http_client->method == HTTP_METHOD_GET && http_client->sent_body.empty());
    assert(!http_client->headers.count("Authorization") && !http_client->headers.count("X-Device-ID"));
    assert(reply->data == "{second}"); cJSON_Delete(reply);
    assert(request_as("https://next.example","/claim",&body,nullptr,nullptr,&reply,nullptr) == ESP_OK);
    assert(opens == 2 && closes == 1); cJSON_Delete(reply);
    ++connection_generation;
    assert(request_as("https://next.example","/query",nullptr,nullptr,nullptr,&reply,nullptr) == ESP_OK);
    assert(opens == 3 && closes == 2); cJSON_Delete(reply);
    transport_error = ESP_FAIL;
    assert(request_as("https://next.example","/query",nullptr,nullptr,nullptr,&reply,nullptr) == ESP_FAIL);
    assert(!http_client && !reply && closes == 3);
    transport_error = 0; response.assign(2100, 'x');
    assert(request_as(origin,"/query",nullptr,nullptr,nullptr,&reply,nullptr) == ESP_ERR_INVALID_SIZE);
    assert(!http_client && !reply);
    response = "invalid";
    assert(request_as(origin,"/query",nullptr,nullptr,nullptr,&reply,nullptr) == ESP_ERR_INVALID_RESPONSE);
    assert(!http_client && !reply);
    response = "{error}"; status_code = 503;
    int status = 0;
    assert(request_as(origin,"/query",nullptr,nullptr,nullptr,&reply,&status) == ESP_ERR_INVALID_RESPONSE);
    assert(status == 503 && !http_client && !reply && opens == closes);
}
`);
});

const structure = (file, name) => readFileSync(new URL(`../water_companion/${file}`, import.meta.url), 'utf8').match(new RegExp(`typedef struct \\{[\\s\\S]*?\\} ${name};`))[0];
test('weight noise leaves the screen asleep; a cup movement, button or repair/provisioning state wakes it', () => {
  run(`${common}
#define DEVICE_IDLE_MS 30000
#define WEIGHING_MAX_GRAMS 2000
#define CONTROL_IP "192.168.4.1"
#define LCD_BL_PIN 46
enum { LOW, HIGH, RED, GRAY, WHITE, AMBER, GREEN, WIFI_REASON_NO_AP_FOUND, WIFI_REASON_AUTH_FAIL, WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT, WIFI_REASON_HANDSHAKE_TIMEOUT };
${structure('device.h','device_status_t')}
${structure('network.h','network_status_t')}
${structure('ble_provision.h','ble_provision_display_t')}
static bool ready = true;
static int state_lock, brightness = HIGH, paints;
static int64_t now, last_activity_ms;
static float activity_weight = NAN;
static device_status_t input;
static network_status_t net;
static ble_provision_display_t ble_state;
static bool provisioning;
static int64_t esp_timer_get_time() { return now * 1000; }
static bool provisioning_busy() { return provisioning; }
static void network_snapshot(network_status_t *s) { *s = net; }
static void device_snapshot(device_status_t *s) { *s = input; s->active = now - last_activity_ms < DEVICE_IDLE_MS; }
static void ble_provision_snapshot(ble_provision_display_t *s) { *s = ble_state; }
static void digitalWrite(int pin, int value) { assert(pin == LCD_BL_PIN); brightness = value; }
static void line(int, const char *, int) { ++paints; }
static void storage_counts(unsigned *a, unsigned *b) { *a = *b = 0; }
${actual(device, 'static void update_activity')}
${actual(device, 'void device_wake')}
${actual(display, 'void display_update')}
int main() {
    (void)mutex;
    input.sensor_ready = input.calibrated = true; input.weight = 400;
    update_activity(400, 0); display_update(ESP_OK); assert(brightness == HIGH && paints);
    now = 31000; update_activity(400.5, now); paints = 0; display_update(ESP_OK);
    assert(brightness == LOW && !paints);
    update_activity(404.9, now); display_update(ESP_OK); assert(brightness == LOW);
    update_activity(405.1, now); display_update(ESP_OK); assert(brightness == HIGH);
    now += 30000; display_update(ESP_OK); assert(brightness == LOW);
    update_activity(0, now); display_update(ESP_OK); assert(brightness == HIGH);
    now += 30000; display_update(ESP_OK); assert(brightness == LOW);
    device_wake(); display_update(ESP_OK); assert(brightness == HIGH);
    now += 30000; ble_state.window_open = true; display_update(ESP_OK); assert(brightness == HIGH);
    ble_state.window_open = false; display_update(ESP_OK); assert(brightness == LOW);
    provisioning = true; display_update(ESP_OK); assert(brightness == HIGH);
    provisioning = false; display_update(ESP_OK); assert(brightness == LOW);
    input.sensor_ready = false; display_update(ESP_OK); assert(brightness == HIGH);
    input.sensor_ready = true; input.unsaved_event = true; display_update(ESP_OK); assert(brightness == HIGH);
}
`);
});

test('BLE starts only on demand, stops host before radio and reopens without reallocating GATT services', () => {
  run(`${common}
#define PROVISION_WINDOW_MS 600000
#define PROVISION_FRAME_MS 10000
#define PROVISION_SERVICE_UUID "service"
#define PROVISION_INFO_UUID "info"
#define PROVISION_CONFIG_UUID "config"
#define PROVISION_STATUS_UUID "status"
#define PROVISION_WIFI_UUID "wifi"
enum { BLE_HS_CONN_HANDLE_NONE = 65535, ESP_BT_MODE_BLE, BLE_HS_EALREADY, BLE_HS_EBUSY, BLE_HS_ENOTCONN, ESP_IO_CAP_OUT };
static int64_t now, window_until_ms, challenge_ms, completed_ms, start_retry_ms;
static int inits, services, notifications, disconnects, disables, enables, stop_calls;
static int disconnect_error;
static bool synced, controller, busy, scan_running;
static bool authenticated, advertising, open_requested, pairing, subscribed;
static bool disconnecting, radio_disabled, host_stopping, host_stopped;
static uint16_t connection_id = BLE_HS_CONN_HANDLE_NONE;
static uint32_t notified_sequence;
static char challenge[65], hardware_id[13];
static struct { bool active; int64_t started_ms; } frames;
static struct { uint32_t sequence; } current;
struct provision_trust_t {};
struct ble_hs_stop_listener {};
static ble_hs_stop_listener stop_listener;
static void (*stop_callback)(int,void *);
static int64_t now_ms() { return now; }
static bool open_locked() { return now < window_until_ms; }
static bool provisioning_busy() { return busy; }
static void reset_wifi_scan() {}
static void provision_frames_reset(decltype(frames) *f) { f->active = false; }
static void ble_provision_status(const char *, const char *, const char *, const char *) {}
static int device_hardware_id(char *s) { strcpy(s,"aabbccddeeff"); return ESP_OK; }
static int xSemaphoreCreateMutex() { return 1; }
struct Security {};
struct Connections {};
struct Reads {};
struct Writes {};
struct Wifi {};
struct BLECharacteristic {
    enum { PROPERTY_READ = 1, PROPERTY_READ_ENC = 2, PROPERTY_READ_AUTHEN = 4, PROPERTY_READ_AUTHOR = 8,
           PROPERTY_WRITE = 16, PROPERTY_WRITE_ENC = 32, PROPERTY_WRITE_AUTHEN = 64, PROPERTY_WRITE_AUTHOR = 128, PROPERTY_NOTIFY = 256 };
    template<class T> void setCallbacks(T *) {}
    int getHandle() { return 7; }
};
static BLECharacteristic characteristic;
static BLECharacteristic *info_characteristic, *status_characteristic;
struct BLEService {
    BLECharacteristic *createCharacteristic(const char *, int) { return &characteristic; }
    bool start() { return true; }
};
static BLEService service;
struct BLEServer {
    void advertiseOnDisconnect(bool) {}
    void setCallbacks(Connections *) {}
    BLEService *createService(const char *) { ++services; return &service; }
    int disconnect(uint16_t id) { assert(id == connection_id); ++disconnects; return disconnect_error; }
};
static BLEServer instance, *server;
struct Advertising { void addServiceUUID(const char *) {} void setScanResponse(bool) {} };
static Advertising adv;
struct BLEDevice {
    static bool init(const char *) { ++inits; controller = synced = true; return true; }
    static void setSecurityCallbacks(Security *) {}
    static BLEServer *createServer() { return &instance; }
    static Advertising *getAdvertising() { return &adv; }
    static void startAdvertising() { assert(synced && controller); }
    static void stopAdvertising() {}
    static void onReset(int) { synced = false; }
};
struct BLESecurity {
    static void setAuthenticationMode(bool,bool,bool) {}
    static void setCapability(int) {}
    static void setKeySize(int) {}
    static void setForceAuthentication(bool) {}
};
static struct { int sm_sc_only; } ble_hs_cfg;
static int esp_bt_controller_enable(int) { assert(!controller); controller = true; ++enables; return ESP_OK; }
static int esp_bt_controller_disable() { assert(host_stopped && !host_stopping); controller = false; ++disables; return ESP_OK; }
static bool ble_hs_synced() { return synced; }
static void ble_hs_sched_start() { assert(controller && !host_stopping); synced = true; }
static int ble_hs_stop(ble_hs_stop_listener *, void (*callback)(int,void *), void *) {
    assert(!stop_callback); stop_callback = callback; ++stop_calls; return 0;
}
static void stopped() { auto cb = stop_callback; assert(cb); stop_callback = nullptr; synced = false; cb(0,nullptr); }
struct os_mbuf {};
static os_mbuf packet;
static os_mbuf *ble_hs_mbuf_from_flat(const void *, int) { return &packet; }
static int ble_gatts_notify_custom(uint16_t, int, os_mbuf *) { ++notifications; return 0; }
${actual(ble,'static esp_err_t start_radio')}
${actual(ble,'static void host_stopped_callback')}
${actual(ble,'static void stop_radio')}
${actual(ble,'void ble_provision_open')}
${actual(ble,'esp_err_t ble_provision_start')}
${actual(ble,'void ble_provision_poll')}
int main() {
    (void)challenge_ms;
    assert(ble_provision_start(nullptr,nullptr,false) == ESP_OK);
    ble_provision_poll(); assert(!inits && !controller);
    ble_provision_open(); ble_provision_poll(); ble_provision_poll();
    assert(inits == 1 && services == 1 && controller && advertising);
    connection_id = 42; authenticated = subscribed = true; current.sequence = 1;
    now = 10000; completed_ms = now; ble_provision_poll(); assert(notifications == 1);
    now += 2000; ble_provision_poll(); assert(disconnects == 1 && !disables);
    ble_provision_poll(); assert(disconnects == 1 && !stop_calls);
    connection_id = BLE_HS_CONN_HANDLE_NONE;
    scan_running = true; ble_provision_poll(); assert(!stop_calls);
    scan_running = false; busy = true; ble_provision_poll(); assert(!stop_calls);
    busy = false; ble_provision_poll(); assert(stop_calls == 1 && host_stopping && !disables);
    ble_provision_poll(); assert(stop_calls == 1);
    stopped(); ble_provision_poll(); assert(disables == 1 && radio_disabled && !controller);
    for (int i = 0; i < 3; ++i) {
        ble_provision_open(); ble_provision_poll(); ble_provision_poll();
        assert(controller && advertising && inits == 1 && services == 1);
        now += PROVISION_WINDOW_MS; ble_provision_poll(); assert(host_stopping);
        stopped(); ble_provision_poll(); assert(!controller);
    }
    assert(enables == 3 && disables == 4);
    // A new BOOT request while the host is stopping waits for its callback.
    ble_provision_open(); ble_provision_poll(); ble_provision_poll();
    now += PROVISION_WINDOW_MS; ble_provision_poll(); assert(host_stopping);
    ble_provision_open(); ble_provision_poll(); assert(host_stopping && !advertising);
    stopped(); ble_provision_poll(); ble_provision_poll();
    assert(controller && advertising && inits == 1 && services == 1);
    connection_id = 43; window_until_ms = now; disconnect_error = ESP_FAIL;
    ble_provision_poll(); assert(disconnects == 2 && !disconnecting);
    now += 29999; ble_provision_poll(); assert(disconnects == 2);
    now += 1; disconnect_error = BLE_HS_ENOTCONN;
    ble_provision_poll(); assert(disconnects == 3 && connection_id == BLE_HS_CONN_HANDLE_NONE);
    ble_provision_poll(); assert(host_stopping);
    stopped(); ble_provision_poll(); assert(radio_disabled && !controller);
}
`);
});
