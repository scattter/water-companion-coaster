import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('HTTP 兼容双栈热点连接，局域网校准校验凭证和来源，错误使用 UTF-8', () => {
  const source = readFileSync(new URL('../water_companion/control.cpp', import.meta.url), 'utf8');
  const network = readFileSync(new URL('../water_companion/network.h', import.meta.url), 'utf8');
  const allowed = source.match(/static bool allowed\([\s\S]*?\n\}/)?.[0];
  const localAddress = source.match(/static bool local_address_is\([\s\S]*?\n\}/)?.[0];
  const lanAllowed = source.match(/static bool lan_allowed\([\s\S]*?\n\}/)?.[0];
  const calibrationCommand = source.match(/static bool calibration_command\([\s\S]*?\n\}/)?.[0];
  const device = readFileSync(new URL('../water_companion/coaster.c', import.meta.url), 'utf8');
  const authorize = device.match(/bool device_authorize\([\s\S]*?\n\}/)?.[0];
  const error = source.match(/static esp_err_t send_error\([\s\S]*?\n\}/)?.[0];
  assert.ok(allowed && localAddress && lanAllowed && authorize && calibrationCommand && error, '读取实际固件处理函数');
  const root = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'control-http-'));
  try {
    // 编译实际访问校验与响应函数；HTTP 元数据和传输使用替身，不监听端口。
    const program = `
#include <cassert>
#include <cstring>
#include <map>
#include <string>
#include <arpa/inet.h>
#include <sys/socket.h>
using esp_err_t = int;
constexpr int ESP_OK = 0, HTTP_GET = 0, HTTP_POST = 1;
constexpr int HTTPD_RESP_USE_STRLEN = -1;
${network.match(/^#define CONTROL_IP .+$/m)[0]}
struct httpd_req_t {
    int method = HTTP_GET;
    const char *uri = "/";
    std::map<std::string, std::string> headers = {{"Host", CONTROL_IP}};
    std::string type, status, body;
};
static const char *local_ip = CONTROL_IP;
static int local_family = AF_INET;
static int test_getsockname(int, sockaddr *address, socklen_t *size) {
    if (local_family == AF_INET6) {
        sockaddr_in6 local = {};
        local.sin6_family = AF_INET6;
        assert(inet_pton(AF_INET6, local_ip, &local.sin6_addr) == 1);
        memcpy(address, &local, *size < sizeof(local) ? *size : sizeof(local));
        *size = sizeof(local);
    } else {
        sockaddr_in local = {};
        local.sin_family = AF_INET;
        local.sin_addr.s_addr = inet_addr(local_ip);
        memcpy(address, &local, *size < sizeof(local) ? *size : sizeof(local));
        *size = sizeof(local);
    }
    return 0;
}
#define getsockname test_getsockname
static int httpd_req_to_sockfd(httpd_req_t *) { return 4; }
static size_t httpd_req_get_hdr_value_len(httpd_req_t *r, const char *name) {
    auto value = r->headers.find(name);
    return value == r->headers.end() ? 0 : value->second.size();
}
static int httpd_req_get_hdr_value_str(httpd_req_t *r, const char *name, char *buffer, size_t size) {
    auto value = r->headers.find(name);
    if (value == r->headers.end() || value->second.size() >= size) return -1;
    strcpy(buffer, value->second.c_str());
    return ESP_OK;
}
static void httpd_resp_set_status(httpd_req_t *r, const char *value) { r->status = value; }
static void httpd_resp_set_type(httpd_req_t *r, const char *value) { r->type = value; }
static int httpd_resp_send(httpd_req_t *r, const char *value, int) { r->body = value; return ESP_OK; }
static int state_lock = 0, portMAX_DELAY = 0;
static void xSemaphoreTake(int, int) {}
static void xSemaphoreGive(int) {}
static struct { char device_id[65]; char token[129]; } config = {"coaster-01", "test-control-token"};
struct network_status_t { bool wifi_connected; char ip[16]; };
static network_status_t network_status = {true, "192.168.1.20"};
static void network_snapshot(network_status_t *status) { *status = network_status; }
${authorize}
${localAddress}
${allowed}
${lanAllowed}
${calibrationCommand}
${error}
int main() {
    httpd_req_t page;
    assert(allowed(&page));
    local_family = AF_INET6;
    local_ip = "::ffff:" CONTROL_IP;
    assert(allowed(&page));
    page.uri = "/api/status";
    assert(allowed(&page));
    local_ip = "::ffff:192.168.1.20";
    assert(!allowed(&page));
    local_ip = "fe80::1";
    assert(!allowed(&page));
    local_ip = "::192.168.4.1";
    assert(!allowed(&page));
    local_ip = "::ffff:" CONTROL_IP;
    page.uri = "/";
    page.headers["Sec-Fetch-Site"] = "cross-site";
    page.headers["Origin"] = "https://chatgpt.com";
    assert(allowed(&page));
    page.uri = "/?from=chat";
    assert(allowed(&page));
    page.uri = "/api/status";
    assert(!allowed(&page));
    page.method = HTTP_POST;
    page.uri = "/api/command";
    assert(!allowed(&page));
    page.headers["Origin"] = "http://" CONTROL_IP;
    page.headers["Sec-Fetch-Site"] = "same-origin";
    assert(allowed(&page));
    page.headers["Host"] = "untrusted.example";
    assert(!allowed(&page));
    page.headers["Host"] = CONTROL_IP;
    local_family = AF_INET;
    local_ip = "192.168.1.20";
    assert(!allowed(&page));
    local_ip = CONTROL_IP;
    page.method = HTTP_GET;
    page.uri = "/";
    const char *message = "请先连接杯垫热点，再打开配网页";
    assert(send_error(&page, "403 Forbidden", message) == ESP_OK);
    assert(page.type == "text/plain; charset=utf-8");
    assert(page.status == "403 Forbidden");
    assert(page.body == message);
    page.uri = "/api/control/status";
    local_ip = "192.168.1.20";
    page.headers.clear();
    assert(!lan_allowed(&page));
    page.headers["X-Device-ID"] = "coaster-01";
    page.headers["Authorization"] = "Bearer test-control-token";
    assert(lan_allowed(&page));
    local_family = AF_INET6;
    local_ip = "::ffff:192.168.1.20";
    assert(lan_allowed(&page));
    local_ip = "::ffff:" CONTROL_IP;
    assert(!lan_allowed(&page));
    local_ip = "::ffff:192.168.1.20";
    page.headers["Origin"] = "http://192.168.1.20";
    assert(!lan_allowed(&page));
    page.headers.erase("Origin");
    page.headers["Sec-Fetch-Site"] = "same-origin";
    assert(!lan_allowed(&page));
    page.headers.erase("Sec-Fetch-Site");
    page.headers["Authorization"] = "Bearer test-control-tokeN";
    assert(!lan_allowed(&page));
    page.headers["Authorization"] = "Bearer test-control-token";
    page.headers["X-Device-ID"] = "coaster-02";
    assert(!lan_allowed(&page));
    page.headers["X-Device-ID"] = "coaster-01";
    network_status.wifi_connected = false;
    assert(!lan_allowed(&page));
    assert(!device_authorize(nullptr, nullptr));
    assert(!device_authorize("coaster-01", "Bearer "));
    assert(!device_authorize("coaster-01", "Basic test-control-token"));
    config.token[0] = 0;
    assert(!device_authorize("coaster-01", "Bearer "));
    assert(calibration_command("tare"));
    assert(calibration_command("calibrate"));
    assert(calibration_command("cup"));
    assert(!calibration_command("wifi"));
    assert(!calibration_command("server"));
    assert(!calibration_command("reboot"));
}
`;
    const filename = join(directory, 'http-test.cpp');
    const executable = join(directory, 'http-test');
    writeFileSync(filename, program);
    const compile = spawnSync(process.env.CXX || 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror',
      '-pedantic', filename, '-o', executable], { encoding: 'utf8', env: { ...process.env, TMPDIR: directory } });
    assert.equal(compile.status, 0, compile.error?.message || compile.stderr);
    const run = spawnSync(executable, [], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
