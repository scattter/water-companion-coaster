#pragma once
#include <stdint.h>
#include "esp_err.h"

esp_err_t hx711_init(int dout, int sck);
esp_err_t hx711_read(int32_t *value, uint32_t timeout_ms);
