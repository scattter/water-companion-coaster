# ESP32-S3 Arduino 称重固件

目标硬件：微雪 **ESP32-S3-LCD-1.47B**、TAL220B 2 kg 四线传感器，以及用户已确认支持 3.3 V 供电、只有 VCC/GND/DT/SCK 接口的 HX711 成品板。开发板为 16 MB Flash、8 MB PSRAM，本版 HX711 统一使用 3.3 V 供电。使用 **Arduino IDE 2.x + esp32 by Espressif Systems 3.3.11**；本机已有该开发板包，所需底层组件随包提供，无需另外安装 HX711、ArduinoJson 或显示库。

直接用 Arduino IDE 打开 **[water_companion/water_companion.ino](water_companion/water_companion.ino)**。同一文件夹内的 `.c` / `.cpp` / `.h` 会一起参与编译，并可在 IDE 标签页编辑；GPIO 在 [board_config.h](water_companion/board_config.h) 中设置。请保留整个文件夹，尤其是同级 `partitions.csv`，不要只复制 `.ino`。Arduino 的“另存为”可能不复制 CSV，搬动工程时复制整个文件夹并核对分区文件；参见 [Arduino 工程规范](https://docs.arduino.cc/arduino-cli/sketch-specification/)。

当前固件 **0.6.0** 实现 HX711 采样、出厂标定、用户空杯登记、离线事件保存、BLE 安全配网、热点兼容配网、云端绑定和空杯命令。BLE 使用开发板包自带的 Arduino BLE/NimBLE 和 mbedTLS，不需额外库。普通用户通过线上账号配网及查看设备，工厂经 USB 写入身份、部署信任根和标定；BLE 不能改设备 ID、token 或信任根。GPIO0 的 BOOT 键用于应用运行后的长按配网。已通过原生 Arduino 编译和主机回归测试，射频配对、按键、TLS 与掉电行为仍需真机验收。

## 1. 接线

完整说明见 [接线与安装](../hardware/circuits/wiring.md)。

| HX711 | 微雪板丝印 |
|---|---|
| CLK / SCK | GP4（GPIO4） |
| DAT / DT / DOUT | GP2（GPIO2） |
| GND | GND |
| VCC | 3V3（OUT） |

这块 HX711 没有独立 VDD，不需补接该线；VCC 不沿用旧方案的 5 V 接法。传感器接 HX711 的 E+、E−、A+、A−，线序按器件资料确认。RATE 选择 **10 SPS**。先接称重链路，保持上盘自由受力。

GPIO 已按[微雪官方资料](https://docs.waveshare.net/ESP32-S3-LCD-1.47B/)核对。GPIO1 用于板载电池电压检测、未引出到排针，本版默认 **DOUT=2、SCK=4**。可以在 Arduino IDE 的 `board_config.h` 标签页查看；改线前断开电源。

## 2. Arduino IDE 设置与上传

开发板管理器选择 **esp32 by Espressif Systems 3.3.11**。打开上述 `.ino` 后，在“工具”菜单设置：

| 设置项 | 选择 |
|---|---|
| Board / 开发板 | **ESP32S3 Dev Module** |
| USB Mode | **Hardware CDC and JTAG** |
| USB CDC On Boot | **Enabled** |
| Upload Mode | **UART0 / Hardware CDC** |
| CPU Frequency | **240MHz (WiFi)** |
| Flash Mode | **QIO 80MHz** |
| Flash Size | **16MB (128Mb)** |
| PSRAM | **OPI PSRAM** |
| Partition Scheme | **16M Flash (3MB APP/9.9MB FATFS)**，实际由工程内 `partitions.csv` 覆盖 |
| Erase All Flash Before Sketch Upload | **Disabled** |
| Core Debug Level | **None** |
| Port / 端口 | 板子对应的 `/dev/cu.usbmodem...`，按实际枚举选择 |

这些菜单名称已与本机 3.3.11 的 `boards.txt` 核对。USB 模式或 CDC 开关不符时，工程会在编译时报出具体设置提示。Arduino 的 `Serial` 使用板载 Type-C USB Serial/JTAG，命令无需接 TX/RX；未打开电脑串口时也会继续启动与采样。

点击“验证”，通过后点击“上传”。上传后打开“串口监视器”，选择 **115200** 和 **新行（New Line）**；重启后若端口变化，重新选择端口。首次看不到启动信息时可按 RESET，或直接发送 `{"cmd":"status"}`，再发送 `{"cmd":"watch","enabled":true}` 查看原始读数。

烧录不成功时确认 Type-C 线可传数据；必要时按住 BOOT、按一下 RESET，再松开 BOOT，重新选择端口后上传。芯片的 USB 下载要求参见[乐鑫 Arduino USB 说明](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)。

工程的分区表为 Arduino 固定写入的 `0xe000–0xffff` 启动数据预留空间，配置另存于 `settings`，离线事件使用独立的 2 MB `events`；正常 Arduino 串口上传不写这两个分区。不要开启“擦除全部 Flash”。缺少正确分区时固件会报告初始化失败，不能省略 CSV 后使用默认分区。

从 Arduino 0.3.x 或较早的 0.4.x 更新时分区和保存格式不变，正常上传保留联网配置、校准和事件。原 ESP-IDF 的校准和联网配置不自动迁移，首次改用 Arduino 后执行下方配置与校准。如果已在旧固件中保存事件，应先使用旧固件上传或导出；发现旧队列却没有配套启动编号时，新固件会停止初始化、保留数据，避免把旧记录归到错误的时间或设备。

### 板载屏幕

屏幕显示热点凭据、Wi-Fi 与云服务连接状态、短时账号绑定码、重量及记录队列。热点关闭时提示长按 BOOT；绑定后或码过期后不再显示旧码。未完成出厂重量标定时显示“出厂标定异常／请联系售后”。中文文案使用随固件的字形子集；修改屏幕文案后运行字体生成脚本，见 `display-font-license.txt`。

## 3. 用户配网、绑定及更换 Wi-Fi

### BLE 配网（0.6.0）

1. 工厂先写入设备身份及部署 `trust`。没有 Wi-Fi 或尚无绑定的新机上电开放 10 分钟 BLE 窗口；之后运行中长按 BOOT 3 秒重新开放。窗口到期后已有连接也不能继续写配置。设备名为 **Water-Coaster**，网页通过固定服务 UUID 选择设备。
2. 在支持 Web Bluetooth 的浏览器中登录网站，选择配网和设备。在系统配对对话框输入屏幕上的随机 **6 位 BLE 配网密码**（包含前导零）。采用 Secure Connections + MITM、16 字节加密密钥；禁止 Legacy/Just Works 降级，不保存跨主人的配对 bond。
3. 网页读取设备信息并领取当前部署签名的配置授权，再写 Wi-Fi 密码。设备挑战在一次连接中固定，重复 info 读取不更新；从产生起 5 分钟单调时钟到期，已接收一次后消耗。过期或明确失败时重新连接并领取新授权。
4. 固件严格解析授权、验证部署/设备/挑战/目标及 P-256 签名，验证成功后才允许向候选 HTTPS origin 发送设备凭证。Wi-Fi 与 URL 作为一组暂存；网络任务无需重启地连接、claim、保存配置和 bindingId，再 complete。整个候选阶段暂停普通心跳、事件上传、云命令和新取放识别。
5. Wi-Fi 45 秒失败或云端明确拒绝后恢复旧配置。claim 结果不确定时保留恢复日志并查询原操作，不重新 claim、不允许新的配置覆盖日志；断电后同样只 GET 查询。`issued` 表示认领中断，回滚后重新领取授权；`claimed/completed` 继续持久化/complete；取消或过期则回滚。Flash 写入或清理失败显示 recovering 并重试，请保持供电。
6. 状态 READ 返回完整 JSON，NOTIFY 只发送短提示，网页收到通知后重新读取。`completed` 表示配置和绑定已持久化并取得云端完成确认；恢复日志清理失败可能暂留 recovering，但不会把已完成操作当作新认领重放。

服务 `7d2a0001-7b9c-4e6a-9f21-531bd67a0c10` 下，info/config/status 分别为 `0002/0003/0004`（其余 UUID 字段相同）。config 为 write-with-response；帧为 flags（START=1、END=2）+ 小端 uint16 sequence + UTF-8 数据，首帧序号 0、总上限 4096 字节、总收包超时 10 秒。浏览器默认 20 字节帧。所有特征访问需认证加密；status 可在已认证连接的窗口关闭后继续查询已接受操作。BLE JSON 不接收 token、ID、trust 或未签名 URL。

Core Debug Level 必须 **None**，否则构建失败，避免 Arduino BLE 库自身输出 passkey 或配置分片。固件不记录 Wi-Fi 密码、ticket、原始 token 或完整授权。

### 原热点入口（保留）

1. 首次上电没有 Wi-Fi 配置时自动开放 **Water-XXXXXX** 热点。热点密码为每台独立生成并保存的 12 位密码，见屏幕；不是固定的 12345678。连接热点后选择保持无互联网连接，浏览器打开 **http://192.168.4.1**。
2. 选择家里或办公室的 **2.4 GHz Wi-Fi**，输入密码并保存。列表支持扫描、重试和隐藏网络手动输入。杯垫重启验证新网络，手机重新连接热点查看结果。
3. 新 Wi-Fi 先暂存在独立设置键，实际取得网络地址后才保存为主配置。45 秒仍未成功或配置保存失败时回到原网络，页面提示重试。更换网络不会改设备身份、账号归属、出厂标定、空杯或事件记录。候选配置清理失败时显示保存错误并每 5 秒重试，不会擦除配置或事件。
4. Wi-Fi 连接与云服务连接分别确认。云端心跳成功且设备未绑定时自动申请一次 **8 位数字绑定码**，有效期 5 分钟；用户也可在热点页主动刷新。屏幕和热点页显示绑定码，热点页显示正式网站入口。
5. 记下码，手机切回正常网络，再打开网站注册或登录并输入绑定码。不要依赖配网页自动跳转：热点本身没有互联网。绑定成功后登录网站查看最近状态和历史记录。
6. 放上日常使用的空杯，静置至少 3 秒，在网站点击空杯设置；也可在热点页设置。只有设备实际执行并回报成功，网站才显示完成。用户无需砝码。

后续更换路由器、密码或使用地点：**杯垫启动完成后长按 BOOT 3 秒**，开放 10 分钟配网窗口，再按上述方式操作。不要按住 BOOT 上电，那会进入烧录模式；窗口结束可再次长按。日常断网只自动重连，不自动长期开放热点。BOOT/Key1 为 GPIO0，按[微雪 1.47B 官方原理图](https://files.waveshare.com/wiki/ESP32-S3-LCD-1.47B/ESP32-S3-LCD-1.47B_schematic_diagram.pdf)核对。

热点页面仅提供 Wi-Fi、空杯、绑定码及状态，不提供重量标定或服务器凭证设置；不开放旧局域网控制接口。HTTP 仅接受发往热点地址的同源请求，支持 IPv4 和 IPv4 映射双栈地址。路由器密码、设备密钥和热点密码不会通过状态 JSON 返回。

手机页仅在时钟未建立时提交手机日期，之后不覆盖时钟。HTTPS 需先由 SNTP 或手机校时，证书校验不会因未校时而跳过。普通 Wi-Fi 密码网络和开放网络可用；企业认证和需网页认证的网络未实现。

## 4. 出厂写入身份与重量标定

每台整机交付前完成身份写入、云端登记和重量标定。新设备出厂编号为 **`coaster-000001`–`coaster-999999`**，由登记工具的 `--id` 指定，工厂保存每台独立设备密钥，用户网页不接收该密钥。未登记固件的默认编号根据芯片 MAC 生成，写入 `server` 命令后使用分配的六位编号；不要把固件默认编号改成所有设备共用的固定值。旧设备升级保留原编号和凭证，不会自动改号。

先在本机登记、再部署线上时，按 [本机出厂登记与上线](../docs/factory-provisioning.md) 导出并导入登记清单；仅更新线上代码不能同步本机设备记录。

通过 Arduino 串口监视器发送单行 JSON（115200，新行）。**0.5.1 起身份与地址可分开配置**，示例中的编号和密钥需替换为实际工厂登记输出；每条等待 `ok: true` 再继续：

```json
{"cmd":"server","id":"coaster-000001","token":"工具为本台设备生成的64位十六进制密钥"}
{"cmd":"server","url":"https://你的正式网站域名"}
{"cmd":"reboot"}
```

`url` 可以单独设置，保留设备编号、密钥和称重配置；`id` 与 `token` 必须成对设置，保留已有地址。至少提供一组配置，显式空值、`null` 或错误类型会被拒绝。新机仅写入身份但尚未设置地址时，`serverConfigured` 为 `false`，不会联网发送。旧的同时包含 `url`、`id`、`token` 命令继续支持，旧固件仍需完整命令。

0.6.0 的 BLE 交付还需 USB 写入部署的公开信任信息。`publicKey` 是未压缩 P-256 公钥，`04` 开头、共 130 位小写十六进制，私钥始终留在服务器。以下公钥占位文本须替换为部署工具真实输出：

```json
{"cmd":"trust","deploymentId":"11111111-1111-4111-8111-111111111111","publicKey":"04开头的130位小写hex公钥"}
{"cmd":"factory-info"}
{"cmd":"reboot"}
```

`trust` 验证 UUID、公钥编码和曲线点后保存至独立版本化记录；仅 USB 可写，生效需重启，配网恢复期间拒绝修改。`factory-info` 仅 USB 返回 `deviceId`、`identityConfigured`、`firmwareVersion`、已保存的 `serverUrl`、`trusted`、`deploymentId`、`publicKey` 和 `tokenFingerprint`（原 token 文本的 SHA-256，64 位小写 hex；无 token 时为 null），用于与工厂记录核验；从不返回原 token。旧 USB `server/wifi/tare/calibrate/cup` 路径保留。

服务地址只填协议、主机与可选端口，不带路径。交付使用 HTTPS，固件验证系统证书包、不跟随重定向。局域网开发可发送 `{"cmd":"server","url":"http://192.168.1.10:3001"}` 后重启：替换为电脑实际私网 IPv4，电脑和杯垫须在可互通网络，后端监听 `0.0.0.0:3001`，不能填 `localhost`、`127.0.0.1` 或网页端口 `5173`。详细步骤见 [局域网联调](../docs/factory-provisioning.md#局域网联调与地址切换)。

生产网站与 API 应通过同一公网域名提供，热点页面从服务器地址展示网站入口。云端登记方法见根 README，切换目标后新服务器仍需登记相同的编号与凭证哈希；两台服务器的账号归属和历史不会自动迁移。存在待上传记录时禁止修改设备编号，只改地址则仍会将待上传记录发往新目标。保存配置后重启，用 `status` 核对 `cloudUrl` 和 `serverConnected`。

整机装配完成后操作，每次移放物品后静置至少三秒：

1. 移走杯子与已知质量物品，保留承重盘，执行 `{"cmd":"tare"}` 保存零点。
2. 放上 **500 g 已知质量物品**，执行 `{"cmd":"calibrate","grams":500}`。支持 50–2000 g，参数必须是实际已知质量。
3. 移走物品，以其他已知质量复核读数；用 `{"cmd":"status"}` 或 `{"cmd":"watch","enabled":true}` 查看。交付前确认 `calibrated: true`，再关闭 watch。
4. 空杯由最终用户首次使用时设置，不要求工厂预先登记。

重量换算为 `(原始读数 − 零点) / counts_per_gram`。出厂标定提供换算比例，未知质量的空杯无法代替。原始采样需要连续稳定；标定与空杯要求约 1 g 内稳定。精度仍需实物检验。

`tare` 现在只修正零点，保留原比例和空杯设置；仅工厂串口可调用。重新执行 `calibrate` 会清除空杯设置，用户之后重新放空杯登记。固件不会每次开机自动归零，避免将杯子重量当零点。工厂更换传感器后需重新完成标定。

## 5. 云端命令、记录保存与升级

设备每 5 秒主动发送认证心跳，接收云端的 `cup` 命令；不需要云服务器访问用户局域网。仅执行未过期、格式有效的空杯命令，拒绝重量标定等命令。执行前持久保存命令身份，执行后持久保存结果，结果随心跳重发直到确认；重启和重复投递不会重复设置空杯。若执行过程中断电，回报“设置可能已保存，请检查后重试”，不会擅自再次称量。

账号归属由云端保存；重新配网或普通固件更新不会解绑。设备事件仍先写独立 NVS `events` 分区，云端确认该 UUID 后才删除，离线上限 4096 条。缓存满或写入失败会保留尚未写入的 RAM 事件并暂停识别，此时不要断电。数据损坏时停止并报告，不自动擦除。

本版保持原 `config` 版本 1 和分区布局；新事件版本 2 在生成时冻结 `bindingId`，补传时不会换成当前主人。读取原版本 1 事件时保留原 blob，不整队重写；上传明确携带 `bindingId:null`，由云端隔离，不能归给新主人。同次启动的时间补写保持原事件版本/尺寸。当前绑定、部署信任根、配网恢复日志分别保存在独立版本化键 `binding_v1`、`trust_v1`、`provision_v1`，不能通过 BLE 更换信任根。

心跳、事件和命令回执带批次；只执行 bindingId 与当前持久批次一致的云命令。旧 pending 命令保留并以 null 批次回报后确认，不重复执行。日常心跳发现主人变化时，先清除用户空杯基准再保存新 bindingId；保留工厂标定。相同 bindingId 的 Wi-Fi/URL 重配保留空杯。已结束批次事件仍按原批次补传，不影响新主人。按原分区表升级并关闭“擦除全部 Flash”，保留旧身份、标定和队列。

冷启动离线时保存事件相对时间；同一次启动完成校时后回填绝对时间。断电前从未校时的记录不能恢复真实日期，保留在 Flash 的待定时间队列，不进入每日统计，也不阻塞已知时间事件。工厂可用 `{"cmd":"pending-time"}` 导出供人工处理。

取放规则仍为约 10 Hz 采样、连续 0.5 秒离杯、放回后约两秒稳定，至少 5 g 差值才记饮水或补水。倒水也会计入重量减少，不能识别实际喝下的量。离线继续识别与保存，云服务恢复后上传。

## 6. 轻量检查与真机验收

根目录运行 `npm run test:firmware`，编译并运行实际称重、云命令 C 模块及热点测试。`firmware/test/ble_provisioning.test.mjs` 额外编译实际 C 帧解析、payload 校验、网络状态机、配置提交和旧事件读写函数，模拟网络/Flash边界，覆盖过期挑战、乱序/超限/超时帧、目标替换、严格 JSON、签名失败不联网、claim 不确定、重启只 GET、Flash 失败、回滚、同主人保留空杯、转绑清杯、USB 信任配置与旧事件隔离。固定 Node 生成的公开 P-256/P1363 向量验证了签名/篡改拒绝；主机没有 mbedTLS 时该项不代表板上 crypto 执行，真实 mbedTLS 模块由 Arduino 完整构建验证编译与链接。

可运行 `npm run build:firmware` 使用已安装的 Arduino CLI / ESP32 3.3.11 完整编译；不会上传或修改开发板包。中文提示复用现有字形，数字 passkey 包含前导零；BLE 待机期间同时保留热点 SSID 和随机密码显示。

测试不证明硬件精度或浏览器兼容性。上板还须验证 BOOT 长按、10 分钟热点窗口、错误 Wi-Fi 回退、云端 TLS 与绑定、空杯执行回执、掉电恢复和记录补传，见根目录验收说明。
