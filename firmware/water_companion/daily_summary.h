#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "cJSON.h"

typedef struct {
    bool received;
    bool valid;
    bool synced;
    char binding_id[37];
    char date[11];
    int64_t server_time_ms;
    int64_t received_ms;
    int64_t expires_at_ms;
    double drink_ml;
    uint32_t drink_count;
    int64_t last_drink_at_ms;
    double last_drink_ml;
} daily_summary_t;

#ifdef __cplusplus
extern "C" {
#endif

void daily_summary_parse(daily_summary_t *summary, const cJSON *json, const char *binding_id,
    int64_t server_time_ms, int64_t uptime_ms);
void daily_summary_read(const daily_summary_t *cached, daily_summary_t *output,
    const char *binding_id, int64_t uptime_ms);

#ifdef __cplusplus
}
#endif
