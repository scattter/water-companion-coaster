# BLE 自动注册配网 v2

对应固件 0.7.0 及更新版本。0.7.2 默认流程为登录、BLE 配对、选择扫描到的 2.4 GHz Wi-Fi 并填写密码、设备联网注册、保存身份、确认绑定。服务端生成正式设备 ID 和独立凭证，用户不接触设备编号或长期 token。v1 继续用于旧固件，见 [兼容协议](ble-provisioning-v1.md)。

## BLE 契约

服务 UUID、info/config/status 特征、分片格式与状态结构沿用 v1。采用 Secure Connections + MITM；新机或正常启动后长按 BOOT 三秒开放十分钟窗口。challenge 是每次连接生成的 32 字节随机值，五分钟有效且仅接受一次配置。

info 返回：

```ts
{
  protocolVersion: 2,
  hardwareId: string, // Wi-Fi STA 硬件 MAC 的 12 位小写 hex，内部使用
  deviceId: string,   // 未保存认证身份时为空串
  challenge: string, // 64 位小写 hex
  wifiScan?: true    // 0.7.1 起支持，缺省时网页保留手动输入
}
```

### Wi-Fi 扫描（0.7.1）

新增 READ+WRITE 特征 `7d2a0005-7b9c-4e6a-9f21-531bd67a0c10`，沿用加密、MITM 认证和十分钟配网窗口。网页仅在 info 声明 `wifiScan: true` 时访问；连接后自动扫描，旧固件提示升级并允许手动输入。

- 写入单字节 `[1]` 请求扫描。设备用短期任务调用已有 `network_scan()`，不阻塞 BLE 回调、屏幕或按键；扫描与 Wi-Fi 重连共用锁，配网处理中不接受新扫描。
- 读取 JSON `{state,count,index?,network?,code?}`。state 为 `idle|scanning|ready|failed`；scanning 时网页每 250ms 查询一次，整次扫描与分页最多等待 30 秒，超时断开连接。
- ready 时 count 为 0–20。非空列表默认返回 index 0；`network` 为 `{ssid,rssi,channel,secure}`。写入 `[2,index]` 后读取相应网络。每次只返回一个网络，避免超过 GATT 属性 512 字节上限；不依赖扩大 MTU。
- 仅保留有名称且信道为 1–14 的网络。ESP32-S3 本身仅支持 2.4 GHz；网页按信号排序并合并同名网络，开放网络无需填写密码。隐藏网络保留手动输入。
- failed 的 code 为 `WIFI_BUSY` 或 `SCAN_FAILED`，网页展示重试提示。任务或临时内存分配失败也返回失败，不触发设备复位。
- 扫描不会申请绑定票据、保存配置或消费 challenge。扫描中禁止写入配网配置，断开或更换 BLE 会话会使旧扫描结果失效；网页不持久保存网络列表或密码。

config 严格接受下列九个字段；不能指定长期凭证或正式设备编号：

```ts
{
  protocolVersion: 2,
  operationId: string,
  hardwareId: string,
  challenge: string,
  ssid: string,
  password: string,
  serverUrl: string,
  ticket: string,
  expiresAt: number
}
```

设备验证 hardwareId、challenge、窗口、Wi-Fi 长度和地址格式后，先持久保存日志再联网。已有 token 与 serverUrl 时，候选 origin 必须与已保存地址相同。首次地址通过用户确认的加密 BLE 建立，不要求预写部署公钥。

## 用户 API

Cookie 登录与同源检查沿用现有接口，普通用户即可调用：

| 接口 | 输入 | 输出 |
|---|---|---|
| `POST /api/enrollment/operations` | `{hardwareId,deviceId:string或null,challenge}` | `{operationId,hardwareId,deviceId:string或null,serverUrl,ticket,expiresAt}` |
| `GET /api/enrollment/operations/:id` | 操作 UUID | `{operationId,hardwareId,deviceId,bindingId,status,code?,message?}` |

申请时只创建待认领操作，不提前为全新设备生成编号或绑定。票据为 32 字节随机值，五分钟内可首次认领；同一硬件和 challenge 不得再次申请。只允许发起账号查询，查询不返回 ticket 或设备 token。浏览器仅保存操作、硬件、设备编号及过期时间，不持久保存 Wi-Fi 密码或票据。

## 设备 API

`POST /api/enrollment/claim` 与 `POST /api/enrollment/query` 不使用设备 Bearer 认证，拒绝浏览器 `Origin` / `sec-fetch-site` 请求头，使用正文票据验证：

```ts
{ operationId: string, hardwareId: string, ticket: string, deviceId?: string, identityProof?: string }
```

已有设备发送 deviceId 和 identityProof，避免把原长期 token 发送给候选地址。证明定义为小写十六进制：

```text
HMAC-SHA256(
  key = SHA256(原始 token 文本) 的 32 字节摘要,
  message = operationId + LF + hardwareId + LF + ticket
)
```

claim 事务重新检查账号与设备归属：

- 首次注册由服务器生成唯一 `coaster-000001`–`coaster-999999` 编号及 64 位 hex 凭证；未在当前服务登记的旧本机编号同样取得正式身份。
- 已登记身份验证原凭证后关联硬件，保留编号和凭证；相同主人沿用 bindingId。
- 已知硬件但设备丢失身份时，硬件查询仍检查原归属。原账号或已经解绑的设备可恢复身份，另一个账号不能借普通重置抢绑。
- 每账号同时一台设备。并发申请在认领事务再次检查，一个操作成功后取消该硬件其他未完成操作。
- 硬件标识只用于识别普通重置后的同一设备，不是防篡改硬件认证，也不跨独立服务器同步所有权。

设备查询/认领响应：

```ts
{
  operationId: string, hardwareId: string, deviceId: string | null,
  bindingId: string | null,
  status: 'issued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired',
  serverTimeMs: number, token?: string, code?: string, message?: string
}
```

仅新签发凭证且处于 claimed 时返回 token；保留原凭证时不返回，设备继续使用已证明的原 token。恢复查询可重取同一份新凭证。完成和解绑后不再返回凭证。

设备持久保存后，以新的或保留的 `X-Device-ID` + Bearer 凭证调用：

```text
POST /api/device/enrollment/complete
{operationId,bindingId} -> {ok:true,status:'completed'}
```

此接口检查当前身份、批次与操作状态，重复完成幂等。网页仅在云端 completed 且当前会话账号、设备和批次一致时显示成功。

## 存储与恢复

数据库迁移 v4 增加 devices.hardware_id 唯一关联及 enrollment_operations，不删除旧表或历史。设备 token 长期仅存 SHA-256 哈希。待完成的新 token 使用票据原始 32 字节作为 AES-256-GCM 密钥，随机 12 字节 IV，operationId 作 AAD；数据库只存 ticket 哈希和密文，完成或解绑清除密文。

固件主配置及分区不变。`provision_v1` 键中的 v2 日志追加 hardwareId、分配 ID 和凭证；按 blob 长度兼容旧 v1 记录。先写接受日志，再 claim；云端回应后先写身份日志，再保存主配置与绑定，最后 complete、清日志。重启与回执丢失只查询原操作，不再次 claim。

issued 过期后不能认领；已经 claimed 的操作保留恢复能力，不因首次认领时限到期而丢失身份。Wi-Fi 失败或云端拒绝时恢复旧配置；网络结果未知时继续查询。旧版有效凭证重配不轮换，取消操作也不使原设备失去认证能力。解绑撤销操作、绑定码和命令，历史仍按原 bindingId 隔离。

## 本地 HTTP

非生产后端可下发 RFC1918 私网 IPv4 HTTP origin，默认从唯一可用局域网地址和 PORT 生成；排除回环及常见隧道/虚拟网卡，多网卡需显式配置。管理员已保存地址优先。正式 `NODE_ENV=production` 配置仍只接受 HTTPS；设备 HTTPS 校验证书，不跟随重定向。

Mac Chrome / Edge 网页使用 `http://localhost:5173` 或 `http://127.0.0.1:5173`，杯垫连接电脑的 `http://局域网IP:3001`。局域网 IP 的 HTTP 网页不满足 Web Bluetooth 安全上下文要求；这是浏览器限制，不能通过设备 HTTP 支持消除。
