# BLE 配网 v1 实现契约

本次内部跨端契约；实现后同步到用户协议文档。地址均为 HTTPS origin（无路径/查询/凭据/fragment），最长 191 UTF-8 字节，配置在同一部署的数据和信任范围内。

## 标识与签名

- deploymentId：部署 UUID，服务端配置并持久保存；与 P-256 私钥及数据库一起备份。固件 USB 写入 deploymentId 和 publicKey（未压缩 secp256r1 公钥，04 开头的 130 位小写 hex）。普通 BLE 不可改信任根。
- challenge：每次 BLE 配网会话设备产生的 32 随机字节 hex（64字符）。
- operationId / bindingId：UUID。ticket：32 随机字节 hex（64字符）。
- authorization.payload 是如下字段用单个 LF 拼接，无尾部 LF：`coaster-provision-v1`, deploymentId, deviceId, challenge, operationId, serverUrl, configVersion（十进制）, expiresAt（Unix 毫秒十进制）, ticket。
- authorization.signature：SHA256 + ECDSA P-256，IEEE-P1363 r||s，128位 hex。固件严格解析 payload，先验证签名、部署/设备/挑战/目标和窗口时限，再连接目标；禁止重定向，不能在验签前发出设备 token。
- 设备未校时可用 serverTimeMs（从签名 expiresAt 减固定 5 分钟推导签发时刻）辅助 TLS 校时；不能凭未签名客户端时间扩大授权窗口。挑战从产生起单调时钟最多5分钟有效；持久化已接受操作专用于中断恢复，不允许再次开始新认领。

## BLE

服务 UUID `7d2a0001-7b9c-4e6a-9f21-531bd67a0c10`。
- info READ `7d2a0002-7b9c-4e6a-9f21-531bd67a0c10`：JSON `{protocolVersion:1,deviceId,deploymentId,challenge,trusted:boolean}`。不返回 token、密码、公钥私密信息。
- config WRITE `7d2a0003-7b9c-4e6a-9f21-531bd67a0c10`：write-with-response 分片。每帧第1字节flags(bit0 START, bit1 END)，随后2字节小端递增sequence，剩余为UTF-8 JSON片段。每次浏览器默认使用20字节帧（17字节数据）；首帧序号0；总上限4096字节，收包10秒超时。完整消息 `{protocolVersion:1,operationId,ssid,password,authorization:{payload,signature}}`。每个新消息从 START 开始，所有字段严格校验。认证/加密配对后才可读info/写配置。
- status READ+NOTIFY `7d2a0004-7b9c-4e6a-9f21-531bd67a0c10`：JSON `{operationId,stage,message,sequence}`。stage 为 `idle|received|wifi_connecting|cloud_verifying|bound|saving|completed|failed|recovering`。notify 只发送短通知（阶段变更提示），浏览器收到任意通知后 readValue 读取完整结果，避免 MTU 截断。failed包含可选稳定 `code`。
- 新机和 BOOT 长按开放10分钟窗口；关闭窗口禁止已有连接的配置写入。安全连接使用 BLE SC + 显示屏配对确认，不记录WiFi/票据内容。

## 网页/管理员 API

沿用同源JSON/Cookie；错误 `{error,code?}`；Session增加 `user.role:'user'|'admin'`, `bindingId:string|null`。

- GET `/api/admin/devices` -> `{devices:[{id,createdAt,bound:boolean,username:string|null}]}`。
- POST `/api/admin/devices` `{id,token}` -> `{inserted:number,skipped:number}`；同编号同hash幂等，冲突409，永不返回token。
- POST `/api/admin/devices/import` `{version:1,devices:[{id,tokenHash,createdAt}]}` -> `{inserted,skipped}`。
- GET `/api/admin/settings` -> `{serverUrl,configVersion,deploymentId,publicKey,signingReady}`。
- POST `/api/admin/settings` `{serverUrl}` -> 同GET；生产仅HTTPS origin。签名密钥不通过HTTP配置。
- POST `/api/provisioning/operations` `{deviceId,deploymentId,challenge}` -> `{operationId,serverUrl,expiresAt,authorization:{payload,signature}}`。授权包含ticket；网页不解析其安全决策。
- GET `/api/provisioning/operations/:id` -> `{operationId,deviceId,status:'issued'|'claimed'|'completed'|'failed'|'cancelled'|'expired',bindingId:string|null,code?:string,message?:string}`。只允许发起用户查询。
- POST `/api/devices/unbind` `{}` -> `{ok:true}`；仅当前主人，事务结束批次、废止票据/命令/绑定码、清空当前状态。保留历史和设备身份。

## 设备认证 API

沿用 X-Device-ID + Bearer 原始 token。所有操作响应可包含 serverTimeMs。
- POST `/api/device/provisioning/claim` `{operationId,ticket}` -> `{operationId,bindingId,status:'claimed'|'completed',serverTimeMs}`。事务消费；同操作同设备幂等；同主人重配复用bindingId；他人已绑定409；已作废票据不得恢复。
- GET `/api/device/provisioning/operations/:id` -> 与claim相同状态结构/明确失败状态，供断线恢复。绑定结束后旧操作返回cancelled，不重新认领。
- POST `/api/device/provisioning/complete` `{operationId,bindingId}` -> `{ok:true,status:'completed'}`。设备已将配置和batch持久化才提交。
- 心跳body增加 `bindingId?:string|null`, `provisioningVersion?:1`；commandResult含bindingId（新协议）。响应增加 `bindingId:string|null`；命令增加bindingId。旧协议保持解析兼容，但转绑后不允许无批次数据出现在新用户记录。
- events每项增加 `bindingId?:string|null`，在生成事件时冻结，不在补传时改为当前批次。版本1已存数据须保留读取及明确隔离策略。缺省/显式null重传已存在的同内容UUID时保留云端原归属并ACK，不能因升级缺批次导致队列阻塞；不同非空批次仍拒绝。
- 新协议带空批次的旧commandResult安全忽略，但心跳仍成功返回当前批次，使固件能清理旧pending回执并完成升级同步；不能借空批次确认新命令。

## 解绑与兼容

- 当前绑定是devices.user_id + binding_id，永久device_bindings记录user_id和起止时刻；事件/命令按批次归属。旧用户的历史保留可查询（dashboard按请求用户自己的批次，不只当前deviceId）；无当前设备时device为null或明确无设备状态，前端必须处理。
- 云端迁移已有明确归属的数据到legacy批次；未绑定历史隔离。设备升级前遗留事件没有批次时只能归原legacy批次或隔离，禁止转给新主人。
- 已转绑设备的旧协议不执行新批次命令；转绑要求具备批次能力。旧8位码入口共用归属事务及批次规则，不得绕过。
- 日常心跳取得批次变更时持久化；新主人时清空用户空杯基准、保留工厂标定。过期旧批次可补传历史，但不能影响新批次状态/命令。

## 部署与出厂工具命名（最终）

- 环境变量固定 `PROVISION_SIGNING_KEY_FILE`（PEM私钥文件路径）、`PROVISION_DEPLOYMENT_ID`（UUID）。地址在首次启动取 HTTPS APP_ORIGIN，此后以数据库管理设置为准；无 SERVER_URL 环境变量。
- createApp 注入选项 signingKeyPath/deploymentId/serverUrl 便于测试。
- `server/src/provisioning-key.ts --out <private.pem> [--deployment-id <uuid>]`；公开stdout JSON `{deploymentId,publicKey}`，私钥仅文件保存，不覆盖已有文件。
- `server/src/admin.ts --username <已注册账号>`，使用DB_PATH；提升该账号管理员，不自动选首个账号。
- USB信任配置 `{"cmd":"trust","deploymentId":"UUID","publicKey":"04..."}`；身份 `server` 命令不变；只读 `{"cmd":"factory-info"}` 返回脱敏身份与信任信息。
