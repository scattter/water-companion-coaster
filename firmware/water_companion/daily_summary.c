#include "daily_summary.h"
#include <math.h>
#include <string.h>

static bool number(const cJSON *value, double minimum, double maximum)
{
    return cJSON_IsNumber(value) && isfinite(value->valuedouble)
        && value->valuedouble >= minimum && value->valuedouble <= maximum;
}

void daily_summary_parse(daily_summary_t *summary, const cJSON *json, const char *binding_id,
    int64_t server_time_ms, int64_t uptime_ms)
{
    *summary = (daily_summary_t){ .received = true };
    if (!binding_id || strlen(binding_id) != 36) return;
    strcpy(summary->binding_id, binding_id);
    if (!cJSON_IsObject(json) || server_time_ms < 1704067200000LL
        || server_time_ms >= 4102444800000LL || uptime_ms < 0) return;
    const cJSON *date = cJSON_GetObjectItemCaseSensitive(json, "date");
    const cJSON *expires = cJSON_GetObjectItemCaseSensitive(json, "expiresAtMs");
    const cJSON *total = cJSON_GetObjectItemCaseSensitive(json, "drinkMl");
    const cJSON *count = cJSON_GetObjectItemCaseSensitive(json, "drinkCount");
    const cJSON *last = cJSON_GetObjectItemCaseSensitive(json, "lastDrink");
    if (!cJSON_IsString(date) || strlen(date->valuestring) != 10) return;
    for (unsigned i = 0; i < 10; ++i) {
        char ch = date->valuestring[i];
        if (i == 4 || i == 7) { if (ch != '-') return; }
        else if (ch < '0' || ch > '9') return;
    }
    if (!number(expires, server_time_ms + 1, server_time_ms + 172800000LL)
        || floor(expires->valuedouble) != expires->valuedouble
        || !number(total, 0, 2000.0 * UINT32_MAX) || !number(count, 0, UINT32_MAX)
        || floor(count->valuedouble) != count->valuedouble) return;
    if (count->valuedouble == 0) {
        if (total->valuedouble != 0 || !cJSON_IsNull(last)) return;
    } else {
        if (!cJSON_IsObject(last)) return;
        const cJSON *amount = cJSON_GetObjectItemCaseSensitive(last, "amountMl");
        const cJSON *at = cJSON_GetObjectItemCaseSensitive(last, "occurredAtMs");
        if (!number(amount, 5, 2000) || total->valuedouble < amount->valuedouble
            || !number(at, expires->valuedouble - 172800000LL, expires->valuedouble - 1)
            || floor(at->valuedouble) != at->valuedouble) return;
        summary->last_drink_at_ms = (int64_t)at->valuedouble;
        summary->last_drink_ml = amount->valuedouble;
    }
    strcpy(summary->date, date->valuestring);
    summary->server_time_ms = server_time_ms;
    summary->received_ms = uptime_ms;
    summary->expires_at_ms = (int64_t)expires->valuedouble;
    summary->drink_ml = total->valuedouble;
    summary->drink_count = (uint32_t)count->valuedouble;
    summary->valid = summary->synced = true;
}

void daily_summary_read(const daily_summary_t *cached, daily_summary_t *output,
    const char *binding_id, int64_t uptime_ms)
{
    *output = *cached;
    if (!binding_id || !binding_id[0] || strcmp(cached->binding_id, binding_id)) {
        *output = (daily_summary_t){0};
        return;
    }
    if (!cached->valid) return;
    // 用心跳中的服务端时间加单调时钟，避免设备时钟误差让旧统计跨日继续显示。
    int64_t elapsed = uptime_ms - cached->received_ms;
    if (elapsed < 0 || elapsed >= cached->expires_at_ms - cached->server_time_ms) {
        *output = (daily_summary_t){0};
        return;
    }
    output->server_time_ms += elapsed;
}
