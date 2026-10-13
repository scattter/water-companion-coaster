# 云端设备与用户协议

版本：2026-10-13。当前产品链路为 ESP32-S3 主动连接服务端、浏览器同源访问用户 API。开发用受控局域网 HTTP，生产使用 HTTPS 与证书校验。设备编号是公开标识，不能作为登录或绑定凭据。

## 账号与归属

| 接口 | 请求 | 响应 |
|---|---|---|
| `GET /api/auth/session` | 无 | `{user:null或{id,username},deviceId:null或string}` |
| `POST /api/auth/register` | `{username,password}` | 会话及设备归属，并设置 Cookie |
| `POST /api/auth/login` | `{username,password}` | 同上 |
| `POST /api/auth/logout` | `{}` | `{ok:true}`，撤销会话 |
| `POST /api/devices/bind` | `{code:"8位数字"}` | `{deviceId}` |

账号名 3–32 位中文、字母、数字或下划线，英文字母大小写不敏感；密码 8–128 字符。密码使用独立盐的 scrypt，Cookie 会话令牌在数据库中仅存摘要，设定有效期；Cookie 为 HttpOnly、SameSite，生产启用 Secure。登录、注册和绑定限制尝试频率。用户接口不再以“本机地址”代替登录，所有记录和控制检查归属。

首版每用户一台设备、每设备一个用户。绑定要求设备刚有有效心跳、码未过期且未使用；数据库事务与唯一约束避免并发抢绑。修改 Wi-Fi 不改变云端归属。当前没有解绑或转让 API。

## 设备认证与注册

每台设备预先登记独立 ID 与随机密钥，所有 `/api/device/` 请求同时携带：

```text
Authorization: Bearer <该设备密钥>
X-Device-ID: <该设备编号>
Content-Type: application/json
```

设备请求不接受浏览器 Origin／跨站访问，设备密钥不进入网页响应。工厂通过 `npm run provision -- --id ... --url https://...` 向 API 使用的 SQLite 登记设备，并将输出的 `server` JSON 经 USB 写入设备。生产 HTTPS 校验服务器证书，不能通过关闭校验解决时钟或连接失败。

已有 `DEVICE_ID`／`DEVICE_TOKEN` 只用于首次迁移旧联调设备，已登记的凭证不被覆盖。现有 `device_events` 与 `device_status` 数据保留；新增账号、会话、设备归属、绑定码及命令存储。

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
  pendingCount: number,
  timePendingCount: number,
  clockSynced: boolean,
  error: string | null,
  firmwareVersion: string,
  commandResult?: { id: string, ok: boolean, message: string }
}
```

未标定／传感器不可用时重量为 `null`，不能捏造读数。空杯未登记为 `null`。设备约五秒心跳，超过十五秒未收到有效心跳视为离线。响应：

```ts
{
  ok: true,
  serverTimeMs: number,
  bound: boolean,
  command: null | {id:string,cmd:'cup',expiresAt:number}
}
```

服务端只下发当前设备的未过期命令；`bound` 用于清除设备显示的旧绑定码。控制不再由云端直连用户私网地址。

用户在杯垫上放空杯、静置三秒后：

1. 浏览器生成 UUID 并保留，以 `POST /api/control/cup` 提交 `{id}`。
2. 服务端确认设备归属与新鲜在线状态，创建约三十秒有效的待执行命令；同一编号重试返回原命令，不重复创建。每台同时最多一条待执行命令。
3. 返回 `{command:{id,status,message,expiresAt}}`；`status` 为 `pending`、`succeeded`、`failed` 或 `expired`。请求已接收不等于空杯设置成功。
4. 杯垫通过心跳领取命令，检查 ID、有效期和 `cup` 白名单，保存执行占位后执行，持久保存结果并在后续心跳回执。重启或重传不会自动再次获取杯重；执行中断时明确报告未确认结果。
5. 浏览器调用 `GET /api/control/commands/:id` 查询，只有 `succeeded` 才显示成功。POST 响应丢失仍可用已保存的 ID 查询，不自动重发写操作。

网页和热点均无 `tare`／`calibrate` 入口；工厂通过 USB 标定。空杯命令依赖稳定重量、已有标定及配置落盘成功。设备上报命令失败不会被服务端改写为成功；已过期命令的迟到回执也不当作及时成功。

## 事件上报与统计

`POST /api/device/events`：

```ts
{events:[{
  id:string, // UUID；重传不变
  kind:'drink'|'refill',
  amountMl:number,
  beforeGrams:number,
  afterGrams:number,
  occurredAt:string // 带时区 ISO 8601；设备使用 UTC
}]}
```

响应 `{acknowledged:string[],inserted:number}`。按设备 ID 与事件 UUID 去重，冲突内容返回 409 并回滚批次；事务落盘后才确认。固件只删除已确认本地事件，单批最多 1000 条，现有固件逐条发送。变化至少 5 g，前后重量 0–2000 g，方向和差值必须一致。空杯值不能用于否定换杯前的历史记录。

- `GET /api/dashboard?date=YYYY-MM-DD`：返回 `{date,timeZone,totals,week,events,device}`，只查询登录用户绑定的设备；未绑定时 404。
- `totals`：`{drinkMl,refillMl,drinkCount}`；`week` 为截至所选日期的七天统计。
- `events` 含原始事件字段与 `revokedAt`。
- `device` 含最后心跳字段、`id`、`lastSeenAt`、`online`；离线不代表实时重量。
- `POST /api/events/:id/revoke`：只撤销本人设备的记录，幂等且不删除原始数据；统计排除已撤销记录。

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
