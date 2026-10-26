#pragma once
#include "esp_err.h"

bool display_start(void);
void display_wake(void);
bool display_awake(void);
void display_update(esp_err_t startup_result);
