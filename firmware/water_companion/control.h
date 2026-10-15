#pragma once
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// Called serially by network startup, then network_task, without Wi-Fi/status locks.
esp_err_t control_start(void);
esp_err_t control_stop(void);

#ifdef __cplusplus
}
#endif
