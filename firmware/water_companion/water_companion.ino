#include <Arduino.h>
#include <esp_arduino_version.h>
#include "board_config.h"
#include "console.h"
#include "device.h"
#include "display.h"
#include "network.h"
#include "ble_provision.h"

#if ESP_ARDUINO_VERSION_MAJOR != 3
#error "请在开发板管理器安装 esp32 by Espressif Systems 3.x；本工程按 3.3.11 适配"
#endif

#if !ARDUINO_USB_MODE || !ARDUINO_USB_CDC_ON_BOOT
#error "工具菜单：USB Mode 选择 Hardware CDC and JTAG，USB CDC On Boot 选择 Enabled"
#endif

#if !defined(BOARD_HAS_PSRAM) || !defined(CONFIG_SPIRAM_MODE_OCT)
#error "工具菜单：PSRAM 选择 OPI PSRAM；事件索引需要板载 8 MB PSRAM"
#endif

static SemaphoreHandle_t console_lock;
static esp_err_t startup_result = ESP_OK;

extern "C" int coaster_console_read(void)
{
    return Serial.read();
}

extern "C" void console_println(const char *text)
{
    xSemaphoreTake(console_lock, portMAX_DELAY);
    Serial.println(text);
    xSemaphoreGive(console_lock);
}

void setup()
{
    rgbLedWrite(RGB_LED_PIN, 0, 0, 0);
    console_lock = xSemaphoreCreateMutex();
    Serial.setRxBufferSize(2048);
    Serial.setTxBufferSize(2048);
    Serial.setTxTimeoutMs(5);
    Serial.begin(115200);
    if (!display_start()) Serial.println("屏幕 SPI 初始化失败；请检查开发板型号和引脚配置。");
    // 独立 USB 供电也要启动；不等待电脑打开串口监视器。
    startup_result = console_lock ? device_start() : ESP_ERR_NO_MEM;
    pinMode(PROVISION_BUTTON_PIN, INPUT_PULLUP);
    display_update(startup_result);
}

void loop()
{
    if (startup_result != ESP_OK) {
        static unsigned long last_error = 0;
        if (millis() - last_error >= 2000) {
            Serial.printf("固件初始化失败：%s。发送 {\"cmd\":\"diagnostics\"} 查看启动阶段和内存；检查 OPI PSRAM，保留 Flash 数据。\n",
                          esp_err_to_name(startup_result));
            last_error = millis();
        }
    }
    static unsigned long pressed_at = 0;
    static bool pressed = false, handled = false;
    if (digitalRead(PROVISION_BUTTON_PIN) == LOW) {
        if (!pressed) {
            pressed = true;
            pressed_at = millis();
            display_wake();
            if (startup_result == ESP_OK) device_wake();
        }
        if (startup_result == ESP_OK && !handled && millis() - pressed_at >= 3000) {
            network_provision();
            ble_provision_open();
            handled = true;
        }
    } else { pressed = false; handled = false; }
    if (startup_result == ESP_OK) ble_provision_poll();
    display_update(startup_result);
    delay(100);
}
