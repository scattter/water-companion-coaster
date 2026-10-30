#pragma once
#include <stdbool.h>
#include <stdint.h>

#define CUP_CAPACITY 3
#define CUP_NAME_BYTES 16
#define CUP_SETUP_MS 300000

typedef struct {
    char name[CUP_NAME_BYTES];
    float empty_cup;
} cup_t;

typedef struct {
    uint32_t version;
    char binding_id[37];
    uint8_t active_id;
    cup_t items[CUP_CAPACITY];
} cup_config_t;

typedef struct {
    char id[37];
    uint8_t cup_id;
    char name[CUP_NAME_BYTES];
    int64_t expires_ms;
    int64_t expires_at;
    int64_t stable_since_ms;
    float minimum, maximum;
} cup_setup_t;

#ifdef __cplusplus
extern "C" {
#endif
bool cup_name_valid(const char *name);
bool cups_valid(const cup_config_t *cups);
void cups_init(cup_config_t *cups, const char *binding_id, float legacy_weight);
const cup_t *cups_get(const cup_config_t *cups, unsigned id);
unsigned cups_next(const cup_config_t *cups, unsigned after);
float cups_weight(const cup_config_t *cups);
#ifdef __cplusplus
}
#endif
