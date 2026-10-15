#include "provision_protocol.h"
#include <string.h>
#include <stdio.h>

static int hex_digit(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

bool provision_hex(const char *value, size_t bytes, uint8_t *output)
{
    if (!value || strlen(value) != bytes * 2) return false;
    for (size_t i = 0; i < bytes; ++i) {
        int a = hex_digit(value[i * 2]), b = hex_digit(value[i * 2 + 1]);
        if (a < 0 || b < 0) return false;
        if (output) output[i] = (uint8_t)(a * 16 + b);
    }
    return true;
}

bool provision_uuid(const char *value)
{
    if (!value || strlen(value) != 36) return false;
    for (unsigned i = 0; i < 36; ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return false; }
        else if (hex_digit(value[i]) < 0) return false;
    }
    return true;
}

bool provision_origin(const char *value)
{
    if (!value || strncmp(value, "https://", 8) || strlen(value) > 191) return false;
    const char *p = value + 8;
    if (!*p || *p == '[') return false;
    {
        unsigned label = 0;
        char previous = 0;
        for (; *p && *p != ':'; previous = *p++) {
            char c = *p;
            if (c == '.') { if (!label || previous == '-') return false; label = 0; }
            else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                || (c == '-' && label)) { if (++label > 63) return false; }
            else return false;
        }
        if (!label || previous == '-') return false;
    }
    if (*p == ':') {
        ++p;
        unsigned port = 0, digits = 0;
        while (*p >= '0' && *p <= '9') {
            port = port * 10 + (unsigned)(*p++ - '0');
            if (++digits > 5 || port > 65535) return false;
        }
        if (!port) return false;
    }
    return !*p;
}

bool enrollment_origin(const char *value)
{
    if (provision_origin(value)) return true;
    if (!value || strncmp(value, "http://", 7) || strlen(value) > 191) return false;
    char secure[200];
    snprintf(secure, sizeof(secure), "https://%s", value + 7);
    if (!provision_origin(secure)) return false;
    const char *p = value + 7;
    unsigned ip[4];
    for (unsigned i = 0; i < 4; ++i) {
        if (*p < '0' || *p > '9' || (*p == '0' && p[1] >= '0' && p[1] <= '9')) return false;
        unsigned n = 0, digits = 0;
        while (*p >= '0' && *p <= '9') {
            n = n * 10 + (unsigned)(*p++ - '0');
            if (++digits > 3 || n > 255) return false;
        }
        ip[i] = n;
        if (i < 3 && *p++ != '.') return false;
    }
    if (*p && *p != ':') return false;
    return ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] == 192 && ip[1] == 168);
}

bool provision_fresh(int64_t now_ms, int64_t challenge_ms, int64_t window_until_ms)
{
    return now_ms >= challenge_ms && now_ms - challenge_ms < PROVISION_CHALLENGE_MS
        && now_ms < window_until_ms;
}

void provision_frames_reset(provision_frames_t *frames) { memset(frames, 0, sizeof(*frames)); }

provision_frame_result_t provision_frame(provision_frames_t *f, const uint8_t *data, size_t size, int64_t now)
{
    if (!data || size < 4 || (data[0] & ~3)) goto bad;
    unsigned sequence = data[1] | ((unsigned)data[2] << 8);
    if (data[0] & 1) {
        provision_frames_reset(f);
        if (sequence) goto bad;
        f->active = true;
        f->started_ms = now;
    }
    if (!f->active || sequence != f->next_sequence || now < f->started_ms
        || now - f->started_ms >= PROVISION_FRAME_MS || f->length + size - 3 > PROVISION_MESSAGE_MAX
        || memchr(data + 3, 0, size - 3)) goto bad;
    memcpy(f->data + f->length, data + 3, size - 3);
    f->length += size - 3;
    f->data[f->length] = 0;
    ++f->next_sequence;
    if (data[0] & 2) { f->active = false; return PROVISION_FRAME_DONE; }
    return PROVISION_FRAME_MORE;
bad:
    provision_frames_reset(f);
    return PROVISION_FRAME_ERROR;
}

static bool decimal(const char *text, uint64_t *number)
{
    if (!*text || (*text == '0' && text[1])) return false;
    uint64_t n = 0;
    for (; *text; ++text) {
        if (*text < '0' || *text > '9' || n > (9007199254740991ULL - (*text - '0')) / 10) return false;
        n = n * 10 + (unsigned)(*text - '0');
    }
    *number = n;
    return true;
}

bool provision_payload(const char *payload, const provision_trust_t *trust, const char *device_id,
    const char *challenge, const char *operation_id, int64_t epoch_ms, provision_candidate_t *candidate)
{
    char copy[768];
    if (!payload || strlen(payload) >= sizeof(copy) || !trust || trust->version != 1) return false;
    strcpy(copy, payload);
    char *fields[9] = {copy};
    for (unsigned i = 1; i < 9; ++i) {
        char *newline = strchr(fields[i - 1], '\n');
        if (!newline) return false;
        *newline = 0;
        fields[i] = newline + 1;
    }
    if (strchr(fields[8], '\n') || strcmp(fields[0], "coaster-provision-v1")
        || !provision_uuid(fields[1]) || strcmp(fields[1], trust->deployment_id)
        || strcmp(fields[2], device_id) || !provision_hex(fields[3], 32, NULL) || strcmp(fields[3], challenge)
        || !provision_uuid(fields[4]) || strcmp(fields[4], operation_id) || !provision_origin(fields[5])
        || !provision_hex(fields[8], 32, NULL)) return false;
    uint64_t version, expires;
    if (!decimal(fields[6], &version) || !version || !decimal(fields[7], &expires)
        || expires < 1704067500000ULL || expires >= 4102444800000ULL) return false;
    if (epoch_ms && ((uint64_t)epoch_ms >= expires || (uint64_t)epoch_ms + PROVISION_CHALLENGE_MS < expires)) return false;
    strcpy(candidate->operation_id, operation_id);
    strcpy(candidate->server_url, fields[5]);
    strcpy(candidate->ticket, fields[8]);
    candidate->config_version = version;
    candidate->expires_at_ms = (int64_t)expires;
    return true;
}
