#include "cups.h"
#include <math.h>
#include <string.h>

bool cup_name_valid(const char *name)
{
    if (!name) return false;
    unsigned count = 0;
    const unsigned char *p = (const unsigned char *)name;
    while (*p) {
        if (++count > 5) return false;
        if ((*p >= 'A' && *p <= 'Z') || (*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9')) ++p;
        else if ((p[0] & 0xf0) == 0xe0 && p[1] && (p[1] & 0xc0) == 0x80
            && p[2] && (p[2] & 0xc0) == 0x80) {
            unsigned code = ((p[0] & 15) << 12) | ((p[1] & 63) << 6) | (p[2] & 63);
            if (code < 0x4e00 || code > 0x9fff) return false;
            p += 3;
        } else return false;
    }
    return count > 0;
}

const cup_t *cups_get(const cup_config_t *cups, unsigned id)
{
    return id >= 1 && id <= CUP_CAPACITY && cups->items[id - 1].empty_cup >= 5 ? &cups->items[id - 1] : NULL;
}

unsigned cups_next(const cup_config_t *cups, unsigned after)
{
    for (unsigned offset = 1; offset <= CUP_CAPACITY; ++offset) {
        unsigned id = (after + offset - 1) % CUP_CAPACITY + 1;
        if (cups_get(cups, id)) return id;
    }
    return 0;
}

float cups_weight(const cup_config_t *cups)
{
    const cup_t *cup = cups_get(cups, cups->active_id);
    return cup ? cup->empty_cup : 0;
}

bool cups_valid(const cup_config_t *cups)
{
    if (cups->version != 1 || cups->binding_id[36] || cups->active_id > CUP_CAPACITY) return false;
    unsigned count = 0;
    for (unsigned i = 0; i < CUP_CAPACITY; ++i) {
        const cup_t *cup = &cups->items[i];
        if (!isfinite(cup->empty_cup) || !memchr(cup->name, 0, sizeof(cup->name))) return false;
        if (cup->empty_cup == 0) { if (cup->name[0]) return false; }
        else {
            if (cup->empty_cup < 5 || cup->empty_cup > 1995 || !cup_name_valid(cup->name)) return false;
            ++count;
        }
    }
    return count ? cups_get(cups, cups->active_id) != NULL : cups->active_id == 0;
}

void cups_init(cup_config_t *cups, const char *binding_id, float legacy_weight)
{
    memset(cups, 0, sizeof(*cups));
    cups->version = 1;
    if (binding_id) strncpy(cups->binding_id, binding_id, sizeof(cups->binding_id) - 1);
    if (isfinite(legacy_weight) && legacy_weight >= 5 && legacy_weight <= 1995) {
        cups->active_id = 1;
        strcpy(cups->items[0].name, "默认杯");
        cups->items[0].empty_cup = legacy_weight;
    }
}
