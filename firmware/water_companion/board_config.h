#pragma once
#include "sdkconfig.h"

// 微雪 ESP32-S3-LCD-1.47B 排针；单 VCC 的 HX711 使用 3V3 供电。
// 官方 1.47B 原理图 BOOT 接 GPIO0；正常启动后作为输入读取。
#define PROVISION_BUTTON_PIN 0
#define RGB_LED_PIN 38
#define HX711_DOUT_PIN 2
#define HX711_SCK_PIN 4

#define LCD_MOSI_PIN 45
#define LCD_SCLK_PIN 40
#define LCD_CS_PIN 42
#define LCD_DC_PIN 41
#define LCD_RST_PIN 39
#define LCD_BL_PIN 46
#define LCD_WIDTH 172
#define LCD_HEIGHT 320
#define LCD_X_OFFSET 34

#if !CONFIG_IDF_TARGET_ESP32S3
#error "请在 Arduino IDE 中选择 ESP32S3 Dev Module"
#endif

#if HX711_DOUT_PIN == 1 || HX711_SCK_PIN == 1
#error "GPIO1 用于板载电池电压检测；HX711 请使用 DOUT=2、SCK=4"
#endif
