# 云端设备与用户协议

版本：2026-10-14。当前产品链路为 BLE 自动下发 Wi-Fi 与短期票据、ESP32-S3 联网注册并绑定。首次正式编号和凭证由服务端生成，用户不填写编号。默认协议见 [BLE 自动注册 v2](ble-provisioning-v2.md)；旧 [BLE v1](ble-provisioning-v1.md) 保留兼容。生产使用 HTTPS，开发环境支持私网 IPv4 HTTP 设备 API；浏览器蓝牙仍要求 HTTPS 或本机 localhost。

## 账号与归属

| 接口 | 请求 | 响应 |
|---|---|---|
| `GET /api/auth/session` | 无 | `{user:null或{id,username,role},deviceId:null或string,bindingId:null或string}` |
| `POST /api/auth/register` | `{username,password}` | 会话及设备归属，并设置 Cookie |
| `POST /api/auth/login` | `{username,password}` | 同上 |
| `POST /api/auth/logout` | `{}` | `{ok:true}`，撤销会话 |
| `POST /api/devices/bind` | `{code:"8位数字"}` | 兼容入口，返回 `{deviceId,bindingId}` |
| `POST /api/devices/unbind` | `{}` | `{ok:true}`，仅当前主人 |

账号名 3–32 位中文、字母、数字或下划线，英文字母大小写不敏感；密码 8–128 字符。密码使用独立盐的 scrypt，Cookie 会话令牌在数据库中仅存摘要，设定有效期；Cookie 为 HttpOnly、SameSite，生产启用 Secure。登录、注册和绑定限制尝试频率。用户接口不再以“本机地址”代替登录，所有记录和控制检查归属。

首版每用户同时一台设备、每设备一个用户。新流程由已登录账号申请短期票据，设备联网后完成注册与认领；事务中再次检查归属。兼容八位码要求设备刚有有效心跳、码未过期且未使用。修改 Wi-Fi 不改变归属；同账号重配沿用绑定批次。只有原账号可以解绑；解绑撤销旧票据、绑定码及待执行命令，清除当前状态，但保留原用户的历史。转绑要求固件具备绑定批次能力，避免旧协议补传误归属。

## 设备认证与注册

首次注册的 `/api/enrollment/claim` 和恢复查询 `/api/enrollment/query` 使用短期操作票据认证，不能要求尚未生成的设备凭证。服务端事务检查归属、分配身份；设备保存后通过 `/api/device/enrollment/complete` 确认。其余 `/api/device/` 请求携带：

```text
Authorization: Bearer <该设备密钥>
X-Device-ID: <该设备编号>
Content-Type: application/json
```

设备接口拒绝浏览器 Origin 请求。新编号范围为 `coaster-000001`–`coaster-999999`，凭证为 32 字节随机值的 64 位小写十六进制文本；浏览器无法从用户查询接口读取设备凭证。数据库长期保存 SHA-256 哈希，未完成操作的新凭证用票据作为密钥加密暂存，以恢复丢失回执；完成或解绑后删除密文。

服务端保存内部硬件标识与正式 ID 的唯一关联，重配与普通配置重置继续检查原账号归属。已有已登记身份使用原凭证的 HMAC 证明完成硬件关联，保留编号及有效凭证。HMAC 绑定操作、硬件和票据，不能跨操作重放。硬件标识不是防篡改硬件认证，也不跨独立数据库同步归属。

工厂仍负责重量标定；0.7.0 不需 USB 写身份或信任公钥。旧 `provision` CLI、手工登记和清单导入已移除；`server` / `trust` 命令仍用于受控运维，见 [出厂说明](factory-provisioning.md)。已有 `DEVICE_ID` / `DEVICE_TOKEN` 环境变量仍只用于旧设备首次迁移，不覆盖已登记凭证。

设备保存身份和 origin 后，BLE v2 重配要求同一 origin。生产 HTTPS 始终校验证书；只有非生产后端允许配置 RFC1918 私网 IPv4 HTTP。设备接受 HTTP 只限这些私网地址，拒绝公网 HTTP、localhost 和回环。

## 绑定码

设备联网后调用 `POST /api/device/binding`，正文 `{}`，返回：

```json
{"code":"12345678","expiresAt":1791859500000}
```

以上只是格式示例。码为随机 8 位数字，五分钟有效，服务端仅存摘要；重新申请使旧码失效，已绑定设备拒绝申请。杯垫屏幕／本地配网页显示码，用户回到正常互联网后登录网站输入。仅知道 ID、同处一个局域网、或重新设置 Wi-Fi，都不能领取已绑定设备。

## 心跳与空杯命令

`POST /api/device/heartbeat` 保留以下字段：

```ts
{
  weightGrams: number | null,
  stable: boolean,
  cupPresent: boolean,
  source: 'hx711',
  calibrated: boolean,
  emptyCupGrams: number | null,
  cups?: { id: number, name: string, emptyCupGrams: number }[],
  activeCupId?: number | null,
  cupSetup?: { id: string, cupId: number, name: string, expiresAt: number } | null,
  pendingCount: number,
  timePendingCount: number,
  clockSynced: boolean,
  error: string | null,
  firmwareVersion: string,
  provisioningVersion?: 1,
  bindingId?: string | null,
  commandResult?: { id: string, ok: boolean, message: string, bindingId?: string | null }
}
```

未标定／传感器不可用时重量为 `null`，不能捏造读数。空杯未登记为 `null`。0.7.2 活动时约五秒心跳，静置三十秒后约三十秒心跳；超过九十秒未收到有效心跳视为离线。失败按 5、10、20、40、60 秒退避，重连后立即确认。响应：

```ts
{
  ok: true,
  serverTimeMs: number,
  bound: boolean,
  bindingId: string | null,
  command: null | {id:string,cmd:'cup',expiresAt:number,bindingId:string}
}
```

服务端只下发当前绑定批次的未过期命令，迟到的旧批次回执不能影响新归属。设备同步绑定批次后持久保存，新用户批次清除旧空杯基准、保留工厂标定；同账号重新配网不清除。`bound` 用于清除旧绑定码。控制不由云端直连用户私网地址。

用户在杯垫上放空杯、静置三秒后：

1. 浏览器生成 UUID 并保留，以 `POST /api/control/cup` 提交 `{id}`。
2. 服务端确认设备归属与新鲜在线状态，创建两分钟有效的待执行命令；同一编号重试返回原命令，不重复创建。每台同时最多一条待执行命令。
3. 返回 `{command:{id,status,message,expiresAt}}`；`status` 为 `pending`、`succeeded`、`failed` 或 `expired`。请求已接收不等于空杯设置成功。
4. 杯垫通过心跳领取命令，检查 ID、有效期和 `cup` 白名单，保存执行占位后执行，持久保存结果并在后续心跳回执。重启或重传不会自动再次获取杯重；执行中断时明确报告未确认结果。
5. 浏览器调用 `GET /api/control/commands/:id` 查询，只有 `succeeded` 才显示成功。POST 响应丢失仍可用已保存的 ID 查询，不自动重发写操作。

网页和热点均无 `tare`／`calibrate` 入口；工厂通过 USB 标定。空杯命令依赖稳定重量、已有标定及配置落盘成功。设备上报命令失败不会被服务端改写为成功；已过期命令的迟到回执也不当作及时成功。

### 多杯管理（0.8.0）

新固件同时上报 `cups`、`activeCupId`、`cupSetup`，Dashboard 原样返回；字段缺失代表旧固件。最多三个固定编号（1–3），名称为 1–5 个基本汉字（U+4E00–U+9FFF）、ASCII 字母或数字，允许同名。服务端去除输入首尾空格。`emptyCupGrams` 保留为当前杯重量，列表、当前编号和重量必须一致；空列表对应两个空值。

`POST /api/control/cup` 沿用 UUID 和回执，新增以下动作；除 `id`、`action` 外，只接受表中的参数。心跳下发同样的动作参数，并附加 `cmd: 'cup'`、有效期和绑定批次。旧固件不会收到新动作。

| action | 参数 | 行为 |
| --- | --- | --- |
| `prepare` | `cupId`, `name` | 确认有效无杯读数持续 0.5 秒，暂停记录；目标已存在时名称必须一致，用于重新称重 |
| `save` | `setupId` | 关联准备命令的 UUID，确认空杯连续稳定三秒后保存，并使用该杯 |
| `cancel` | `setupId` | 取消对应设置，重新建立原杯的称重基准 |
| `rename` | `cupId`, `name` | 改名，不重置称重基准 |
| `select` | `cupId` | 执行时再次检查无杯，保存选择并清除旧取放基准 |
| `delete` | `cupId` | 删除当前杯需无杯，之后循环选择下一只；删除非当前杯不影响基准 |

准备状态仅在内存保留五分钟，超时、取消或重启后结束；保存失败可查询回执后重新提交保存。页面保留完整请求参数，同一 UUID 改变参数返回 409。设备保存成功并回执后，页面才确认完成；改名、切换和删除均不能绕过设备确认。

旧的 `{id}`／串口及热点 `{"cmd":"cup"}` 仍只重新称量当前杯；没有当前杯时创建“默认杯”，不覆盖其他条目。杯子整体保存在独立版本化 NVS `cups` 记录，当前空杯字段由该记录推导。旧重量仅在首次缺少该记录时迁移，删除全部杯子后不会重新迁移。账号换绑清空全部杯子，同账号重配 Wi-Fi 保留；工厂重量标定清空杯子，修正零点保留杯子。事件与统计结构不变，不按杯子拆分历史。

双击 BOOT 可离线按编号循环选择已保存杯子；无杯检查、记录保护和云端操作一致。发布必须先更新服务端，再更新网页／客户端和固件，保留 Flash 分区数据。

## 事件上报与统计

`POST /api/device/events`：

```ts
{events:[{
  id:string, // UUID；重传不变
  kind:'drink'|'refill',
  amountMl:number,
  beforeGrams:number,
  afterGrams:number,
  occurredAt:string, // 带时区 ISO 8601；设备使用 UTC
  bindingId?:string|null // 事件生成时冻结的批次，不用补传时的当前批次替代
}]}
```

响应 `{acknowledged:string[],inserted:number}`。按设备 ID 与事件 UUID 去重，冲突内容返回 409 并回滚批次；事务落盘后才确认。固件只删除已确认本地事件，单批最多 1000 条，现有固件逐条发送。变化至少 5 g，前后重量 0–2000 g，方向和差值必须一致。空杯值不能用于否定换杯前的历史记录。

- `GET /api/dashboard?date=YYYY-MM-DD`：返回 `{date,timeZone,totals,week,events,device}`，按登录用户拥有过的绑定批次查询；解绑后仍可读取原历史。
- `totals`：`{drinkMl,refillMl,drinkCount}`；`week` 为截至所选日期的七天统计。
- `events` 含原始事件字段与 `revokedAt`。
- `device` 为当前设备最新状态；无当前设备时为 `null`，历史仍保留。离线不代表实时重量。
- `POST /api/events/:id/revoke`：只撤销属于本人批次的记录，幂等且不删除原始数据；统计排除已撤销记录。

缺省 `bindingId` 的旧协议事件只允许映射到旧兼容批次，不会自动移到下一位用户。新固件读取旧 Flash 事件时显式发送 `bindingId:null`，作为无明确归属数据保存隔离，不能绑定到当前主人。若相同 UUID 的事件已保存且业务内容一致，缺省/null 批次重传保留云端原归属并确认，避免升级后丢失 ACK 堵塞队列；不同非空批次或业务内容冲突仍拒绝，不能覆盖原记录。

未校时事件先保存在 Flash。同次启动校时后可以回填，跨断电且从未校时的记录保留待人工确认，不归入恢复联网的当天。

## 热点与换网

首次无 Wi-Fi 自动开启热点；正常启动后长按 BOOT 三秒也可进入十分钟配网窗口。每台使用独立、持久保存的 WPA2 密码。普通断线自动重连，不无限期开放热点。配网页自包含，手机连接热点后访问 `http://192.168.4.1`，无需互联网。

热点 API 只接受热点接口地址、合法 Host 和同源请求，兼容 IPv4 映射 IPv6：

| 接口 | 用途 |
|---|---|
| `GET /` | 本地配网与绑定说明 |
| `GET /api/status` | 网络、称重、队列、绑定码及云端入口；不含路由器密码或设备密钥 |
| `GET /api/wifi-scan` | 扫描普通 2.4 GHz 网络 |
| `POST /api/command` | 用户命令白名单：Wi-Fi、重启、空杯 |
| `POST /api/binding` | 请求设备向云端申请／刷新绑定码 |
| `POST /api/time` | 手机协助尚未校时的设备建立初始时间 |

Wi-Fi 候选配置独立保存；重启尝试新网络，连上后才更新主配置，约 45 秒失败则回退旧网络。只改网络凭据，原有身份、服务器配置、标定及事件保留。页面必须区分保存候选配置、连接 Wi-Fi、连接云端；手机仍连热点时不保证能直接跳转线上网站，需明确提示切回正常网络。

工厂串口继续支持 `server`、`tare`、`calibrate`、`status`、`watch`、`pending-time` 等调试操作。生产 Node 进程不挂载 USB 路由，也不再挂载旧的局域网标定代理接口。
