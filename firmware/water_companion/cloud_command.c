#include "cloud_command.h"
#include <string.h>

static bool receive(cloud_command_t *state, const char *binding, const char *id, const char *name,
    int64_t expires_at, int64_t now, command_save_fn save, command_execute_fn execute)
{
    if (!id || !*id || strlen(id) >= sizeof(state->id) || !name || strcmp(name, "cup")) return false;
    for (const char *p = id; *p; ++p)
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z')
            || (*p >= '0' && *p <= '9') || *p == '-' || *p == '_')) return false;
    if (!strcmp(state->id, id) && !strcmp(state->binding_id, binding)) return true;
    if (state->pending || now < 1704067200000LL || expires_at <= now) return false;
    cloud_command_t next = { .version = 2, .pending = true, .ok = false };
    strcpy(next.binding_id, binding);
    strcpy(next.id, id);
    strcpy(next.message, "操作中断，杯子设置可能已保存；请检查后重试");
    // 先持久记录命令身份，断电后不以新的杯子重量重复执行旧命令。
    if (save(&next) != 0) return false;
    *state = next;
    execute(&next.ok, next.message, sizeof(next.message));
    if (save(&next) == 0) *state = next;
    return true;
}

bool cloud_command_receive_bound(cloud_command_t *state, const char *binding, const char *current,
    const char *id, const char *name, int64_t expires_at, int64_t now, command_save_fn save, command_execute_fn execute)
{
    if (!binding || !current || strlen(binding) != 36 || strcmp(binding, current)) return false;
    return receive(state, binding, id, name, expires_at, now, save, execute);
}

bool cloud_command_receive(cloud_command_t *state, const char *id, const char *name,
    int64_t expires_at, int64_t now, command_save_fn save, command_execute_fn execute)
{
    return receive(state, "", id, name, expires_at, now, save, execute);
}

bool cloud_command_ack(cloud_command_t *state, command_save_fn save)
{
    if (!state->pending) return true;
    cloud_command_t next = *state;
    next.pending = false;
    if (save(&next) != 0) return false;
    *state = next;
    return true;
}
