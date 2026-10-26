#include "hx711.h"
#include "driver/gpio.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static gpio_num_t data_pin, clock_pin;
static portMUX_TYPE clock_lock = portMUX_INITIALIZER_UNLOCKED;

esp_err_t hx711_init(int dout, int sck)
{
    if (!GPIO_IS_VALID_GPIO(dout) || !GPIO_IS_VALID_OUTPUT_GPIO(sck) || dout == sck)
        return ESP_ERR_INVALID_ARG;
    data_pin = dout;
    clock_pin = sck;
    gpio_config_t input = {
        .pin_bit_mask = 1ULL << dout, .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config_t output = {
        .pin_bit_mask = 1ULL << sck, .mode = GPIO_MODE_OUTPUT,
    };
    esp_err_t result = gpio_config(&output);
    if (result != ESP_OK) return result;
    gpio_set_level(clock_pin, 0);
    return gpio_config(&input);
}

esp_err_t hx711_read(int32_t *value, uint32_t timeout_ms)
{
    if (!value) return ESP_ERR_INVALID_ARG;
    int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
    while (gpio_get_level(data_pin)) {
        if (esp_timer_get_time() >= deadline) return ESP_ERR_TIMEOUT;
        // DOUT 就绪后保持低电平，10 ms 检查不遗漏就绪信号，采样任务仍按 10 SPS 运行。
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    uint32_t raw = 0;
    // SCK 高电平不能被调度打断超过 60 us，否则 HX711 会进入掉电状态。
    portENTER_CRITICAL(&clock_lock);
    for (int bit = 0; bit < 24; ++bit) {
        gpio_set_level(clock_pin, 1);
        esp_rom_delay_us(1);
        raw = (raw << 1) | gpio_get_level(data_pin);
        gpio_set_level(clock_pin, 0);
        esp_rom_delay_us(1);
    }
    gpio_set_level(clock_pin, 1); // 第 25 个脉冲选择下一次 A 通道、128 倍增益。
    esp_rom_delay_us(1);
    gpio_set_level(clock_pin, 0);
    portEXIT_CRITICAL(&clock_lock);
    if (raw == 0x7fffff || raw == 0x800000) return ESP_ERR_INVALID_RESPONSE;
    *value = (raw & 0x800000) ? (int32_t)(raw | 0xff000000U) : (int32_t)raw;
    return ESP_OK;
}
