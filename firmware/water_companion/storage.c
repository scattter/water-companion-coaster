#include "storage.h"
#include "console.h"
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_heap_caps.h"
#include "nvs_flash.h"

typedef struct {
    uint32_t sequence;
    bool ready;
    bool can_resolve;
} queue_entry_t;

static nvs_handle_t settings, events;
static SemaphoreHandle_t lock;
static queue_entry_t *queue;
static unsigned count;
static uint32_t next_sequence = 1;
static uint64_t current_boot;

static void key_for(uint32_t sequence, char key[16])
{
    snprintf(key, 16, "e%08" PRIx32, sequence);
}

static bool valid_event(const saved_event_t *event)
{
    if ((event->version != EVENT_VERSION && event->version != 1)
        || !memchr(event->binding_id, 0, sizeof(event->binding_id))
        || (event->binding_id[0] && !provision_uuid(event->binding_id))
        || (event->version == 1 && event->binding_id[0])
        || event->id[36] != '\0' || strlen(event->id) != 36
        || !event->boot_id || event->uptime_ms < 0 || event->epoch_ms < 0)
        return false;
    for (unsigned i = 0; i < 36; ++i) {
        char c = event->id[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return false;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    const weight_change_t *change = &event->change;
    float delta = change->drink ? change->before - change->after : change->after - change->before;
    return isfinite(change->before) && isfinite(change->after) && isfinite(change->amount)
        && change->before >= 0 && change->before <= WEIGHING_MAX_GRAMS
        && change->after >= 0 && change->after <= WEIGHING_MAX_GRAMS
        && change->amount >= 5 && fabsf(delta - change->amount) < 0.11f;
}

static esp_err_t read_event(uint32_t sequence, saved_event_t *event)
{
    char key[16];
    key_for(sequence, key);
    size_t size = 0;
    esp_err_t result = nvs_get_blob(events, key, NULL, &size);
    if (result != ESP_OK) return result;
    memset(event, 0, sizeof(*event));
    if (size == sizeof(legacy_event_t)) {
        legacy_event_t old;
        result = nvs_get_blob(events, key, &old, &size);
        if (result != ESP_OK) return result;
        if (old.version != 1) return ESP_ERR_INVALID_RESPONSE;
        event->version = old.version;
        memcpy(event->id, old.id, sizeof(event->id));
        event->boot_id = old.boot_id;
        event->uptime_ms = old.uptime_ms;
        event->epoch_ms = old.epoch_ms;
        event->change = old.change;
        // Never infer an owner for an old event from today's binding.
    } else if (size == sizeof(*event)) {
        result = nvs_get_blob(events, key, event, &size);
        if (result != ESP_OK) return result;
        if (event->version != EVENT_VERSION) return ESP_ERR_INVALID_RESPONSE;
    } else return ESP_ERR_INVALID_RESPONSE;
    return valid_event(event) ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

static esp_err_t write_event(uint32_t sequence, const saved_event_t *event)
{
    char key[16];
    key_for(sequence, key);
    esp_err_t result;
    if (event->version == 1) {
        legacy_event_t old = { .version = 1, .boot_id = event->boot_id,
            .uptime_ms = event->uptime_ms, .epoch_ms = event->epoch_ms, .change = event->change };
        memcpy(old.id, event->id, sizeof(old.id));
        result = nvs_set_blob(events, key, &old, sizeof(old));
    } else result = nvs_set_blob(events, key, event, sizeof(*event));
    return result == ESP_OK ? nvs_commit(events) : result;
}

static int compare_entries(const void *left, const void *right)
{
    uint32_t a = ((const queue_entry_t *)left)->sequence;
    uint32_t b = ((const queue_entry_t *)right)->sequence;
    return (a > b) - (a < b);
}

static esp_err_t allocate_queue(void)
{
    // This is a rebuildable index, not the NVS event data. Keep radio/task RAM available.
    if (!queue) queue = heap_caps_calloc(EVENT_CAPACITY, sizeof(*queue), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!queue) {
        console_println("事件索引内存不足：请在 Arduino 工具中启用 OPI PSRAM，保留 Flash 数据。");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t storage_init(device_config_t *config, uint64_t *boot_id)
{
    esp_err_t result = allocate_queue();
    if (result != ESP_OK) return result;
    lock = xSemaphoreCreateMutex();
    if (!lock) return ESP_ERR_NO_MEM;
    // Arduino 启动时可能格式化默认 nvs；业务数据使用独立分区，失败时不擦除。
    result = nvs_flash_init_partition("settings");
    if (result != ESP_OK) return result;
    result = nvs_open_from_partition("settings", "coaster", NVS_READWRITE, &settings);
    if (result != ESP_OK) return result;
    memset(config, 0, sizeof(*config));
    size_t size = sizeof(*config);
    result = nvs_get_blob(settings, "config", config, &size);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        config->version = CONFIG_VERSION;
        uint8_t mac[6];
        result = esp_read_mac(mac, ESP_MAC_WIFI_STA);
        if (result != ESP_OK) return result;
        snprintf(config->device_id, sizeof(config->device_id), "coaster-%02x%02x%02x%02x%02x%02x",
            mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    } else if (result != ESP_OK) return result;
    else if (size != sizeof(*config) || config->version != CONFIG_VERSION
        || !memchr(config->ssid, 0, sizeof(config->ssid))
        || !memchr(config->password, 0, sizeof(config->password))
        || !memchr(config->server_url, 0, sizeof(config->server_url))
        || !memchr(config->device_id, 0, sizeof(config->device_id))
        || !memchr(config->token, 0, sizeof(config->token))
        || !isfinite(config->empty_cup) || config->empty_cup < 0 || config->empty_cup > 1995
        || (config->calibrated && (!config->zero_set || !isfinite(config->counts_per_gram)
            || fabs(config->counts_per_gram) < 1)))
        return ESP_ERR_INVALID_RESPONSE;

    result = nvs_get_u64(settings, "boot", &current_boot);
    if (result != ESP_OK && result != ESP_ERR_NVS_NOT_FOUND) return result;
    bool new_storage = result == ESP_ERR_NVS_NOT_FOUND;
    if (current_boot == UINT64_MAX) return ESP_ERR_INVALID_STATE;
    ++current_boot;

    result = nvs_flash_init_partition("events");
    if (result != ESP_OK) return result;
    result = nvs_open_from_partition("events", "queue", NVS_READWRITE, &events);
    if (result != ESP_OK) return result;
    nvs_iterator_t iterator = NULL;
    result = nvs_entry_find("events", "queue", NVS_TYPE_BLOB, &iterator);
    while (result == ESP_OK) {
        nvs_entry_info_t info;
        nvs_entry_info(iterator, &info);
        char *end;
        unsigned long sequence = strtoul(info.key + 1, &end, 16);
        if (info.key[0] != 'e' || strlen(info.key) != 9 || *end || !sequence
            || sequence >= UINT32_MAX || count >= EVENT_CAPACITY) {
            nvs_release_iterator(iterator);
            return ESP_ERR_INVALID_RESPONSE;
        }
        saved_event_t event;
        result = read_event((uint32_t)sequence, &event);
        if (result != ESP_OK) {
            nvs_release_iterator(iterator);
            return result;
        }
        queue[count++] = (queue_entry_t){
            .sequence = (uint32_t)sequence, .ready = event.epoch_ms != 0,
            .can_resolve = event.boot_id == current_boot,
        };
        if (sequence >= next_sequence) next_sequence = (uint32_t)sequence + 1;
        result = nvs_entry_next(&iterator);
    }
    nvs_release_iterator(iterator);
    if (result != ESP_ERR_NVS_NOT_FOUND) return result;
    // 旧固件或配置丢失时，不能将已有队列误认作本次启动、回填错误时间或设备身份。
    if (new_storage && count) return ESP_ERR_INVALID_STATE;
    result = nvs_set_u64(settings, "boot", current_boot);
    if (result != ESP_OK) return result;
    result = nvs_commit(settings);
    if (result != ESP_OK) return result;
    *boot_id = current_boot;
    qsort(queue, count, sizeof(queue[0]), compare_entries);
    return ESP_OK;
}

esp_err_t storage_save_config(const device_config_t *config)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = nvs_set_blob(settings, "config", config, sizeof(*config));
    if (result == ESP_OK) result = nvs_commit(settings);
    xSemaphoreGive(lock);
    return result;
}

esp_err_t storage_append(const saved_event_t *event)
{
    if (!valid_event(event)) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(lock, portMAX_DELAY);
    if (count >= EVENT_CAPACITY || next_sequence == UINT32_MAX) {
        xSemaphoreGive(lock);
        return ESP_ERR_NVS_NOT_ENOUGH_SPACE;
    }
    esp_err_t result = write_event(next_sequence, event);
    if (result == ESP_OK) {
        queue[count++] = (queue_entry_t){ .sequence = next_sequence++,
            .ready = event->epoch_ms != 0, .can_resolve = event->boot_id == current_boot };
    }
    xSemaphoreGive(lock);
    return result;
}

esp_err_t storage_next(saved_event_t *event, uint32_t *sequence, int64_t epoch_offset_ms)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = ESP_ERR_NOT_FOUND;
    for (unsigned i = 0; i < count; ++i) {
        queue_entry_t *entry = &queue[i];
        if (!entry->ready && !(entry->can_resolve && epoch_offset_ms > 0)) continue;
        result = read_event(entry->sequence, event);
        if (result != ESP_OK) break;
        if (!entry->ready) {
            // 只回填同一次启动的单调时钟；断电前未校时的记录无法推算绝对时间。
            event->epoch_ms = epoch_offset_ms + event->uptime_ms;
            result = write_event(entry->sequence, event);
            if (result != ESP_OK) break;
            entry->ready = true;
        }
        *sequence = entry->sequence;
        result = ESP_OK;
        break;
    }
    xSemaphoreGive(lock);
    return result;
}

esp_err_t storage_resolve_time(int64_t epoch_offset_ms)
{
    if (epoch_offset_ms <= 0) return ESP_ERR_INVALID_ARG;
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = ESP_OK;
    for (unsigned i = 0; i < count; ++i) {
        queue_entry_t *entry = &queue[i];
        if (entry->ready || !entry->can_resolve) continue;
        saved_event_t event;
        result = read_event(entry->sequence, &event);
        if (result != ESP_OK) break;
        event.epoch_ms = epoch_offset_ms + event.uptime_ms;
        result = write_event(entry->sequence, &event);
        if (result != ESP_OK) break;
        entry->ready = true;
        // 每轮只回填一条，避免大队列持续占用 Flash 锁、阻塞称重采样。
        break;
    }
    xSemaphoreGive(lock);
    return result;
}

esp_err_t storage_ack(uint32_t sequence)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = ESP_ERR_NOT_FOUND;
    for (unsigned i = 0; i < count; ++i) {
        if (queue[i].sequence != sequence) continue;
        char key[16];
        key_for(sequence, key);
        result = nvs_erase_key(events, key);
        if (result == ESP_OK) result = nvs_commit(events);
        if (result == ESP_OK) {
            memmove(&queue[i], &queue[i + 1], (count - i - 1) * sizeof(queue[0]));
            --count;
        }
        break;
    }
    xSemaphoreGive(lock);
    return result;
}

void storage_counts(unsigned *pending, unsigned *time_pending)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    *pending = count;
    *time_pending = 0;
    for (unsigned i = 0; i < count; ++i) if (!queue[i].ready) ++*time_pending;
    xSemaphoreGive(lock);
}

void storage_dump_pending_time(void)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    for (unsigned i = 0; i < count; ++i) {
        if (queue[i].ready) continue;
        saved_event_t event;
        if (read_event(queue[i].sequence, &event) != ESP_OK) {
            console_println("{\"error\":\"读取待校时记录失败，未删除数据\"}");
            break;
        }
        char message[320];
        snprintf(message, sizeof(message), "{\"id\":\"%s\",\"bootId\":\"%" PRIu64 "\",\"uptimeMs\":%" PRId64
                 ",\"kind\":\"%s\",\"beforeGrams\":%.1f,\"afterGrams\":%.1f,\"amountMl\":%.1f}",
                 event.id, event.boot_id, event.uptime_ms, event.change.drink ? "drink" : "refill",
                 event.change.before, event.change.after, event.change.amount);
        console_println(message);
    }
    xSemaphoreGive(lock);
}

static esp_err_t save_setting(const char *key, const void *data, size_t size)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = nvs_set_blob(settings, key, data, size);
    if (result == ESP_OK) result = nvs_commit(settings);
    xSemaphoreGive(lock);
    return result;
}

esp_err_t storage_load_trust(provision_trust_t *trust)
{
    memset(trust, 0, sizeof(*trust));
    size_t size = sizeof(*trust);
    esp_err_t result = nvs_get_blob(settings, "trust_v1", trust, &size);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    return size == sizeof(*trust) && trust->version == 1 && trust->deployment_id[36] == 0
        && trust->public_key[130] == 0 && provision_uuid(trust->deployment_id)
        && provision_public_key(trust->public_key) ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

esp_err_t storage_save_trust(const provision_trust_t *trust)
{
    return save_setting("trust_v1", trust, sizeof(*trust));
}

esp_err_t storage_load_binding(binding_state_t *binding)
{
    memset(binding, 0, sizeof(*binding));
    binding->version = 1;
    size_t size = sizeof(*binding);
    esp_err_t result = nvs_get_blob(settings, "binding_v1", binding, &size);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    return size == sizeof(*binding) && binding->version == 1 && binding->binding_id[36] == 0
        && (!binding->binding_id[0] || provision_uuid(binding->binding_id)) ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

esp_err_t storage_save_binding(const binding_state_t *binding)
{
    return save_setting("binding_v1", binding, sizeof(*binding));
}

esp_err_t storage_load_provision(provision_record_t *record)
{
    memset(record, 0, sizeof(*record));
    size_t size = 0;
    esp_err_t result = nvs_get_blob(settings, "provision_v1", NULL, &size);
    if (result != ESP_OK) return result;
    if (size == sizeof(legacy_provision_record_t)) {
        legacy_provision_record_t old;
        result = nvs_get_blob(settings, "provision_v1", &old, &size);
        if (result != ESP_OK) return result;
        record->version = old.version; record->phase = old.phase; record->candidate = old.candidate;
        memcpy(record->binding_id, old.binding_id, sizeof(record->binding_id));
        record->previous = old.previous; record->previous_binding = old.previous_binding;
    } else if (size == sizeof(*record)) {
        result = nvs_get_blob(settings, "provision_v1", record, &size);
        if (result != ESP_OK) return result;
    } else return ESP_ERR_INVALID_RESPONSE;
    if ((record->version != 1 && record->version != 2) || record->phase < 1 || record->phase > 4
        || record->candidate.operation_id[36] || !provision_uuid(record->candidate.operation_id)
        || !memchr(record->candidate.ssid, 0, sizeof(record->candidate.ssid))
        || !record->candidate.ssid[0] || !memchr(record->candidate.password, 0, sizeof(record->candidate.password))
        || !memchr(record->candidate.server_url, 0, sizeof(record->candidate.server_url))
        || !(record->version == 2 ? enrollment_origin(record->candidate.server_url) : provision_origin(record->candidate.server_url)) || record->candidate.ticket[64]
        || !provision_hex(record->candidate.ticket, 32, NULL) || record->binding_id[36]
        || (record->phase >= 2 && record->phase <= 3 && !provision_uuid(record->binding_id))
        || record->previous.version != CONFIG_VERSION || record->previous_binding.version != 1
        || record->previous_binding.binding_id[36]
        || (record->previous_binding.binding_id[0] && !provision_uuid(record->previous_binding.binding_id))
        || !memchr(record->previous.ssid, 0, sizeof(record->previous.ssid))
        || !memchr(record->previous.password, 0, sizeof(record->previous.password))
        || !memchr(record->previous.server_url, 0, sizeof(record->previous.server_url))
        || !memchr(record->previous.device_id, 0, sizeof(record->previous.device_id))
        || !memchr(record->previous.token, 0, sizeof(record->previous.token))
        || !isfinite(record->previous.empty_cup)) return ESP_ERR_INVALID_RESPONSE;
    if (record->version == 2 && (record->hardware_id[12] || !provision_hex(record->hardware_id, 6, NULL)
        || !memchr(record->device_id, 0, sizeof(record->device_id)) || !memchr(record->token, 0, sizeof(record->token))
        || ((record->phase == 2 || record->phase == 3) && (!record->device_id[0] || strlen(record->token) < 16)))) return ESP_ERR_INVALID_RESPONSE;
    return ESP_OK;
}

esp_err_t storage_save_provision(const provision_record_t *record)
{
    return save_setting("provision_v1", record, sizeof(*record));
}

esp_err_t storage_clear_provision(void)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = nvs_erase_key(settings, "provision_v1");
    if (result == ESP_ERR_NVS_NOT_FOUND) result = ESP_OK;
    if (result == ESP_OK) result = nvs_commit(settings);
    xSemaphoreGive(lock);
    return result;
}

esp_err_t storage_load_command(cloud_command_t *state)
{
    memset(state, 0, sizeof(*state));
    size_t size = 0;
    esp_err_t result = nvs_get_blob(settings, "command", NULL, &size);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    typedef struct { uint32_t version; char id[65]; bool pending, ok; char message[160]; } legacy_command_t;
    if (size == sizeof(legacy_command_t)) {
        legacy_command_t old;
        result = nvs_get_blob(settings, "command", &old, &size);
        if (result != ESP_OK) return result;
        if (old.version != 1) return ESP_ERR_INVALID_RESPONSE;
        state->version = 2;
        memcpy(state->id, old.id, sizeof(old.id));
        memcpy(state->message, old.message, sizeof(old.message));
        state->pending = old.pending;
        state->ok = old.ok;
    } else if (size == sizeof(*state)) {
        result = nvs_get_blob(settings, "command", state, &size);
        if (result != ESP_OK) return result;
        if (state->version != 2) return ESP_ERR_INVALID_RESPONSE;
    } else return ESP_ERR_INVALID_RESPONSE;
    return memchr(state->id, 0, sizeof(state->id)) && memchr(state->message, 0, sizeof(state->message))
        && memchr(state->binding_id, 0, sizeof(state->binding_id))
        && (!state->binding_id[0] || provision_uuid(state->binding_id)) ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
}

esp_err_t storage_save_command(const cloud_command_t *state)
{
    return save_setting("command", state, sizeof(*state));
}

esp_err_t storage_stage_wifi(const char *ssid, const char *password)
{
    char candidate[98] = {0};
    snprintf(candidate, 33, "%s", ssid);
    snprintf(candidate + 33, 65, "%s", password);
    return save_setting("wifi_candidate", candidate, sizeof(candidate));
}

esp_err_t storage_load_wifi(char ssid[33], char password[65])
{
    char candidate[98];
    size_t size = sizeof(candidate);
    esp_err_t result = nvs_get_blob(settings, "wifi_candidate", candidate, &size);
    if (result != ESP_OK) return result;
    if (size != sizeof(candidate) || !candidate[0] || !memchr(candidate, 0, 33)
        || !memchr(candidate + 33, 0, 65)) return ESP_ERR_INVALID_RESPONSE;
    memcpy(ssid, candidate, 33);
    memcpy(password, candidate + 33, 65);
    return ESP_OK;
}

esp_err_t storage_clear_wifi(void)
{
    xSemaphoreTake(lock, portMAX_DELAY);
    esp_err_t result = nvs_erase_key(settings, "wifi_candidate");
    if (result == ESP_ERR_NVS_NOT_FOUND) result = ESP_OK;
    if (result == ESP_OK) result = nvs_commit(settings);
    xSemaphoreGive(lock);
    return result;
}

esp_err_t storage_ap_password(char password[13])
{
    size_t size = 13;
    esp_err_t result = nvs_get_blob(settings, "ap_password", password, &size);
    if (result == ESP_OK) return size == 13 && password[12] == 0 ? ESP_OK : ESP_ERR_INVALID_RESPONSE;
    if (result != ESP_ERR_NVS_NOT_FOUND) return result;
    uint8_t random[12];
    esp_fill_random(random, sizeof(random));
    const char alphabet[] = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    for (unsigned i = 0; i < 12; ++i) password[i] = alphabet[random[i] % (sizeof(alphabet) - 1)];
    password[12] = 0;
    return save_setting("ap_password", password, 13);
}
