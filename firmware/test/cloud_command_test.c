#include <assert.h>
#include <string.h>
#include "cloud_command.h"

static cloud_command_t disk;
static int executions, saves, fail_save;
static int save(const cloud_command_t *state)
{
    ++saves;
    if (saves == fail_save) return -1;
    disk = *state;
    return 0;
}
static void execute(bool *ok, char *message, unsigned capacity)
{
    assert(capacity >= 16);
    ++executions;
    *ok = true;
    strcpy(message, "saved");
}
int main(void)
{
    const int64_t now = 1800000000000LL;
    cloud_command_t state = {0};
    assert(!cloud_command_receive(&state, "cmd-1", "tare", now + 1000, now, save, execute));
    assert(!cloud_command_receive(&state, "cmd-1", "calibrate", now + 1000, now, save, execute));
    assert(!cloud_command_receive(&state, "cmd-1", "server", now + 1000, now, save, execute));
    assert(!cloud_command_receive(&state, "cmd-1", "cup", now, now, save, execute));
    assert(!cloud_command_receive(&state, "cmd-1", "cup", now + 1000, 0, save, execute));
    assert(!cloud_command_receive(&state, "../bad", "cup", now + 1000, now, save, execute));
    assert(executions == 0 && saves == 0);
    fail_save = 1;
    assert(!cloud_command_receive(&state, "cmd-1", "cup", now + 1000, now, save, execute));
    assert(executions == 0 && !state.id[0]);
    fail_save = 0;
    assert(cloud_command_receive(&state, "cmd-1", "cup", now + 1000, now, save, execute));
    assert(executions == 1 && state.ok && state.pending && !strcmp(state.message, "saved"));
    state = disk;
    assert(cloud_command_receive(&state, "cmd-1", "cup", now + 1000, now, save, execute));
    assert(executions == 1 && state.pending);
    assert(!cloud_command_receive(&state, "cmd-2", "cup", now + 1000, now, save, execute));
    fail_save = saves + 1;
    assert(!cloud_command_ack(&state, save) && state.pending);
    fail_save = 0;
    assert(cloud_command_ack(&state, save) && !state.pending);
    state = disk;
    assert(cloud_command_receive(&state, "cmd-1", "cup", now + 1000, now, save, execute));
    assert(executions == 1 && !state.pending);
    fail_save = saves + 2;
    assert(cloud_command_receive(&state, "cmd-2", "cup", now + 1000, now, save, execute));
    assert(executions == 2 && !state.ok && state.pending);
    state = disk;
    assert(!strcmp(state.id, "cmd-2") && !state.ok && state.pending);
    assert(cloud_command_receive(&state, "cmd-2", "cup", now + 1000, now, save, execute));
    assert(executions == 2);
    fail_save = 0;
    assert(cloud_command_ack(&state, save));
    assert(cloud_command_receive(&state, "cmd-3", "cup", now + 1000, now, save, execute));
    assert(executions == 3 && state.ok);
    assert(cloud_command_ack(&state, save));
    const char *old_owner = "11111111-1111-4111-8111-111111111111";
    const char *new_owner = "22222222-2222-4222-8222-222222222222";
    assert(!cloud_command_receive_bound(&state, old_owner, new_owner, "cmd-old", "cup", now + 1000, now, save, execute));
    assert(!cloud_command_receive_bound(&state, NULL, new_owner, "cmd-null", "cup", now + 1000, now, save, execute));
    assert(!cloud_command_receive_bound(&state, "", new_owner, "cmd-empty", "cup", now + 1000, now, save, execute));
    assert(executions == 3);
    assert(cloud_command_receive_bound(&state, new_owner, new_owner, "cmd-new", "cup", now + 1000, now, save, execute));
    assert(executions == 4 && !strcmp(state.binding_id, new_owner));
    state = disk;
    assert(cloud_command_receive_bound(&state, new_owner, new_owner, "cmd-new", "cup", now + 1000, now, save, execute));
    assert(executions == 4);
    assert(!cloud_command_receive_bound(&state, new_owner, old_owner, "cmd-new", "cup", now + 1000, now, save, execute));
    assert(executions == 4);
    return 0;
}
