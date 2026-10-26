#include <Arduino.h>
#include <SPI.h>
#include <math.h>
#include "esp_timer.h"
#include "esp_wifi_types.h"
#include "board_config.h"
#include "device.h"
#include "display.h"
#include "display_font.h"
#include "display_daily_font.h"
#include "network.h"
#include "storage.h"
#include "ble_provision.h"
#include "provisioning.h"

static const uint16_t WHITE = 0xffff, GRAY = 0x94b2, GREEN = 0x57f4, AMBER = 0xfda8, RED = 0xfaaa;
static const uint16_t BLUE = 0x663f, ORANGE = 0xfdec, DIVIDER = 0x4208;
static const int ROW_HEIGHT = 20;
static const int row_y[] = {48, 68, 88, 122, 142, 162, 196, 216, 236, 272, 294};
static SPISettings lcd_spi(40000000, MSBFIRST, SPI_MODE0);
static bool ready;
static bool sleeping;
static int64_t wake_until_ms;
static uint8_t pixels[LCD_WIDTH * ROW_HEIGHT * 2];
static struct {
    char text[96];
    uint16_t color;
} previous[sizeof(row_y) / sizeof(row_y[0])];
static int current_page = -1;

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

static void select_page(int page)
{
    if (page == current_page) return;
    current_page = page;
    memset(previous, 0, sizeof(previous));
    memset(pixels, 0, sizeof(pixels));
    for (int y = 0; y < LCD_HEIGHT; y += ROW_HEIGHT) draw_pixels(y, ROW_HEIGHT);
    if (page != 1) draw_text(12, "水伴杯垫 " FIRMWARE_VERSION, WHITE);
}

struct daily_view_t {
    char connection[32], total[24], water[48], count[16], last[24], age[48], notice[96];
    uint16_t connection_color, notice_color;
    bool total_ready, water_ready, last_ready;
};
static daily_view_t previous_daily;
static bool daily_drawn;
static int stripe_y;

static const daily_font_t &daily_font(int size, bool number = false)
{
    const daily_font_t *fonts = number ? DAILY_NUMBER_FONTS : DAILY_TEXT_FONTS;
    size_t count = number ? sizeof(DAILY_NUMBER_FONTS) / sizeof(*fonts) : sizeof(DAILY_TEXT_FONTS) / sizeof(*fonts);
    size_t index = 0;
    while (index + 1 < count && fonts[index + 1].size <= size) ++index;
    return fonts[index];
}

static const daily_glyph_t &daily_glyph(const daily_font_t &font, uint16_t code)
{
    for (unsigned i = 0; i < font.count; ++i)
        if (font.glyphs[i].code == code) return font.glyphs[i];
    return daily_glyph(font, '?');
}

static int text_width(const char *text, int size, bool number = false)
{
    const daily_font_t &font = daily_font(size, number);
    int width = 0;
    while (*text) width += daily_glyph(font, next_character(&text)).advance;
    return width;
}

static void pixel(int x, int y, uint16_t color)
{
    if (x < 0 || x >= LCD_WIDTH || y < stripe_y || y >= stripe_y + ROW_HEIGHT || y >= LCD_HEIGHT) return;
    size_t offset = ((y - stripe_y) * LCD_WIDTH + x) * 2;
    pixels[offset] = color >> 8;
    pixels[offset + 1] = color & 0xff;
}

static uint16_t shade(uint16_t color, uint8_t alpha)
{
    return ((((color >> 11) * alpha + 7) / 15) << 11)
        | (((((color >> 5) & 63) * alpha + 7) / 15) << 5)
        | (((color & 31) * alpha + 7) / 15);
}

static void paint_text(int x, int baseline, const char *text, int size, uint16_t color, bool number = false)
{
    const daily_font_t &font = daily_font(size, number);
    while (*text) {
        const daily_glyph_t &glyph = daily_glyph(font, next_character(&text));
        int y = baseline + glyph.top;
        for (int row = 0; row < glyph.height; ++row) {
            if (y + row < stripe_y || y + row >= stripe_y + ROW_HEIGHT) continue;
            for (int column = 0; column < glyph.width; ++column) {
                unsigned index = row * glyph.width + column;
                uint8_t packed = DAILY_BITMAP[glyph.offset + index / 2];
                uint8_t alpha = index % 2 ? packed & 15 : packed >> 4;
                if (alpha) pixel(x + glyph.left + column, y + row, shade(color, alpha));
            }
        }
        x += glyph.advance;
    }
}

static void centered(int x, int width, int baseline, const char *text, int size, uint16_t color)
{
    while (size > 10 && text_width(text, size) > width) --size;
    paint_text(x + (width - text_width(text, size)) / 2, baseline, text, size, color);
}

static int quantity_height(const char *value, const char *prefix, const char *unit, int width, int maximum)
{
    int fixed = text_width(prefix, 13) + text_width(unit, 13) + (prefix[0] ? 2 : 0) + (unit[0] ? 3 : 0);
    while (maximum > 10 && text_width(value, maximum, true) + fixed > width) --maximum;
    return maximum;
}

static void quantity(int x, int width, int baseline, const char *value, const char *prefix,
    const char *unit, int maximum, uint16_t color, bool center = true)
{
    int height = quantity_height(value, prefix, unit, width, maximum);
    int total = text_width(value, height, true) + text_width(prefix, 13) + text_width(unit, 13)
        + (prefix[0] ? 2 : 0) + (unit[0] ? 3 : 0);
    if (center) x += (width - total) / 2;
    if (prefix[0]) { paint_text(x, baseline, prefix, 13, GRAY); x += text_width(prefix, 13) + 2; }
    paint_text(x, baseline, value, height, color, true);
    x += text_width(value, height, true);
    if (unit[0]) paint_text(x + 3, baseline, unit, 13, GRAY);
}

static daily_view_t daily_view(const device_status_t &device, const network_status_t &network,
    const daily_summary_t &summary, unsigned pending, unsigned time_pending)
{
    daily_view_t view = {};
    bool synced = summary.valid && summary.synced && network.wifi_connected && network.server_connected
        && !pending && !time_pending && !device.unsaved_event;
    snprintf(view.connection, sizeof(view.connection), "%s", !network.wifi_connected ? "离线" : synced ? "已同步" : "同步中");
    view.connection_color = synced ? GREEN : AMBER;
    view.total_ready = summary.valid;
    if (summary.valid) snprintf(view.total, sizeof(view.total), "%.0f", round(summary.drink_ml));
    else strcpy(view.total, "--");
    if (summary.valid) snprintf(view.count, sizeof(view.count), "%lu", (unsigned long)summary.drink_count);
    else strcpy(view.count, "--");

    const char *problem = nullptr;
    uint16_t problem_color = AMBER;
    if (device.unsaved_event) { problem = "保存失败，请勿断电"; problem_color = RED; }
    else if (!device.sensor_ready) { problem = "传感器未就绪"; problem_color = RED; }
    else if (device.restart_required) problem = "请重启以生效";
    else if (!device.calibrated) { problem = "标定异常，请联系售后"; problem_color = RED; }
    else if (!isfinite(device.weight) || device.weight < -2 || device.weight > WEIGHING_MAX_GRAMS) {
        problem = "重量异常，请检查"; problem_color = RED;
    }
    if (problem) strcpy(view.water, "--");
    else if (device.empty_cup < 5) { strcpy(view.water, "未设置"); problem = "请在手机上设置空杯"; }
    else if (!device.cup_present) strcpy(view.water, "已取走");
    else if (!device.stable) strcpy(view.water, "待稳定");
    else {
        view.water_ready = true;
        snprintf(view.water, sizeof(view.water), "%.0f", round(fmax(0, device.weight - device.empty_cup)));
    }
    view.last_ready = summary.valid && summary.last_drink_at_ms > 0;
    if (view.last_ready) {
        snprintf(view.last, sizeof(view.last), "%.0f", round(summary.last_drink_ml));
        int64_t minutes = (summary.server_time_ms - summary.last_drink_at_ms) / 60000;
        if (summary.server_time_ms < summary.last_drink_at_ms) strcpy(view.age, "时间待确认");
        else if (minutes < 1) strcpy(view.age, "刚刚");
        else if (minutes < 60) snprintf(view.age, sizeof(view.age), "%ld分钟前", (long)minutes);
        else snprintf(view.age, sizeof(view.age), "%ld小时前", (long)(minutes / 60));
    } else strcpy(view.last, summary.valid ? "今日暂无记录" : "等待同步");

    view.notice_color = problem ? problem_color : synced ? GREEN : AMBER;
    if (problem) snprintf(view.notice, sizeof(view.notice), "%s", problem);
    else if (time_pending) snprintf(view.notice, sizeof(view.notice), "%u条记录待校时", time_pending);
    else if (pending) snprintf(view.notice, sizeof(view.notice), "%u条记录待同步", pending);
    else if (summary.received && !summary.valid) strcpy(view.notice, "统计暂不可用");
    else if (!network.wifi_connected) strcpy(view.notice, "网络断开，已保留记录");
    else if (!network.server_connected) strcpy(view.notice, "云端暂未连接");
    else if (!summary.valid || !summary.synced) strcpy(view.notice, "等待云端统计");
    else if (!device.cup_present) strcpy(view.notice, "杯子已取走");
    else if (!device.stable) strcpy(view.notice, "等待重量稳定");
    else strcpy(view.notice, "杯垫工作正常");
    return view;
}

static void paint_daily(const daily_view_t &view)
{
    paint_text(8, 21, "水伴", 13, WHITE);
    int status_x = LCD_WIDTH - 8 - text_width(view.connection, 12);
    paint_text(status_x, 21, view.connection, 12, view.connection_color);
    for (int y = 13; y < 19; ++y) for (int x = 0; x < 6; ++x) {
        float dx = x - 2.5f, dy = y - 15.5f;
        float coverage = fminf(1, fmaxf(0, 3.0f - sqrtf(dx * dx + dy * dy)));
        if (coverage > 0) pixel(status_x - 11 + x, y, shade(view.connection_color, uint8_t(coverage * 15 + 0.5f)));
    }
    centered(8, 156, 58, "今日饮水", 18, WHITE);
    quantity(8, 156, 133, view.total, "", "ml", 64, view.total_ready ? BLUE : GRAY);
    const int separators[] = {160, 234};
    for (int y : separators) for (int x = 8; x < LCD_WIDTH - 8; ++x) pixel(x, y, DIVIDER);
    for (int y = 176; y < 220; ++y) pixel(86, y, DIVIDER);
    centered(8, 74, 187, "杯中余水", 13, WHITE);
    centered(90, 74, 187, "饮水次数", 13, WHITE);
    if (view.water_ready) quantity(8, 74, 217, view.water, "约", "ml", 28, GREEN);
    else centered(8, 74, 214, view.water, 13, GRAY);
    quantity(90, 74, 217, view.count, "", view.total_ready ? "次" : "", 28, view.total_ready ? ORANGE : GRAY);
    paint_text(8, 254, "最近一次", 14, WHITE);
    if (view.last_ready) {
        int age_width = text_width(view.age, 12);
        quantity(8, 148 - age_width, 279, view.last, "", "ml", 24, WHITE, false);
        paint_text(164 - age_width, 279, view.age, 12, GRAY);
    } else paint_text(8, 279, view.last, 13, GRAY);
    centered(8, 156, 305, view.notice, 13, view.notice_color);
}

static void show_daily(const daily_view_t &view)
{
    bool changed_page = current_page != 1;
    select_page(1);
    if (daily_drawn && !changed_page && !memcmp(&previous_daily, &view, sizeof(view))) return;
    // 复用 20 行缓冲逐段绘制，避免为放大数字新增整屏帧缓冲。
    for (stripe_y = 0; stripe_y < LCD_HEIGHT; stripe_y += ROW_HEIGHT) {
        memset(pixels, 0, sizeof(pixels));
        paint_daily(view);
        draw_pixels(stripe_y, ROW_HEIGHT);
    }
    previous_daily = view;
    daily_drawn = true;
}

static void sleep_panel(void)
{
    digitalWrite(LCD_BL_PIN, LOW);
    write_command(0x28);
    write_command(0x10);
    // ST7789 进入休眠后至少等待 5 ms 才能接收下一条命令。
    delay(5);
    sleeping = true;
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
    sleep_panel();
    return true;
}

void display_wake(void)
{
    wake_until_ms = esp_timer_get_time() / 1000 + 15000;
}

bool display_awake(void)
{
    // 亮屏只由按键续时，称重、配网和故障状态均不能自动唤醒。
    return ready && esp_timer_get_time() / 1000 < wake_until_ms;
}

static void draw_status(esp_err_t startup_result)
{
    if (startup_result != ESP_OK) {
        select_page(2);
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
    binding_state_t binding;
    device_config_snapshot(nullptr, &binding);
    if (binding.binding_id[0] && !ble.pairing && !provisioning && !ble.window_open && !network.wifi_trial) {
        daily_summary_t summary;
        network_daily_summary(&summary, binding.binding_id);
        unsigned pending, time_pending;
        storage_counts(&pending, &time_pending);
        show_daily(daily_view(device, network, summary, pending, time_pending));
        return;
    }
    select_page(0);
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

void display_update(esp_err_t startup_result)
{
    if (!ready) return;
    if (!display_awake()) {
        if (!sleeping) sleep_panel();
        return;
    }
    bool waking = sleeping;
    if (waking) {
        write_command(0x11);
        // 只挂起显示所在任务；称重和联网任务继续运行。
        delay(120);
        current_page = -1;
        daily_drawn = false;
    }
    draw_status(startup_result);
    if (waking) {
        write_command(0x29);
        digitalWrite(LCD_BL_PIN, HIGH);
        sleeping = false;
    }
}
