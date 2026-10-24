#include <Arduino.h>
#include <SPI.h>
#include <math.h>
#include "esp_timer.h"
#include "esp_wifi_types.h"
#include "board_config.h"
#include "device.h"
#include "display.h"
#include "display_font.h"
#include "network.h"
#include "storage.h"
#include "ble_provision.h"
#include "provisioning.h"

static const uint16_t WHITE = 0xffff, GRAY = 0x94b2, GREEN = 0x57f4, AMBER = 0xfda8, RED = 0xfaaa;
static const int ROW_HEIGHT = 20;
static const int row_y[] = {48, 68, 88, 122, 142, 162, 196, 216, 236, 272, 294};
static SPISettings lcd_spi(40000000, MSBFIRST, SPI_MODE0);
static bool ready;
static int64_t wake_until_ms;
static uint8_t pixels[LCD_WIDTH * ROW_HEIGHT * 2];
static struct {
    char text[96];
    uint16_t color;
} previous[sizeof(row_y) / sizeof(row_y[0])];

static void write_command(uint8_t command, const uint8_t *data = nullptr, size_t length = 0)
{
    SPI.beginTransaction(lcd_spi);
    digitalWrite(LCD_CS_PIN, LOW);
    digitalWrite(LCD_DC_PIN, LOW);
    SPI.transfer(command);
    if (length) {
        digitalWrite(LCD_DC_PIN, HIGH);
        SPI.writeBytes(data, length);
    }
    digitalWrite(LCD_CS_PIN, HIGH);
    SPI.endTransaction();
}

static void draw_pixels(int y, int height)
{
    int x0 = LCD_X_OFFSET, x1 = x0 + LCD_WIDTH - 1, y1 = y + height - 1;
    uint8_t columns[] = {uint8_t(x0 >> 8), uint8_t(x0), uint8_t(x1 >> 8), uint8_t(x1)};
    uint8_t rows[] = {uint8_t(y >> 8), uint8_t(y), uint8_t(y1 >> 8), uint8_t(y1)};
    write_command(0x2a, columns, sizeof(columns));
    write_command(0x2b, rows, sizeof(rows));
    write_command(0x2c, pixels, LCD_WIDTH * height * 2);
}

static uint16_t next_character(const char **text)
{
    const uint8_t *p = reinterpret_cast<const uint8_t *>(*text);
    if (p[0] < 0x80) { ++*text; return p[0]; }
    if ((p[0] & 0xe0) == 0xc0 && p[1] && (p[1] & 0xc0) == 0x80) {
        *text += 2;
        return ((p[0] & 0x1f) << 6) | (p[1] & 0x3f);
    }
    if ((p[0] & 0xf0) == 0xe0 && p[1] && (p[1] & 0xc0) == 0x80
        && p[2] && (p[2] & 0xc0) == 0x80) {
        *text += 3;
        return ((p[0] & 0x0f) << 12) | ((p[1] & 0x3f) << 6) | (p[2] & 0x3f);
    }
    ++*text;
    return '?';
}

static const display_glyph_t *find_glyph(uint16_t code)
{
    for (const auto &glyph : DISPLAY_GLYPHS)
        if (glyph.code == code) return &glyph;
    return find_glyph('?');
}

static void draw_text(int y, const char *text, uint16_t color)
{
    memset(pixels, 0, sizeof(pixels));
    int x = 8;
    while (*text) {
        const display_glyph_t *glyph = find_glyph(next_character(&text));
        if (x + glyph->width > LCD_WIDTH - 8) break;
        for (int row = 0; row < 16; ++row) {
            for (int column = 0; column < glyph->width; ++column) {
                if (!(glyph->rows[row] & (0x8000 >> column))) continue;
                size_t offset = ((row + 2) * LCD_WIDTH + x + column) * 2;
                pixels[offset] = color >> 8;
                pixels[offset + 1] = color & 0xff;
            }
        }
        x += glyph->width;
    }
    draw_pixels(y, ROW_HEIGHT);
}

static void line(unsigned row, const char *text, uint16_t color)
{
    if (previous[row].color == color && !strcmp(previous[row].text, text)) return;
    snprintf(previous[row].text, sizeof(previous[row].text), "%s", text);
    previous[row].color = color;
    draw_text(row_y[row], text, color);
}

bool display_start(void)
{
    pinMode(LCD_CS_PIN, OUTPUT);
    pinMode(LCD_DC_PIN, OUTPUT);
    pinMode(LCD_RST_PIN, OUTPUT);
    pinMode(LCD_BL_PIN, OUTPUT);
    digitalWrite(LCD_CS_PIN, HIGH);
    digitalWrite(LCD_BL_PIN, LOW);
    if (!SPI.begin(LCD_SCLK_PIN, -1, LCD_MOSI_PIN, LCD_CS_PIN)) return false;
    digitalWrite(LCD_RST_PIN, HIGH);
    delay(20);
    digitalWrite(LCD_RST_PIN, LOW);
    delay(20);
    digitalWrite(LCD_RST_PIN, HIGH);
    delay(120);
    write_command(0x11);
    delay(120);
    uint8_t format = 0x55, direction = 0x08;
    write_command(0x3a, &format, 1);
    write_command(0x36, &direction, 1);
    write_command(0x21);
    write_command(0x13);
    delay(10);
    memset(pixels, 0, sizeof(pixels));
    for (int y = 0; y < LCD_HEIGHT; y += ROW_HEIGHT) draw_pixels(y, ROW_HEIGHT);
    write_command(0x29);
    delay(120);
    ready = true;
    draw_text(12, "水伴杯垫 " FIRMWARE_VERSION, WHITE);
    line(0, "正在启动", AMBER);
    return true;
}

void display_wake(void)
{
    wake_until_ms = esp_timer_get_time() / 1000 + 15000;
}

void display_update(esp_err_t startup_result)
{
    if (!ready) return;
    // 亮屏只由按键续时，称重、配网和故障状态均不能自动唤醒。
    bool awake = esp_timer_get_time() / 1000 < wake_until_ms;
    static bool backlight = false;
    if (awake != backlight) {
        digitalWrite(LCD_BL_PIN, awake ? HIGH : LOW);
        backlight = awake;
    }
    if (!awake) return;
    if (startup_result != ESP_OK) {
        char code[32];
        snprintf(code, sizeof(code), "错误码: 0x%x", unsigned(startup_result));
        line(0, "初始化失败", RED);
        line(1, code, GRAY);
        line(2, "请查看串口错误", WHITE);
        return;
    }
    network_status_t network;
    device_status_t device;
    network_snapshot(&network);
    device_snapshot(&device);
    ble_provision_display_t ble;
    ble_provision_snapshot(&ble);
    bool provisioning = provisioning_busy();
    if (ble.pairing) {
        char pin[24];
        snprintf(pin, sizeof(pin), "%06lu", (unsigned long)ble.passkey);
        line(0, "BLE 配网密码", AMBER);
        line(1, pin, WHITE);
        line(2, "手机连接密码", WHITE);
        line(3, "配网窗口10分钟", GRAY);
    } else if (provisioning) {
        line(0, "正在配网", GRAY);
        line(1, ble.stage, AMBER);
        line(2, "请勿断电", WHITE);
        line(3, "请查看网站", GRAY);
    } else if (network.control_error != ESP_OK) {
        char code[32];
        snprintf(code, sizeof(code), "错误码: 0x%x", unsigned(network.control_error));
        line(0, ble.window_open ? "BLE: Water-Coaster" : "配网热点", AMBER);
        line(1, "HTTP 错误", RED);
        line(2, "长按BOOT 3秒", WHITE);
        line(3, code, GRAY);
    } else if (ble.window_open) {
        line(0, "BLE: Water-Coaster", GREEN);
        if (network.ap_ready && network.control_ready) {
            char password[40];
            snprintf(password, sizeof(password), "密码: %s", network.ap_password);
            line(1, network.ap_ssid, WHITE);
            line(2, password, WHITE);
            line(3, CONTROL_IP, GRAY);
        } else {
            line(1, "网站配网", WHITE);
            line(2, "配网窗口10分钟", GRAY);
            line(3, ble.stage, GRAY);
        }
    } else if (network.ap_ready && network.control_ready) {
        char password[40];
        snprintf(password, sizeof(password), "密码: %s", network.ap_password);
        line(0, "配网热点", GREEN);
        line(1, network.ap_ssid, GREEN);
        line(2, password, WHITE);
        line(3, CONTROL_IP, GRAY);
    } else {
        line(0, "长按BOOT 3秒", GRAY);
        line(1, "开启配网热点", WHITE);
        line(2, "配网窗口10分钟", GRAY);
        line(3, network.bound ? "账号已绑定" : "等待账号绑定", network.bound ? GREEN : AMBER);
    }
    const char *wifi = "Wi-Fi 未配置";
    if (network.wifi_connected) wifi = "Wi-Fi 已连接";
    else if (network.wifi_configured) {
        wifi = network.wifi_reason ? "Wi-Fi 连接失败" : "Wi-Fi 正在连接";
        if (network.wifi_reason == WIFI_REASON_NO_AP_FOUND) wifi = "Wi-Fi 未找到网络";
        else if (network.wifi_reason == WIFI_REASON_AUTH_FAIL
            || network.wifi_reason == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT
            || network.wifi_reason == WIFI_REASON_HANDSHAKE_TIMEOUT) wifi = "Wi-Fi 检查密码";
    }
    line(4, wifi, network.wifi_connected ? GREEN : GRAY);
    const char *server = "出厂设置异常";
    if (network.server_connected) server = "服务器已连接";
    else if (network.server_configured) {
        if (!network.wifi_connected) server = "服务器等待Wi-Fi";
        else if (network.waiting_for_time) server = "服务器等待校时";
        else if (network.http_status == 401 || network.http_status == 403) server = "服务器凭证错误";
        else server = network.server_error != ESP_OK ? "服务器连接失败" : "服务器正在连接";
    }
    line(5, server, network.server_connected ? GREEN : GRAY);
    line(6, "称重", GRAY);
    if (network.binding_code[0]) {
        line(6, "账号绑定码", GRAY);
        line(7, network.binding_code, WHITE);
        line(8, "网站登录后绑定", AMBER);
    } else if (!device.sensor_ready) {
        line(7, "传感器未就绪", RED);
        line(8, "检查HX711接线供电", GRAY);
    } else if (!device.calibrated) {
        line(7, "出厂标定异常", RED);
        line(8, "请联系售后", GRAY);
    } else if (!isfinite(device.weight) || device.weight < -2 || device.weight > WEIGHING_MAX_GRAMS) {
        line(7, "重量异常", RED);
        line(8, "检查承重和校准", GRAY);
    } else {
        char weight[32];
        snprintf(weight, sizeof(weight), "%.1f g", device.weight);
        line(7, weight, WHITE);
        line(8, device.empty_cup < 5 ? "请先登记空杯" : device.stable ? "读数稳定" : "等待稳定", GRAY);
    }
    if (device.unsaved_event) {
        line(9, "保存失败，请勿断电", RED);
        line(10, "恢复上传后重试", GRAY);
    } else if (device.restart_required) {
        line(9, "联网设置已保存", AMBER);
        line(10, "请重启以生效", WHITE);
    } else {
        unsigned pending, time_pending;
        storage_counts(&pending, &time_pending);
        char queue[48];
        snprintf(queue, sizeof(queue), "待上传 %u 条", pending);
        line(9, queue, pending ? AMBER : GRAY);
        if (time_pending) {
            snprintf(queue, sizeof(queue), "待定时间 %u 条", time_pending);
            line(10, queue, AMBER);
        } else line(10, "网站设置空杯", GRAY);
    }
}
