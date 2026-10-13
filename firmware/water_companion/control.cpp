#include "control.h"
#include "device.h"
#include "network.h"
#include "esp_http_server.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include <cmath>
#include <cstring>

static const char PAGE[] = R"HTML(<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>水伴杯垫配网</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f6ef;color:#263d35;font:16px/1.65 system-ui,sans-serif}main{max-width:560px;margin:auto;padding:24px 18px 48px}h1{margin:0;font-size:26px}h2{font-size:18px;margin:0 0 10px}p{margin:10px 0}.hint,small{color:#5d7568;font-size:14px}.card,details{background:#fff;border:1px solid #dce4d7;border-radius:16px;padding:20px;margin-top:16px}summary{cursor:pointer;font-weight:600}.weight{font-size:46px;font-weight:650;font-variant-numeric:tabular-nums}.weight small{font-size:20px}button{font:inherit;border:1px solid #d0ddce;background:#edf3e9;color:#263d35;border-radius:10px;padding:12px 16px;min-height:48px;cursor:pointer;width:100%;margin-top:10px}button.primary{background:#43745d;color:white;border-color:#43745d}button:disabled{opacity:.45;cursor:default}input,select{font:inherit;padding:10px;border:1px solid #cad7c9;border-radius:8px;width:100%;margin:6px 0 8px}label{display:block;margin-top:12px}#notice:empty,#device-error:empty{display:none}#notice,#device-error{padding:12px;border-radius:10px;background:#edf3e9;overflow-wrap:anywhere}#notice[data-error],#device-error{background:#fff0e9;color:#974726}#connection{overflow-wrap:anywhere}ol{padding-left:23px}li{margin:12px 0}:focus-visible{outline:3px solid #82a48b;outline-offset:3px}
.password-field{display:flex;gap:8px;align-items:center;margin:6px 0 8px}.password-field input{min-width:0;flex:1;margin:0}.password-field button{flex:none;width:auto;margin:0;white-space:nowrap}#network-status{overflow-wrap:anywhere}#network-status[data-connected]{background:#e6f4e9;border:2px solid #43745d}#network-status[data-connected] #network{color:#24543b;font-size:23px;font-weight:700;margin-top:0}#network-status[data-connected] .hint{color:#365f48}#notice{position:fixed;z-index:10;left:16px;right:16px;bottom:20px;max-width:480px;max-height:70vh;overflow:auto;margin:0 auto;padding:20px;background:#fff;border:1px solid #a8c7b1;box-shadow:0 12px 40px #183c3533}#notice p{margin-top:0}#notice[hidden]{display:none}
</style>
</head>
<body>
<main>
<h1>给杯垫连接 Wi-Fi</h1><p id="connection" class="hint" role="status">正在连接杯垫热点…</p>
<section id="network-status" class="card" role="status">
<p id="network">正在读取联网状态…</p>
<p id="next-step" class="hint" hidden></p>
</section>
<p class="hint">选择家里或办公室的 2.4 GHz Wi-Fi，输入密码后保存，杯垫自动重启连接。手机和 Mac 都可以在这里配网。</p>
<section class="card" aria-labelledby="wifi-title">
<h2 id="wifi-title">Wi-Fi 设置</h2>
<form id="wifi-form">
<label for="wifi-list">附近的 Wi-Fi</label><select id="wifi-list" required disabled><option value="">请选择 Wi-Fi</option><option value="manual">手动输入（隐藏网络）</option></select>
<button id="scan" type="button" disabled>重新扫描</button><p id="scan-state" class="hint" role="status">连接杯垫后自动扫描附近网络。</p>
<div id="manual-network" hidden><label for="ssid">Wi-Fi 名称</label><input id="ssid" maxlength="32" autocomplete="off" placeholder="输入完整的 Wi-Fi 名称"></div>
<label for="password">Wi-Fi 密码</label><div class="password-field"><input id="password" type="password" maxlength="63" autocomplete="off" placeholder="输入该网络的密码，开放网络留空"><button id="show-password" type="button" aria-controls="password" aria-pressed="false">显示密码</button></div><button id="wifi" class="primary" disabled>保存并连接 Wi-Fi</button></form>
<p class="hint">杯垫重启时热点会暂时断开。重新连接 Water- 热点后，本页会自动检查结果；热点密码见杯垫屏幕。新网络连接失败时自动恢复原网络。</p>
<button id="reboot" hidden disabled>重启杯垫以应用配置</button>
</section>
<section class="card" aria-labelledby="binding-title">
<h2 id="binding-title">绑定你的账号</h2><p id="binding-state" role="status">等待连接云服务…</p>
<p id="binding-code" class="weight"></p><p id="binding-expiry" class="hint"></p>
<p><a id="cloud-link" hidden target="_blank" rel="noopener noreferrer">打开水伴网站</a></p>
<button id="binding" type="button" disabled>获取 / 刷新绑定码</button>
<p class="hint">记下绑定码，切回手机正常网络后打开网站，注册或登录，再输入绑定码。换 Wi-Fi 保留原账号和记录，无需重复绑定。</p>
</section>
<details id="control-panel">
<summary>空杯与称重设置</summary>
<section class="card" aria-labelledby="weight-title">
<h2 id="weight-title">当前重量</h2><div class="weight"><span id="weight">—</span> <small>g</small></div>
<p id="reading" class="hint">等待读数</p><p id="device-error" role="alert"></p>
<p>空杯重量 <strong id="cup-weight">—</strong></p>
<button id="cup" class="primary" disabled>更新空杯重量</button>
<p class="hint">放上空杯，静置至少 3 秒再更新。换杯时更新一次即可；喝水后放回，自动记录前后差值。</p>
</section>
<section class="card" aria-labelledby="event-title">
<h2 id="event-title">本次开机最近一次记录</h2><p id="last-event">尚无记录</p>
<p id="queue" class="hint">正在读取记录状态…</p>
<p class="hint">关闭手机页面后杯垫继续记录。减少记为估算饮水，增加记为补水；倒水也会计入减少量。</p>
</section>
<p id="server" class="hint"></p>

</details>
<p class="hint">配网热点没有互联网，提示时选择继续连接。若页面没有自动打开，在浏览器地址栏输入 http://192.168.4.1。</p>
</main>
<aside id="notice" role="status" hidden><p id="notice-text"></p><button id="notice-close" type="button">知道了</button></aside>
<script>
const $ = (id) => document.getElementById(id);
let device = null, busy = false, polling = null, pendingWifi = '', scanStarted = false, networks = [];
const commands = ['cup', 'binding', 'wifi', 'reboot', 'scan'];
function enable() {
  for (const id of commands) $(id).disabled = busy || !device || (id === 'cup' && !device.calibrated) || (id === 'binding' && (!device?.serverConnected || device?.bound));
  $('wifi-list').disabled = busy || !device;
}
function notice(message, error = false) {
  $('notice-text').textContent = message;
  $('notice').toggleAttribute('data-error', error);
  $('notice').hidden = false;
}
function showPassword(visible) {
  $('password').type = visible ? 'text' : 'password';
  $('show-password').textContent = visible ? '隐藏密码' : '显示密码';
  $('show-password').setAttribute('aria-pressed', String(visible));
}
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); }
    catch { throw new Error(response.ok ? '设备响应格式异常，请刷新页面重试。' : (text || '设备拒绝了请求')); }
    if (!response.ok || value.ok === false) throw new Error(value.error || '设备拒绝了操作');
    return value;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError)
      throw new Error(body ? '未收到操作确认，请重新连接热点并检查设备状态，再决定是否重试。' : '无法连接杯垫，请检查手机是否仍连接杯垫热点。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function render(value) {
  device = value;
  $('connection').textContent = `${value.apSsid} · 热点已连接 · 固件 ${value.firmwareVersion}`;
  $('weight').textContent = value.weightGrams === null ? '—' : value.weightGrams.toFixed(1);
  $('reading').textContent = value.calibrated ? (value.stable ? '读数稳定' : '等待稳定') : '出厂标定异常，请联系售后';
  $('device-error').textContent = value.error || '';
  $('cup-weight').textContent = value.emptyCupGrams >= 5 ? `${value.emptyCupGrams.toFixed(1)} g` : '未设置';
  const event = value.lastEvent;
  $('last-event').textContent = event ? `${event.kind === 'drink' ? '估算饮水' : '补水'} ${event.amountMl.toFixed(1)} ml · ${event.beforeGrams.toFixed(1)} → ${event.afterGrams.toFixed(1)} g${event.saved ? ' · 已保存' : ' · 保存失败，请勿断电'}` : '尚无记录';
  $('queue').textContent = `待上传 ${value.pendingCount} 条${value.timePendingCount ? `，其中 ${value.timePendingCount} 条时间待确认` : ''}。${value.clockSynced ? '已校时' : '尚未校时'}`;
  const applied = !value.restartRequired && !value.wifiTrial && (!pendingWifi || value.wifiSsid === pendingWifi);
  const connected = applied && value.wifiConnected && !value.wifiRollback && !value.wifiSaveError;
  let wifi = '尚未配网，请选择 Wi-Fi 并输入密码。';
  if (!applied) wifi = value.wifiTrial ? '正在验证新 Wi-Fi，失败时保留原网络，请稍候…' : '正在应用 Wi-Fi 配置，等待杯垫重启后验证连接。';
  else if (connected) wifi = `已经成功连接 ${value.wifiSsid || 'Wi-Fi'}`;
  else if (value.wifiConfigured) {
    const reasons = { 201: '未找到网络，请确认名称、距离和 2.4 GHz 设置', 202: '认证失败，请检查 Wi-Fi 密码',
      15: '握手失败，请检查 Wi-Fi 密码和信号', 204: '握手失败，请检查 Wi-Fi 密码和信号' };
    wifi = value.wifiReason ? `连接失败：${reasons[value.wifiReason] || `请检查网络（原因 ${value.wifiReason}）`}，可修改后重新保存。`
      : `正在连接 ${value.wifiSsid || 'Wi-Fi'}，请稍候…`;
  }
  if (value.wifiRollback) { wifi = '新 Wi-Fi 未连接成功，已保留原网络。请检查密码、2.4 GHz 设置后重试。'; pendingWifi = ''; }
  if (value.wifiSaveError) wifi += ' Wi-Fi 状态保存失败，请保持供电，设备正在重试；持续失败请联系售后。';
  $('network').textContent = wifi;
  $('network-status').toggleAttribute('data-connected', connected);
  $('next-step').hidden = !connected;
  if (connected) $('next-step').textContent = 'Wi-Fi 已连接。待云服务连接后记下绑定码，再将手机切回正常网络打开网站；杯垫以后自动连接。';
  $('reboot').hidden = !value.restartRequired;
  if (pendingWifi && connected) { pendingWifi = ''; notice(`${wifi}。可以将手机或 Mac 切回该 Wi-Fi。`); }
  const server = value.serverConnected ? '已连接' : (value.serverConfigured ? `未连接${value.httpStatus ? `（HTTP ${value.httpStatus}）` : ''}` : '未配置');
  $('server').textContent = `云服务${server}。`;
  const code = !value.bound && value.bindingCode && value.bindingExpiresAt > Date.now() ? value.bindingCode : '';
  $('binding-code').textContent = code;
  $('binding-expiry').textContent = code ? '绑定码 5 分钟内有效，仅限一次使用。' : '';
  $('binding-state').textContent = !value.serverConfigured || !value.cloudUrl ? '设备尚未完成出厂设置，请联系售后。'
    : value.bound ? '已绑定账号，切回正常网络后登录网站查看。'
    : !value.serverConnected ? '等待云服务连接，请先完成 Wi-Fi 配网。'
    : code ? '请在网站登录后输入以下绑定码。' : '点击下方按钮获取绑定码，过期后可重新获取。';
  const url = /^https?:\/\/[^/?#@]+\/?$/.test(value.cloudUrl || '') ? value.cloudUrl : '';
  $('cloud-link').hidden = !url;
  if (url) { $('cloud-link').href = url; $('cloud-link').textContent = `打开水伴网站：${url}`; }
  enable();
}
function disconnected(error) {
  device = null;
  $('connection').textContent = error.message;
  $('network').textContent = pendingWifi ? '正在等待杯垫重启，请重新连接 Water- 热点。本页恢复后会检查配网结果。' : '尚未读取到最新联网状态，请重新连接杯垫热点。';
  $('network-status').toggleAttribute('data-connected', false);
  $('next-step').hidden = true;
  $('weight').textContent = '—';
  $('reading').textContent = '连接已断开，其他信息为断开前状态';
  enable();
}
async function refresh() {
  const value = await api('/api/status');
  render(value);
  if (!value.clockSynced) await api('/api/time', { epochMs: Date.now() });
}
async function poll() {
  if (busy || polling) return;
  polling = refresh().catch(disconnected);
  try { await polling; } finally { polling = null; }
  if (device && !scanStarted && !busy) { scanStarted = true; await scanWifi(); }
}
async function scanWifi() {
  if (busy || !device) return;
  busy = true; enable();
  $('scan-state').textContent = '正在扫描附近的 2.4 GHz Wi-Fi…';
  try {
    await polling;
    const value = await api('/api/wifi-scan');
    const seen = new Set();
    networks = value.networks.sort((a, b) => b.rssi - a.rssi).filter((item) => {
      if (!item.ssid || seen.has(item.ssid)) return false;
      seen.add(item.ssid); return true;
    });
    const selected = networks.findIndex((item) => item.ssid === $('ssid').value);
    const manual = $('wifi-list').value === 'manual' || ($('ssid').value && selected < 0);
    $('wifi-list').replaceChildren(new Option('请选择 Wi-Fi', ''), ...networks.map((item, index) =>
      new Option(`${item.ssid} · 信号${item.rssi >= -60 ? '强' : item.rssi >= -75 ? '中' : '弱'}`, String(index))),
      new Option('手动输入（隐藏网络）', 'manual'));
    $('wifi-list').value = manual ? 'manual' : selected >= 0 ? String(selected) : '';
    $('manual-network').hidden = !manual;
    $('ssid').required = !!manual;
    $('scan-state').textContent = networks.length ? `找到 ${networks.length} 个网络，请选择。` : '未发现网络，可重新扫描或选择手动输入。';
  } catch (error) { $('scan-state').textContent = `扫描失败：${error.message} 也可选择手动输入。`; }
  finally { busy = false; enable(); }
}
async function act(action) {
  if (busy) return;
  busy = true; enable(); notice('正在等待杯垫确认…');
  try {
    await polling;
    await action();
    try { await refresh(); } catch (error) { disconnected(error); }
  } catch (error) { notice(error.message, true); }
  finally { busy = false; enable(); }
}
async function command(cmd, extra = {}) {
  const result = await api('/api/command', { cmd, ...extra });
  notice(result.message);
}
$('cup').onclick = () => act(() => command('cup'));
$('notice-close').onclick = () => { $('notice').hidden = true; };
$('show-password').onclick = () => showPassword($('password').type === 'password');
$('scan').onclick = scanWifi;
$('wifi-list').onchange = () => {
  const manual = $('wifi-list').value === 'manual';
  const ssid = networks[$('wifi-list').value]?.ssid || '';
  if (ssid !== $('ssid').value) { $('password').value = ''; showPassword(false); }
  $('ssid').value = ssid;
  $('ssid').required = manual;
  $('manual-network').hidden = !manual;
};
$('binding').onclick = () => act(async () => { await api('/api/binding', {}); notice('正在申请绑定码，请等待页面更新。'); });
$('wifi-form').onsubmit = (event) => { event.preventDefault(); void act(async () => {
  const ssid = $('ssid').value;
  await command('wifi', { ssid, password: $('password').value });
  pendingWifi = ssid;
  $('password').value = '';
  showPassword(false);
  try {
    await command('reboot');
    notice('Wi-Fi 已保存，杯垫正在重启。请重新连接 Water- 热点，等待本页确认连接结果。');
  }
  catch (error) { throw new Error(`Wi-Fi 已保存，重启尚未确认。${error.message}`); }
}); };
$('reboot').onclick = () => act(() => command('reboot'));
void poll(); setInterval(() => void poll(), 2000);
</script>
</body>
</html>)HTML";

static bool local_address_is(httpd_req_t *request, const char *expected)
{
    sockaddr_storage local = {};
    socklen_t size = sizeof(local);
    if (getsockname(httpd_req_to_sockfd(request), reinterpret_cast<sockaddr *>(&local), &size) != 0) return false;
    uint32_t ip = 0;
    if (local.ss_family == AF_INET && size >= sizeof(sockaddr_in)) {
        ip = reinterpret_cast<sockaddr_in *>(&local)->sin_addr.s_addr;
    } else if (local.ss_family == AF_INET6 && size >= sizeof(sockaddr_in6)) {
        // ESP-IDF 的双栈 HTTP 服务会将 IPv4 热点连接表示为 ::ffff:192.168.4.1。
        const auto *address = &reinterpret_cast<sockaddr_in6 *>(&local)->sin6_addr;
        if (!IN6_IS_ADDR_V4MAPPED(address)) return false;
        memcpy(&ip, address->s6_addr + 12, sizeof(ip));
    } else return false;
    return ip == inet_addr(expected);
}

static bool allowed(httpd_req_t *request)
{
    if (!local_address_is(request, CONTROL_IP)) return false;
    char host[64], origin[64], site[24];
    if (httpd_req_get_hdr_value_str(request, "Host", host, sizeof(host)) != ESP_OK
        || (strcmp(host, CONTROL_IP) && strcmp(host, CONTROL_IP ":80"))) return false;
    // 首页不读取设备信息；允许从聊天链接进入，接口仍要求同源访问。
    if (request->method == HTTP_GET && request->uri[0] == '/'
        && (request->uri[1] == '\0' || request->uri[1] == '?')) return true;
    if (httpd_req_get_hdr_value_len(request, "Origin")
        && (httpd_req_get_hdr_value_str(request, "Origin", origin, sizeof(origin)) != ESP_OK
            || (strcmp(origin, "http://" CONTROL_IP) && strcmp(origin, "http://" CONTROL_IP ":80")))) return false;
    if (httpd_req_get_hdr_value_len(request, "Sec-Fetch-Site")
        && (httpd_req_get_hdr_value_str(request, "Sec-Fetch-Site", site, sizeof(site)) != ESP_OK
            || (strcmp(site, "same-origin") && strcmp(site, "none")))) return false;
    return true;
}

static bool user_command(const char *name)
{
    return !strcmp(name, "cup") || !strcmp(name, "wifi") || !strcmp(name, "reboot");
}

static esp_err_t send_error(httpd_req_t *request, const char *status, const char *message)
{
    httpd_resp_set_status(request, status);
    // SDK 的默认错误响应会重置为不带 charset 的 text/html，中文可能被错误解码。
    httpd_resp_set_type(request, "text/plain; charset=utf-8");
    return httpd_resp_send(request, message, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t send_json(httpd_req_t *request, cJSON *json)
{
    if (!json) return send_error(request, "500 Internal Server Error", "内存不足");
    char *text = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (!text) return send_error(request, "500 Internal Server Error", "内存不足");
    httpd_resp_set_type(request, "application/json; charset=utf-8");
    esp_err_t result = httpd_resp_send(request, text, HTTPD_RESP_USE_STRLEN);
    cJSON_free(text);
    return result;
}

static esp_err_t scan_networks(httpd_req_t *request)
{
    wifi_ap_record_t records[20];
    uint16_t count = sizeof(records) / sizeof(records[0]);
    esp_err_t result = network_scan(records, &count);
    if (result != ESP_OK)
        return send_error(request, "503 Service Unavailable", result == ESP_ERR_WIFI_STATE
            ? "杯垫正在连接 Wi-Fi，请稍后重新扫描。" : "扫描未完成，请稍后重试。");
    cJSON *json = cJSON_CreateObject();
    if (!json) return send_error(request, "500 Internal Server Error", "内存不足");
    cJSON *networks = cJSON_AddArrayToObject(json, "networks");
    if (!networks) { cJSON_Delete(json); return send_error(request, "500 Internal Server Error", "内存不足"); }
    for (uint16_t i = 0; i < count; ++i) {
        records[i].ssid[32] = 0;
        if (!records[i].ssid[0]) continue;
        cJSON *item = cJSON_CreateObject();
        if (!item || !cJSON_AddStringToObject(item, "ssid", reinterpret_cast<const char *>(records[i].ssid))
            || !cJSON_AddNumberToObject(item, "rssi", records[i].rssi)) {
            cJSON_Delete(item); cJSON_Delete(json);
            return send_error(request, "500 Internal Server Error", "内存不足");
        }
        cJSON_AddItemToArray(networks, item);
    }
    return send_json(request, json);
}

static esp_err_t handle(httpd_req_t *request)
{
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    httpd_resp_set_hdr(request, "X-Content-Type-Options", "nosniff");
    httpd_resp_set_hdr(request, "X-Frame-Options", "DENY");
    if (!allowed(request)) return send_error(request, "403 Forbidden", "请先连接 Water- 热点，再在浏览器地址栏输入 http://192.168.4.1");
    if (request->method == HTTP_GET) {
        if (!strncmp(request->uri, "/api/status", strlen("/api/status"))) return send_json(request, device_status_json());
        if (!strncmp(request->uri, "/api/wifi-scan", strlen("/api/wifi-scan"))) return scan_networks(request);
        httpd_resp_set_type(request, "text/html; charset=utf-8");
        return httpd_resp_send(request, PAGE, sizeof(PAGE) - 1);
    }
    char content_type[64];
    if (httpd_req_get_hdr_value_str(request, "Content-Type", content_type, sizeof(content_type)) != ESP_OK
        || strcmp(content_type, "application/json"))
        return send_error(request, "400 Bad Request", "需要 JSON 请求");
    char body[768];
    if (!request->content_len || request->content_len >= sizeof(body))
        return send_error(request, "400 Bad Request", "请求长度无效");
    size_t received = 0;
    while (received < request->content_len) {
        int length = httpd_req_recv(request, body + received, request->content_len - received);
        if (length <= 0) return send_error(request, "408 Request Timeout", "读取请求超时");
        received += length;
    }
    body[received] = 0;
    cJSON *json = memchr(body, 0, received) ? nullptr : cJSON_ParseWithOpts(body, nullptr, true);
    // cJSON 的字符串以 NUL 结尾；拒绝转义 NUL，避免实际保存值被截断。
    if (!cJSON_IsObject(json) || strstr(body, "\\u0000")) {
        cJSON_Delete(json);
        return send_error(request, "400 Bad Request", "请求内容无效");
    }
    cJSON *response = nullptr;
    if (!strcmp(request->uri, "/api/binding")) {
        bool valid = network_request_binding() == ESP_OK;
        response = cJSON_CreateObject();
        cJSON_AddBoolToObject(response, "ok", valid);
        if (!valid) cJSON_AddStringToObject(response, "error", "请等待云服务连接；已绑定设备无需再次绑定");
    } else if (!strcmp(request->uri, "/api/time")) {
        const cJSON *epoch = cJSON_GetObjectItemCaseSensitive(json, "epochMs");
        bool valid = cJSON_IsNumber(epoch) && std::isfinite(epoch->valuedouble)
            && epoch->valuedouble >= 1704067200000.0 && epoch->valuedouble < 4102444800000.0
            && network_set_time(static_cast<int64_t>(epoch->valuedouble));
        response = cJSON_CreateObject();
        cJSON_AddBoolToObject(response, "ok", valid);
        if (!valid) cJSON_AddStringToObject(response, "error", "手机时间无效，请检查系统日期");
    } else {
        const cJSON *cmd = cJSON_GetObjectItemCaseSensitive(json, "cmd");
        const char *name = cJSON_IsString(cmd) ? cmd->valuestring : "";
        if (user_command(name)) response = device_command(json);
        else {
            response = cJSON_CreateObject();
            cJSON_AddBoolToObject(response, "ok", false);
            cJSON_AddStringToObject(response, "error", "不支持的设备操作");
        }
    }
    memset(body, 0, sizeof(body));
    cJSON_Delete(json);
    if (response && cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(response, "ok")))
        httpd_resp_set_status(request, "400 Bad Request");
    return send_json(request, response);
}

esp_err_t control_start(void)
{
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.stack_size = 8192;
    config.max_open_sockets = 4;
    config.lru_purge_enable = true;
    config.recv_wait_timeout = 3;
    config.send_wait_timeout = 3;
    httpd_handle_t server = nullptr;
    esp_err_t result = httpd_start(&server, &config);
    if (result != ESP_OK) return result;
    const char *paths[] = { "/", "/api/status", "/api/wifi-scan", "/api/command", "/api/time", "/api/binding" };
    for (unsigned i = 0; i < sizeof(paths) / sizeof(paths[0]); ++i) {
        httpd_uri_t route = {};
        route.uri = paths[i];
        route.method = i < 3 ? HTTP_GET : HTTP_POST;
        route.handler = handle;
        result = httpd_register_uri_handler(server, &route);
        if (result != ESP_OK) { httpd_stop(server); return result; }
    }
    return ESP_OK;
}
