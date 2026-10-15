import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const control = readFileSync(new URL('../water_companion/control.cpp', import.meta.url), 'utf8');
const network = readFileSync(new URL('../water_companion/network.c', import.meta.url), 'utf8');

function actual(source, signature) {
  const start = source.indexOf(`${signature}(`);
  assert.notEqual(start, -1, signature);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, signature);
  return source.slice(start, end + 2);
}

function run(program, cpp = false) {
  const directory = mkdtempSync(join(tmpdir(), 'coaster-http-lifecycle-'));
  try {
    const source = join(directory, cpp ? 'test.cpp' : 'test.c');
    const executable = join(directory, 'test');
    writeFileSync(source, program);
    const compiled = spawnSync(cpp ? (process.env.CXX || 'c++') : (process.env.CC || 'cc'),
      [cpp ? '-std=c++17' : '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', source, '-o', executable],
      { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
    const result = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('actual HTTP lifecycle cleans every failed registration and supports repeated start/stop/reopen', () => {
  const server = control.match(/^static httpd_handle_t server = nullptr;$/m)?.[0];
  const ready = control.match(/^static bool routes_ready;$/m)?.[0];
  assert.ok(server && ready, 'HTTP ownership and readiness must survive control_start');
  run(`
#include <cassert>
#include <cstring>
using esp_err_t = int;
using httpd_handle_t = void *;
struct httpd_req_t {};
struct httpd_config_t {
    unsigned stack_size, max_open_sockets;
    bool lru_purge_enable;
    unsigned recv_wait_timeout, send_wait_timeout;
};
struct httpd_uri_t { const char *uri; int method; esp_err_t (*handler)(httpd_req_t *); };
enum { ESP_OK, HTTP_GET, HTTP_POST, START_ERROR, REGISTER_ERROR, STOP_ERROR };
#define HTTPD_DEFAULT_CONFIG() httpd_config_t{}
static int token, starts, stops, registrations, start_error, stop_error, fail_route = -1;
static bool allocated;
static esp_err_t handle(httpd_req_t *) { return ESP_OK; }
static esp_err_t httpd_start(httpd_handle_t *out, const httpd_config_t *config) {
    assert(!allocated && !*out);
    assert(config->stack_size == 8192 && config->max_open_sockets == 4);
    assert(config->lru_purge_enable && config->recv_wait_timeout == 3 && config->send_wait_timeout == 3);
    ++starts; registrations = 0;
    if (start_error) return start_error;
    *out = &token; allocated = true; return ESP_OK;
}
static esp_err_t httpd_register_uri_handler(httpd_handle_t value, const httpd_uri_t *route) {
    assert(allocated && value == &token && route->handler == handle);
    const char *expected[] = { "/", "/api/status", "/api/wifi-scan", "/api/command", "/api/time", "/api/binding" };
    assert(registrations < 6 && !strcmp(route->uri, expected[registrations]));
    assert(route->method == (registrations < 3 ? HTTP_GET : HTTP_POST));
    return registrations++ == fail_route ? REGISTER_ERROR : ESP_OK;
}
static esp_err_t httpd_stop(httpd_handle_t value) {
    assert(allocated && value == &token); ++stops;
    if (stop_error) return stop_error;
    allocated = false; return ESP_OK;
}
${server}
${ready}
${actual(control, 'esp_err_t control_stop')}
${actual(control, 'esp_err_t control_start')}
int main() {
    assert(control_stop() == ESP_OK && stops == 0);
    start_error = START_ERROR;
    assert(control_start() == START_ERROR && !server && !allocated && starts == 1);
    assert(control_stop() == ESP_OK && stops == 0);
    start_error = ESP_OK;
    for (fail_route = 0; fail_route < 6; ++fail_route) {
        int before = stops;
        assert(control_start() == REGISTER_ERROR && !server && !allocated);
        assert(registrations == fail_route + 1 && stops == before + 1);
        assert(control_stop() == ESP_OK && stops == before + 1);
    }
    fail_route = -1;
    assert(control_start() == ESP_OK && server && allocated && registrations == 6);
    int before = starts;
    assert(control_start() == ESP_OK && starts == before && registrations == 6);
    stop_error = STOP_ERROR;
    assert(control_stop() == STOP_ERROR && server && allocated);
    stop_error = ESP_OK;
    assert(control_stop() == ESP_OK && !server && !allocated);
    before = stops;
    assert(control_stop() == ESP_OK && stops == before);
    assert(control_start() == ESP_OK && server && allocated && registrations == 6);
    assert(control_stop() == ESP_OK && !server && !allocated && !routes_ready);
    // Failed cleanup retains the partially registered server without declaring it ready.
    for (fail_route = 0; fail_route < 6; ++fail_route) {
        stop_error = STOP_ERROR;
        assert(control_start() == STOP_ERROR && server && allocated && !routes_ready);
        assert(registrations == fail_route + 1);
        before = starts;
        assert(control_start() == STOP_ERROR && starts == before && server && !routes_ready);
        assert(control_stop() == STOP_ERROR && server && !routes_ready);
        stop_error = ESP_OK;
        assert(control_stop() == ESP_OK && !server && !allocated && !routes_ready);
    }
    fail_route = 2; stop_error = STOP_ERROR;
    assert(control_start() == STOP_ERROR && server && !routes_ready);
    fail_route = -1; stop_error = ESP_OK; before = starts;
    assert(control_start() == ESP_OK && starts == before + 1 && server && routes_ready);
    assert(registrations == 6 && control_stop() == ESP_OK && !server && !routes_ready);
}
`, true);
});

test('actual network startup skips HTTP in STA, keeps legacy AP, and returns allocation/HTTP/task errors', () => {
  run(`
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
typedef int esp_err_t;
typedef int esp_netif_t;
typedef int esp_sntp_config_t;
typedef struct { int ip, gw, netmask; } esp_netif_ip_info_t;
typedef struct { int placeholder; } wifi_init_config_t;
typedef struct {
    struct { char ssid[33], password[65]; struct { bool capable; } pmf_cfg; } sta;
    struct { char ssid[33], password[65]; unsigned ssid_len, channel, max_connection; int authmode; } ap;
} wifi_config_t;
typedef struct { char ssid[33], password[65], server_url[192], token[129]; } device_config_t;
enum { ESP_OK, ESP_ERR_NO_MEM, ESP_ERR_NVS_NOT_FOUND, STORAGE_ERROR, HTTP_ERROR,
    WIFI_MODE_APSTA, WIFI_MODE_STA, WIFI_IF_AP, WIFI_IF_STA, WIFI_STORAGE_RAM,
    WIFI_EVENT, IP_EVENT, ESP_EVENT_ANY_ID, ESP_MAC_WIFI_SOFTAP, WIFI_AUTH_WPA2_PSK };
#define CONTROL_IP "192.168.4.1"
#define pdPASS 1
#define WIFI_INIT_CONFIG_DEFAULT() {0}
#define ESP_NETIF_SNTP_DEFAULT_CONFIG(host) 0
#define ESP_LOGE(...) ((void)0)
#define ESP_LOGW(...) ((void)0)
#define ESP_RETURN_ON_ERROR(expr, ...) do { esp_err_t err = (expr); if (err != ESP_OK) return err; } while (0)
#define portENTER_CRITICAL(lock) ((void)(lock), ++critical_depth)
#define portEXIT_CRITICAL(lock) ((void)(lock), --critical_depth)
static device_config_t settings;
static int wifi_state, wifi_lock, status_lock, critical_depth, cloud_command;
static char previous_ssid[33], previous_password[65];
static bool wifi_trial, busy;
static int64_t ap_until_ms, trial_started_ms;
static struct {
    bool wifi_trial, wifi_configured, server_configured, control_ready;
    int wifi_error, control_error;
    char ap_ssid[17], ap_password[13], cloud_url[192], wifi_ssid[33];
} network_status;
static int mode, starts, stops, task_calls, netif_calls, driver_calls, time_calls;
static bool fail_state, fail_lock, fail_task, http_running;
static int http_error, command_error, candidate_error, driver_error;
static int xEventGroupCreate(void) { return fail_state ? 0 : 1; }
static int xSemaphoreCreateMutex(void) { return fail_lock ? 0 : 2; }
static int esp_netif_init(void) { ++netif_calls; return ESP_OK; }
static int esp_event_loop_create_default(void) { return ESP_OK; }
static esp_netif_t *esp_netif_create_default_wifi_ap(void) { static esp_netif_t ap; return &ap; }
static esp_netif_t *esp_netif_create_default_wifi_sta(void) { static esp_netif_t sta; return &sta; }
static int esp_netif_str_to_ip4(const char *text, int *ip) { (void)text; *ip = 1; return ESP_OK; }
static int esp_netif_dhcps_stop(esp_netif_t *ap) { assert(ap); return ESP_OK; }
static int esp_netif_set_ip_info(esp_netif_t *ap, const esp_netif_ip_info_t *ip) { assert(ap && ip); return ESP_OK; }
static int esp_netif_dhcps_start(esp_netif_t *ap) { assert(ap); return ESP_OK; }
static int esp_wifi_init(const wifi_init_config_t *init) { assert(init); ++driver_calls; return driver_error; }
static int esp_wifi_set_storage(int storage) { assert(storage == WIFI_STORAGE_RAM); return ESP_OK; }
static void on_wifi(void *arg, int base, int32_t id, void *data) { (void)arg; (void)base; (void)id; (void)data; }
static int esp_event_handler_register(int base, int id, void (*handler)(void *, int, int32_t, void *), void *arg) {
    (void)base; assert(id == ESP_EVENT_ANY_ID && handler == on_wifi && !arg); return ESP_OK;
}
static int esp_read_mac(uint8_t *mac, int type) { assert(type == ESP_MAC_WIFI_SOFTAP); memset(mac, 1, 6); return ESP_OK; }
static int storage_ap_password(char *password) { strcpy(password, "23456789ABCD"); return ESP_OK; }
static int esp_wifi_set_mode(int value) { mode = value; return ESP_OK; }
static int esp_wifi_set_config(int interface, const wifi_config_t *config) {
    assert(config && (mode == WIFI_MODE_APSTA || interface == WIFI_IF_STA)); return ESP_OK;
}
static int64_t esp_timer_get_time(void) { return 1000000; }
static int esp_wifi_start(void) { assert(mode == WIFI_MODE_STA || mode == WIFI_MODE_APSTA); return ESP_OK; }
static int control_start(void) {
    assert(!critical_depth && mode == WIFI_MODE_APSTA); ++starts;
    if (http_error) return http_error;
    http_running = true; return ESP_OK;
}
static int control_stop(void) { assert(!critical_depth); ++stops; http_running = false; return ESP_OK; }
static int esp_netif_sntp_init(const esp_sntp_config_t *config) { assert(config); ++time_calls; return ESP_OK; }
static void network_task(void *arg) { (void)arg; }
static int xTaskCreate(void (*task)(void *), const char *name, unsigned stack, void *arg, unsigned priority, void *out) {
    assert(task == network_task && !strcmp(name, "coaster-network") && stack == 8192);
    assert(!arg && priority == 4 && !out); ++task_calls; return fail_task ? 0 : pdPASS;
}
static int storage_load_command(int *command) { assert(command == &cloud_command); return command_error; }
static bool provisioning_busy(void) { return busy; }
static int storage_load_wifi(char *ssid, char *password) {
    if (candidate_error != ESP_OK) return candidate_error;
    strcpy(ssid, "candidate"); strcpy(password, "candidate-password"); return ESP_OK;
}
static const char *esp_err_to_name(int error) { (void)error; return "test-error"; }
static void console_println(const char *message) { assert(message); }
${actual(network, 'static esp_err_t update_control')}
${actual(network, 'static esp_err_t start_wifi')}
${actual(network, 'esp_err_t network_start')}
static void reset(void) {
    memset(&network_status, 0, sizeof(network_status));
    memset(&settings, 0, sizeof(settings));
    wifi_trial = busy = fail_state = fail_lock = fail_task = http_running = false;
    command_error = http_error = driver_error = ESP_OK; candidate_error = ESP_ERR_NVS_NOT_FOUND;
    starts = stops = task_calls = netif_calls = driver_calls = time_calls = 0;
    ap_until_ms = trial_started_ms = 0; wifi_state = wifi_lock = 0;
    assert(!critical_depth);
}
int main(void) {
    device_config_t config = {0}; strcpy(config.ssid, "home");
    reset(); assert(network_start(&config) == ESP_OK);
    assert(mode == WIFI_MODE_STA && starts == 0 && !network_status.control_ready && !http_running);
    assert(ap_until_ms == 0 && task_calls == 1 && time_calls == 1);
    reset(); config.ssid[0] = 0; assert(network_start(&config) == ESP_OK);
    assert(mode == WIFI_MODE_APSTA && starts == 1 && network_status.control_ready && http_running);
    assert(ap_until_ms == 601000 && task_calls == 1 && network_status.control_error == ESP_OK);
    reset(); strcpy(config.ssid, "home"); candidate_error = ESP_OK;
    assert(network_start(&config) == ESP_OK && wifi_trial && mode == WIFI_MODE_APSTA && starts == 1);
    reset(); busy = true; candidate_error = STORAGE_ERROR;
    assert(network_start(&config) == ESP_OK && mode == WIFI_MODE_STA && starts == 0);
    reset(); command_error = STORAGE_ERROR;
    assert(network_start(&config) == STORAGE_ERROR && network_status.wifi_error == STORAGE_ERROR && !netif_calls);
    reset(); candidate_error = STORAGE_ERROR;
    assert(network_start(&config) == STORAGE_ERROR && network_status.wifi_error == STORAGE_ERROR && !netif_calls);
    reset(); fail_state = true;
    assert(network_start(&config) == ESP_ERR_NO_MEM && !wifi_state && !wifi_lock && !netif_calls);
    reset(); fail_lock = true;
    assert(network_start(&config) == ESP_ERR_NO_MEM && !wifi_lock && !netif_calls);
    reset(); driver_error = STORAGE_ERROR;
    assert(network_start(&config) == STORAGE_ERROR && driver_calls == 1 && !starts && !task_calls);
    reset(); config.ssid[0] = 0; http_error = HTTP_ERROR;
    assert(network_start(&config) == HTTP_ERROR && !network_status.control_ready && !http_running);
    assert(network_status.control_error == HTTP_ERROR && network_status.wifi_error == HTTP_ERROR && !task_calls);
    reset(); fail_task = true;
    assert(network_start(&config) == ESP_ERR_NO_MEM && starts == 1 && stops == 1);
    assert(!network_status.control_ready && !http_running && network_status.wifi_error == ESP_ERR_NO_MEM);
    assert(!critical_depth);
}
`);
});
