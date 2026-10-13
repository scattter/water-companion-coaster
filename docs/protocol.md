# 真实称重设备联调协议

版本：2026-10-12。当前支持一台已配置的 ESP32-S3/HX711；设备编号默认 `coaster-01`，由服务器 `DEVICE_ID` 与设备串口设置共同确定。时区默认 `Asia/Shanghai`。

## 访问方式

- 电脑网页 5173，只监听本机，`/api` 代理到后端 3001。
- 0.4.3 配网页由杯垫热点的 `http://192.168.4.1` 提供，与电脑后端独立；空杯与称重设置在折叠区。
- 0.4.4 新增由电脑后端访问的局域网校准接口，用户留在 5173 完成校准；设备凭证只在后端与杯垫之间传递。
- 后端默认监听 `0.0.0.0:3001`。设备使用电脑实际局域网 IP。
- 设备 POST 需同时携带 `Authorization: Bearer <DEVICE_TOKEN>` 与 `X-Device-ID: <DEVICE_ID>`，缺失／不匹配返回 401。
- 设备接口拒绝带 Origin 或跨站浏览器标记的请求。网页读取、撤销和健康检查保持本机 IP、Host、Origin 校验。
- 联调 HTTP 只用于受控局域网，不作为公网账号系统。HTTPS 固件启用证书包校验；正式服务部署另行完成。

## 设备心跳

`POST /api/device/heartbeat`：

```json
{
  "weightGrams": 450,
  "stable": true,
  "cupPresent": true,
  "source": "hx711",
  "calibrated": true,
  "emptyCupGrams": 120,
  "pendingCount": 0,
  "timePendingCount": 0,
  "clockSynced": true,
  "error": null,
  "firmwareVersion": "0.4.4"
}
```

所有字段必填。重量与空杯值来自实物，上例只是协议字段示意，不是初始数据。未校准或传感器不可用时 `weightGrams=null`、`stable=false`；空杯未登记为 `null`。异常通过 `error` 报告。

返回 `{ ok: true, serverTimeMs: number }`。固件约每五秒心跳，服务器超过十五秒未收到即视为离线。本地 HTTP 可以用可信电脑时间建立设备初始时钟，HTTPS 首次握手需先由 SNTP 或手机建立时钟。

## 设备事件

`POST /api/device/events`：

```ts
{
  events: [{
    id: string,             // UUID，重传保持不变
    kind: 'drink' | 'refill',
    amountMl: number,
    beforeGrams: number,
    afterGrams: number,
    occurredAt: string      // 带时区的 ISO 8601，固件使用 UTC
  }]
}
```

返回 `{ acknowledged: string[], inserted: number }`。后端按设备编号与 UUID 去重；同编号载荷冲突返回 409 并回滚批次。只有事务落盘后才确认，设备只删除已确认的本地记录。固件每次发送一条，接口最多接收 1000 条。

事件差值与方向必须一致；至少 5 g、取放重量在 0–2000 g 内。空杯值由硬件校准配置决定，后端不再固定 120 g，也不用当前空杯值否定更换杯子前的历史记录。清水 1 g ≈ 1 ml。

设备未校时的记录先保存在 Flash，不发送不可信日期。同次启动联网后可回填；跨断电未校时记录保留为待人工确认，`pendingCount` 包含它们，`timePendingCount` 是其中时间未确定的条数。

## 网页接口

- `GET /api/health` → `{ ok: true }`
- `GET /api/dashboard?date=YYYY-MM-DD` → `{ date, timeZone, totals, week, events, device }`
- `totals` 为 `{ drinkMl, refillMl, drinkCount }`，`week` 为七天 `{ date, drinkMl }`。
- `events` 包含原事件字段及 `revokedAt: string | null`，包括当天已撤销事件。
- `device` 包含最后心跳字段、`id`、`lastSeenAt` 和 `online`；未连接时重量／空杯／固件版本为 `null`，不会产生默认重量。
- `POST /api/events/:id/revoke` → `{ ok: true }`。只影响当前配置设备，幂等撤销，不删除原始事件。

所有统计排除已撤销记录，补水单独计数。最后心跳只代表上次设备状态，离线不表示实时读数。

## 手机热点控制接口

0.4.3 上电开启 WPA2 热点 `Water-XXXXXX`，密码固定为 `12345678`，屏幕显示密码与地址；旧版随机密码不再读取。手机与 Mac 均可连接并使用同一配网页。使用 AP+STA；未配置路由器时 STA 只用于扫描，不主动连接；配网成功后保留热点。

本节接口仅接受目标为热点地址的连接，兼容 IPv4 和双栈服务的 IPv4 映射 IPv6 地址，并校验 Host。静态首页 `GET /`（含查询参数）允许从聊天链接进入；热点 API 继续校验 Origin 和 Sec-Fetch-Site，不向路由器接口开放，也不启用跨域访问。0.4.4 的局域网校准使用下节独立鉴权入口。

| 接口 | 请求／响应 |
|---|---|
| `GET /` | 固件内置配网页，无外部资源依赖；空杯和首次校准默认折叠 |
| `GET /api/status` | 与串口 status 共用快照；包含 `apReady`、`apSsid`、`apIp`、`wifiConfigured`、`wifiSsid`、`serverConfigured`、`lastEvent` |
| `GET /api/wifi-scan` | 扫描附近 2.4 GHz 网络，返回 `{networks:[{ssid,rssi}]}`，最多 20 条 AP 记录；隐藏名称不返回，页面按信号排序并合并同名项 |
| `POST /api/command` | JSON；允许 `cup`、`tare`、`calibrate`（含 grams）、`wifi`（含 ssid/password）、`reboot`；复用串口的校准、稳定性与持久化逻辑，返回 `{ok,message}` 或 `{ok:false,error}` |
| `POST /api/time` | `{epochMs}`；只在设备尚未校时时设置初始日期，合法范围 2024–2099 年，不覆盖已建立的时钟，返回 `{ok}` |

`lastEvent` 是本次开机内最近一次识别到的 `{kind,amountMl,beforeGrams,afterGrams,saved}`，未发生为 `null`。`saved=false` 表示尚未成功写入 Flash，不能当作已保存；它不是完整历史列表。待上传队列仍持久化，上传确认后才移除。

所有 POST 需 `Content-Type: application/json`，正文最多 767 字节。HTTP 访问或正文校验失败返回 `text/plain; charset=utf-8`，命令执行结果返回 `application/json; charset=utf-8`；页面同时识别两种错误响应。状态不返回密码或凭证；手机不允许 `server`、`watch`、导出或任意串口命令。重启先确认请求，约一秒后执行，同时暂停新事件识别。有未保存事件时拒绝修改设置和重启。

`wifiSsid` 为本次启动实际使用的 Wi-Fi 名称，尚未配置时为空字符串。页面先确认 `wifi` 保存成功，再请求 `reboot`；只有重启配置已生效且 `wifiConnected=true`，才显示配网成功。同一页面提交后还会核对 `wifiSsid` 与刚提交的名称，避免旧网络连接被当作新配置成功；不要求传感器已校准。

0.4.3 页面支持切换当前输入密码的明文显示；保存成功或更换网络后恢复隐藏。操作确认与错误使用可关闭浮窗；联网状态在页首持续显示，重新访问也会按实时状态突出“已经成功连接 XXX”，断线后撤去成功样式。此调整不改变 Wi-Fi 保存或设备状态协议。

页面首次读取设备成功后扫描一次，之后由“重新扫描”触发；隐藏网络可手动输入。扫描与自动连接请求通过互斥锁协调；已有连接不主动断开，驱动仍在连接时返回 `503` 和中文重试提示。扫描结果读取后释放驱动列表，超时停止扫描并清理；无结果返回空数组，与扫描失败区分。

手机首次打开或检测到设备重启后，若尚未校时会发送手机日期；网络任务回填同次启动的待定事件并写回 Flash，不需要服务器可用。跨断电未校时记录仍保留，不擅自归入当天。

## 电脑网页 Wi-Fi 校准接口

0.4.4 以上固件支持以下接口。网页请求后端 3001，沿用本机 IP、Host、Origin 校验；后端只使用已通过鉴权的有效心跳来源 IPv4，要求私有地址且心跳在 15 秒内。后端重启后需收到新心跳，地址变化随新心跳更新，不接受浏览器指定设备地址或凭证。

| 后端接口 | 请求／响应 |
|---|---|
| `GET /api/control/status` | `{device}`，返回清理后的最新设备状态，与 USB 状态字段一致 |
| `POST /api/control/calibrate` | `{cmd:"tare"}`、`{cmd:"calibrate",grams:500}` 或 `{cmd:"cup"}`；确认成功返回 `{message,device}` |

后端访问杯垫相同路径，携带 `Authorization: Bearer <DEVICE_TOKEN>` 和 `X-Device-ID`。固件校验目标是当前路由器接口地址、编号与凭证，拒绝 Origin、Sec-Fetch-Site 浏览器请求；局域网只开放读状态和三种校准命令，不能修改 Wi-Fi、服务器凭证或重启。热点接口限制保持原样。

固件状态返回原有 status 快照；校准返回 `{ok:true,message,device}`，其中 device 是保存后的快照。固件拒绝时返回 `{ok:false,error}`，后端不报成功。读取与写入串行，5 秒超时，不自动重发写入；确认丢失时说明结果尚未确认，确认成功但状态缺失时明确说明已保存。旧固件返回 403／404 时提示升级至 0.4.4。打开网页设置后每两秒读取，关闭设置后停止轮询；首页仍按原有心跳展示在线状态。

## 本机 USB 配置接口

这些接口沿用网页的本机 IP、Host、Origin 限制，不属于 `/api/device/` 上传接口。兼容 0.3.1 及以上固件；由 Node 后端以 115200 波特率访问电脑 USB 串口，不使用 Web Serial。

| 接口 | 请求／响应 |
|---|---|
| `GET /api/setup/options` | 返回 `ports: [{path, manufacturer?}]`、本机私有 IPv4 对应的 `serverUrls`、`deviceId`；不返回凭证 |
| `POST /api/setup/connect` | `{path}`；只接受当前枚举的端口，读取状态并关闭 watch 推送，握手成功返回 `{connected, path, device}` |
| `GET /api/setup/status` | 返回 USB 连接状态和最新串口快照；未连接时 `device=null`，不虚构读数 |
| `POST /api/setup/disconnect` | `{}`；关闭串口，返回 `{ok:true}`，不影响 Wi-Fi 上报 |
| `POST /api/setup/wifi` | `{ssid, password, serverUrl}`；后端依次发送 wifi、server、reboot，每步检查确认；成功返回 `{message}` 并关闭 USB |
| `POST /api/setup/calibrate` | `{cmd:"tare"}`、`{cmd:"calibrate", grams:500}` 或 `{cmd:"cup"}`；成功返回 `{message, connected, path, device}` |

联网请求只能选择当前电脑的局域网地址，设备编号和凭证来自服务端环境；浏览器不能提交设备凭证或任意串口命令。Wi-Fi 长度按 UTF-8 字节校验，开放网络允许空密码。校准能否成功由固件的有效采样、稳定性和存储结果决定。

串口一次只接受一个操作；写入过程中轮询或其他操作返回 409，前端会先等待当前轮询结束。超时或断线关闭连接，防止迟到确认被后续命令复用。联网多步写入没有事务回滚，部分成功时明确提示重新配置，不能视为全部完成。USB 状态每两秒读取；“设备在线”仍依赖原有 Wi-Fi 心跳。

## 存储与配置

默认数据库为 `data/coaster-hardware.sqlite`，表为 `device_events`、`device_status`，旧演示库不参与读取。固件校准和联网配置在 `settings` NVS 分区，事件在 `events` NVS 分区，容量上限 4096 条。

串口使用单行 JSON：`wifi`、`server`、`tare`、`calibrate`、`cup`、`status`、`watch`、`pending-time`、`reboot`。命令参数与执行顺序见 [固件说明](../firmware/README.md)。联网配置需重启，校准立即生效；配置失败不得作为成功继续操作。
