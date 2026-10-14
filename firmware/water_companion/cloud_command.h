#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint32_t version;
    char id[65];
    bool pending;
    bool ok;
    char message[160];
    char binding_id[37];
} cloud_command_t;

typedef int (*command_save_fn)(const cloud_command_t *state);
typedef void (*command_execute_fn)(bool *ok, char *message, unsigned capacity);

bool cloud_command_receive_bound(cloud_command_t *state, const char *binding_id, const char *current_binding,
    const char *id, const char *name, int64_t expires_at, int64_t now, command_save_fn save, command_execute_fn execute);
bool cloud_command_receive(cloud_command_t *state, const char *id, const char *name,
    int64_t expires_at, int64_t now, command_save_fn save, command_execute_fn execute);
bool cloud_command_ack(cloud_command_t *state, command_save_fn save);
