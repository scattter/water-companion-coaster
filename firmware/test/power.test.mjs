import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const network = readFileSync(new URL('../water_companion/network.c', import.meta.url), 'utf8');
const device = readFileSync(new URL('../water_companion/coaster.c', import.meta.url), 'utf8');
const display = readFileSync(new URL('../water_companion/display.cpp', import.meta.url), 'utf8');
const sketch = readFileSync(new URL('../water_companion/water_companion.ino', import.meta.url), 'utf8');
const board = readFileSync(new URL('../water_companion/board_config.h', import.meta.url), 'utf8');
const ble = readFileSync(new URL('../water_companion/ble_provision.cpp', import.meta.url), 'utf8');
const hx711 = readFileSync(new URL('../water_companion/hx711.c', import.meta.url), 'utf8');
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
test('LCD sleeps and redraws before lighting, BOOT keeps its timing, and CPU slows only outside display/provisioning', () => {
  run(`${common}
#define DEVICE_IDLE_MS 30000
${readFileSync(new URL('../water_companion/cups.h', import.meta.url), 'utf8').replace('#pragma once', '')}
${readFileSync(new URL('../water_companion/button.h', import.meta.url), 'utf8').replace('#pragma once', '')}
#define WEIGHING_MAX_GRAMS 2000
#define CONTROL_IP "192.168.4.1"
#define FIRMWARE_VERSION "test"
${[...board.matchAll(/^#define (?:PROVISION_BUTTON_PIN|RGB_LED_PIN|LCD_\w+) .+$/gm)].map(m => m[0]).join('\n')}
enum { LOW, HIGH, OUTPUT, INPUT_PULLUP, RED, GRAY, WHITE, AMBER, GREEN, WIFI_REASON_NO_AP_FOUND, WIFI_REASON_AUTH_FAIL, WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT, WIFI_REASON_HANDSHAKE_TIMEOUT };
${structure('device.h','device_status_t')}
${structure('network.h','network_status_t')}
${structure('ble_provision.h','ble_provision_display_t')}
${structure('daily_summary.h','daily_summary_t')}
struct binding_state_t { char binding_id[37]; };
struct device_config_t {};
struct daily_view_t {};
static bool ready, sleeping, daily_drawn;
static int current_page = -1;
static int state_lock, console_lock, brightness = LOW, paints, lit, rgb_writes, error_logs;
static bool panel_sleep, panel_on, frequency_failure;
static int64_t sleep_in_at = -5, sleep_out_at = -120;
static int wake_paints, frequency_errors;
static uint32_t frequency = 240;
static std::vector<uint32_t> frequencies;
static std::vector<uint8_t> commands;
static int button = HIGH, ap_opens, ble_opens;
static unsigned cup_switches;
static void device_next_cup() { ++cup_switches; }
static void device_cancel_cup_setup() {}
static int64_t now, last_activity_ms, wake_until_ms;
static int64_t panel_wake_ms = -1;
static float activity_weight = NAN;
static esp_err_t startup_result = ESP_OK;
static device_status_t input;
static network_status_t net;
static ble_provision_display_t ble_state;
static bool provisioning;
static const int ROW_HEIGHT = 20;
static uint8_t pixels[LCD_WIDTH * ROW_HEIGHT * 2];
static int64_t esp_timer_get_time() { return now * 1000; }
static unsigned long millis() { return (unsigned long)now; }
static void delay(unsigned long ms) { now += ms; }
static bool provisioning_busy() { return provisioning; }
static void network_snapshot(network_status_t *s) { *s = net; }
static void device_snapshot(device_status_t *s) { *s = input; s->active = now - last_activity_ms < DEVICE_IDLE_MS; }
static void ble_provision_snapshot(ble_provision_display_t *s) { *s = ble_state; }
static void digitalWrite(int pin, int value) {
    if (pin == LCD_BL_PIN) {
        if (value == HIGH) { assert(panel_on && !panel_sleep && paints > wake_paints); ++lit; }
        brightness = value;
    }
    else assert(pin == LCD_CS_PIN || pin == LCD_RST_PIN);
}
static int digitalRead(int pin) { assert(pin == PROVISION_BUTTON_PIN); return button; }
static void pinMode(int pin, int mode) {
    assert(pin == PROVISION_BUTTON_PIN ? mode == INPUT_PULLUP : mode == OUTPUT);
}
static void rgbLedWrite(int pin, int red, int green, int blue) {
    assert(pin == 38 && !red && !green && !blue); ++rgb_writes;
}
static void write_command(uint8_t command, const uint8_t * = nullptr, size_t = 0) {
    commands.push_back(command);
    if (command == 0x10) {
        assert(!panel_on && brightness == LOW && now - sleep_out_at >= 120);
        panel_sleep = true; sleep_in_at = now;
    } else if (command == 0x11) {
        assert(brightness == LOW && now - sleep_in_at >= 5);
        panel_sleep = false; sleep_out_at = now; wake_paints = paints;
    } else if (command == 0x28) panel_on = false;
    else if (command == 0x29) {
        assert(!panel_sleep && now - sleep_out_at >= 120); panel_on = true;
    }
}
static void draw_pixels(int, int) {}
static void draw_text(int, const char *, uint16_t) { assert(!panel_sleep); ++paints; }
static void line(int, const char *, int) { assert(!panel_sleep); ++paints; }
static void storage_counts(unsigned *a, unsigned *b) { *a = *b = 0; }
static void device_config_snapshot(device_config_t *, binding_state_t *binding) { binding->binding_id[0] = 0; }
static void network_daily_summary(daily_summary_t *summary, const char *) { *summary = {}; }
static void select_page(int) {}
static daily_view_t daily_view(const device_status_t &, const network_status_t &, const daily_summary_t &, unsigned, unsigned) { return {}; }
static void show_daily(const daily_view_t &) { ++paints; }
static int xSemaphoreCreateMutex() { return 1; }
static int device_start() { return ESP_OK; }
static const char *esp_err_to_name(int) { return "test error"; }
static void network_provision() { ++ap_opens; net.ap_ready = true; }
static void ble_provision_open() { ++ble_opens; ble_state.window_open = true; }
static void ble_provision_poll() {}
static bool setCpuFrequencyMhz(uint32_t value) {
    assert(value == 80 || value == 240); frequencies.push_back(value);
    if (frequency_failure) return false;
    frequency = value; return true;
}
static struct {
    bool begin(int, int, int, int) { return true; }
} SPI;
static struct {
    void setRxBufferSize(int) {}
    void setTxBufferSize(int) {}
    void setTxTimeoutMs(int) {}
    void begin(int) {}
    void println(const char *) { ++frequency_errors; }
    void printf(const char *, const char *) { ++error_logs; }
} Serial;
${actual(device, 'static void update_activity')}
${actual(device, 'void device_wake')}
${actual(display, 'static void sleep_panel')}
${actual(display, 'bool display_start')}
${actual(display, 'void display_wake')}
${actual(display, 'bool display_awake')}
${actual(display, 'static void draw_status')}
${actual(display, 'void display_update')}
${actual(sketch, 'static void update_cpu')}
${actual(sketch, 'void setup')}
${actual(sketch, 'void loop')}
static void press_at(int64_t at) {
    now = at - 40; button = LOW; loop(); loop(); loop();
    for (int i = 0; i < 6; ++i) loop();
}
static void release_button() { button = HIGH; loop(); loop(); loop(); }
int main() {
    (void)mutex;
    setup();
    assert(ready && sleeping && panel_sleep && brightness == LOW && lit == 0 && rgb_writes == 1);
    loop(); assert(frequency == 80 && !frequency_errors);
    auto idle_commands = commands.size(), idle_frequencies = frequencies.size();
    loop(); assert(commands.size() == idle_commands && frequencies.size() == idle_frequencies);
    paints = 0;
    input.sensor_ready = input.calibrated = true; input.weight = 400;
    update_activity(400, now); display_update(ESP_OK); assert(brightness == LOW && !paints);
    now = 31000; update_activity(400.5, now); paints = 0; display_update(ESP_OK);
    assert(brightness == LOW && !paints);
    update_activity(500, now); display_update(ESP_OK); assert(brightness == LOW && !paints);
    assert(last_activity_ms == now);
    update_activity(0, now); display_update(ESP_OK); assert(brightness == LOW && !paints);

    press_at(40000); assert(brightness == HIGH && paints && frequency == 240 && !sleeping);
    release_button();
    now = 54999; update_activity(800, now); display_update(ESP_OK); assert(brightness == HIGH);
    now = 55000; paints = 0; loop(); assert(brightness == LOW && !paints && frequency == 80 && sleeping);

    press_at(60000);
    now = 63000; loop(); assert(ap_opens == 1 && ble_opens == 1 && brightness == HIGH);
    now = 64000; loop(); assert(ap_opens == 1 && ble_opens == 1);
    now = 75000; loop(); assert(brightness == LOW && frequency == 240);
    release_button();
    net.ap_ready = false; loop(); assert(frequency == 240);
    ble_state.window_open = false; loop(); assert(frequency == 80);
    net.ap_ready = true; loop(); assert(frequency == 240);
    net.ap_ready = false;

    press_at(80000); release_button();
    press_at(90000); release_button();
    now = 95000; display_update(ESP_OK); assert(brightness == HIGH);
    now = 104999; display_update(ESP_OK); assert(brightness == HIGH);
    now = 105000; display_update(ESP_OK); assert(brightness == LOW);

    provisioning = true; ble_state.pairing = true; strcpy(net.binding_code, "123456");
    input.sensor_ready = input.calibrated = false; input.weight = NAN;
    input.unsaved_event = input.restart_required = true;
    paints = 0; loop(); assert(brightness == LOW && !paints && frequency == 240);
    press_at(110000); release_button(); assert(brightness == HIGH);
    now = 125000; loop(); assert(brightness == LOW);

    startup_result = ESP_FAIL;
    provisioning = false;
    paints = 0; loop(); assert(brightness == LOW && !paints && error_logs && frequency == 240);
    press_at(130000); assert(brightness == HIGH && paints && now == 130140);
    now = 133000; loop(); assert(ap_opens == 1 && ble_opens == 1);
    now = 145000; paints = 0; loop(); assert(brightness == LOW && !paints);
    assert(rgb_writes == 1);

    startup_result = ESP_OK; frequency_failure = true;
    release_button(); assert(frequency == 240 && frequency_errors == 1);
    idle_frequencies = frequencies.size();
    loop(); assert(frequencies.size() == idle_frequencies && frequency_errors == 1);
    frequency_failure = false;
    press_at(now + 40); assert(brightness == HIGH && frequency == 240);
    release_button();
    now += 15000; loop(); assert(frequency == 80 && sleeping && brightness == LOW);
    int64_t begin = now;
    unsigned switched = cup_switches;
    while (now - begin < 600) {
        int64_t elapsed = now - begin;
        button = elapsed < 100 || (elapsed >= 200 && elapsed < 300) ? LOW : HIGH;
        loop();
    }
    assert(cup_switches == switched + 1 && brightness == HIGH);
}
`);
});

test('HX711 waits without losing latched data-ready, keeps 25 short clocks, and reports timeout/saturation', () => {
  run(`${common}
enum { ESP_ERR_TIMEOUT = 10 };
static int data_pin = 2, clock_pin = 4, clock_lock;
static int64_t now_us, ready_us, high_at;
static bool high;
static unsigned pulses, reads, polls;
static uint32_t raw;
static int64_t esp_timer_get_time() { return now_us; }
static void vTaskDelay(int ms) { assert(ms == 10); now_us += ms * 1000; ++polls; }
static void esp_rom_delay_us(int us) { now_us += us; }
static int gpio_get_level(int pin) {
    assert(pin == data_pin);
    if (!high) return now_us < ready_us;
    assert(pulses >= 1 && pulses <= 24); ++reads;
    return (raw >> (24 - pulses)) & 1;
}
static void gpio_set_level(int pin, int value) {
    assert(pin == clock_pin);
    if (value) { assert(!high); high_at = now_us; ++pulses; }
    else { assert(high && now_us - high_at < 60); }
    high = value;
}
${actual(hx711, 'esp_err_t hx711_read')}
static void sensor(uint32_t value, int64_t ready_at) {
    raw = value; ready_us = ready_at; high = false; pulses = reads = polls = 0;
}
int main() {
    (void)mutex; (void)&xSemaphoreGive;
    int32_t value;
    sensor(123456, 95000);
    assert(hx711_read(&value, 500) == ESP_OK && value == 123456);
    assert(polls == 10 && pulses == 25 && reads == 24 && !high);
    for (unsigned sample = 0; sample < 20; ++sample) {
        now_us = 200000 + sample * 100000;
        sensor(0xffff9c, now_us);
        assert(hx711_read(&value, 500) == ESP_OK && value == -100 && !polls && pulses == 25);
    }
    sensor(0, now_us + 600000); auto start = now_us;
    assert(hx711_read(&value, 500) == ESP_ERR_TIMEOUT);
    assert(now_us - start == 500000 && polls == 50 && !pulses && !high);
    sensor(0x7fffff, now_us);
    assert(hx711_read(&value, 500) == ESP_ERR_INVALID_RESPONSE);
    sensor(0x800000, now_us);
    assert(hx711_read(&value, 500) == ESP_ERR_INVALID_RESPONSE);
    assert(hx711_read(nullptr, 500) == ESP_ERR_INVALID_ARG);
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
