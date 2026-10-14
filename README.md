# 饮水陪伴杯垫

用户流程：**网站注册/登录 → 蓝牙选择杯垫 → 填写 Wi-Fi → 自动联网并绑定 → 设置空杯 → 查看饮水记录**。设备服务器地址由管理员配置，配网时自动下发；用户不填写设备编号、长期密钥或服务器地址。网站不要求用户电脑常开。

硬件为微雪 ESP32-S3-LCD-1.47B、TAL220B 2 kg 传感器和 3.3 V 单 VCC HX711。接线与 Arduino 设置见 [固件说明](firmware/README.md)。正常升级保留分区、编号、凭证和校准，不擦除 Flash。

## 用户首次使用

1. 用支持 Web Bluetooth 的浏览器打开正式 HTTPS 网站，注册或登录。优先使用 Android Chrome 或支持该功能的桌面 Chrome；网页会检测能力，iPhone Safari 不支持此配网方式。
2. 新机通电自动开放限时配网；已配网设备正常启动后长按 BOOT 三秒。不要按住 BOOT 上电，那是烧录模式。
3. 点击“添加杯垫”，从系统蓝牙选择器选择设备，按系统提示确认或输入杯垫屏幕上的蓝牙配对码。
4. 输入普通 2.4 GHz Wi-Fi 名称和密码。网页自动附上管理员配置的服务地址及短期绑定授权。
5. 等待设备联网、云端绑定和配置持久化全部完成。仅蓝牙发送成功或取得 Wi-Fi 地址不代表完成。
6. 放上自己的空杯，静置至少三秒，执行空杯设置；收到设备成功回执后再加水。

每账号同时一台杯垫。设备已属于其他账号时，必须由原账号在网页设备设置中解绑。解绑保留原用户历史，新用户看不到前任记录；新用户需要重新设置空杯。同账号换 Wi-Fi 不需要解绑，沿用设备设置中的蓝牙重新配网。

设备网页关闭后继续采样，断网记录保存在设备，云端确认后才删除。未完成工厂标定会提示联系售后，不要求普通用户准备砝码。首版不支持企业 Wi-Fi、网页认证 Wi-Fi 或固件 OTA。

## 管理员与出厂流程

完整步骤见 [出厂登记、管理员配置与蓝牙配网](docs/factory-provisioning.md)。

- 每套服务初始化一个部署 UUID 与 P-256 签名私钥；私钥留在服务端，公开部署信息通过 USB 写入杯垫。
- 工厂逐台分配 `coaster-000001`–`coaster-999999`、生成独立 token，并通过 USB 写入。工具输出命令，操作员负责实际串口发送。
- 管理员从网页导入出厂登记清单，或登记单台编号/token；数据库只保存 token 哈希。相同登记可重复，冲突不覆盖。
- 管理员配置 HTTPS 设备服务 origin，不带路径。初始取 HTTPS `APP_ORIGIN`，之后以数据库设置为准。
- 修改地址只在设备下次蓝牙配网时生效；新入口必须连接同一套部署、账号和绑定数据库，不能借换地址绕过旧账号归属。
- 工厂进行 `tare`、`calibrate` 和重量复核。用户空杯由最终用户自己设置。

管理员权限通过服务器本机 CLI 赋予指定的已注册账号，不按注册顺序自动授予：

```sh
npm run admin -- --username 已注册账号
npm run provisioning-key -- --out ./data/provisioning-private.pem
npm run provision -- --id coaster-000001
npm run provision -- --export ./output/factory/batch-001.json --id coaster-000001
```

上述命令须在正确的 `DB_PATH` 环境中运行。签名私钥、部署 UUID、数据库需要受控备份，不提交 Git。工厂本机库不会随代码部署自动同步；日常从管理员网页导入清单，不需要用本机数据库覆盖线上库。

## 本地开发与部署

使用 Node.js 24。已有 `.env` 时保留，不覆盖原有凭证。首次准备：

```sh
npm ci
cp .env.example .env
npm run dev
```

开发网页为 `http://127.0.0.1:5173`，API 为 3001。localhost 可作为浏览器安全上下文，但杯垫不能访问手机/电脑的 localhost；真实蓝牙联调的设备 API 仍需受信任 HTTPS，设置地址不能用 Vite 静态网页端口代替后端。

生产提供 HTTPS 网站与同源 `/api`，使用单实例 Node 后端、持久 SQLite。Compose 部署见 [容器部署说明](deploy/README.md)。

```dotenv
NODE_ENV=production
APP_ORIGIN=https://你的域名
DB_PATH=/持久目录/coaster.sqlite
PROVISION_SIGNING_KEY_FILE=/受控目录/provisioning-private.pem
PROVISION_DEPLOYMENT_ID=密钥工具输出的UUID
```

未设置签名配置时，已有账号和传统设备功能仍可运行，新蓝牙授权不可签发。私钥与数据库中固定的部署公钥不一致会被拒绝，不能日常重启时随机换密钥。

旧设备可保留折叠的“热点配网 + 八位码”兼容入口，前提是设备已有可信服务地址。该入口不是新机蓝牙流程的必经步骤，也不能覆盖已有账号归属。无蓝牙能力的旧固件需一次 USB 升级和信任配置才能使用新方式。

## 检查与验收

```sh
npm run check
npm run build:web
npm run test:firmware
npm run build:firmware
```

`build:firmware` 使用本机 Arduino CLI 和 esp32 3.3.11，按 S3、16 MB Flash、OPI PSRAM 完整编译，不执行上传。输出在忽略的 `data/build/esp32s3` 中。

构建网页后，`npm run smoke:web` 可在 `http://127.0.0.1:4137` 启动隔离演示：使用临时数据库和测试签名，不读取生产 `.env`，终端会显示仅供本机演示的管理员账号。这个入口不用于部署。

自动化包括独立数据库/API、蓝牙传输替身和固件模块测试；实际配对、Wi-Fi/BLE 共存、断电恢复、屏幕及称重精度需要真机验收。执行记录及边界见 [验证记录](docs/validation.md)。

协议见 [云端协议](docs/protocol.md) 与 [BLE 配网 v1](docs/ble-provisioning-v1.md)。清水按 1 g≈1 ml 估算，只凭重量不能区分倒水与喝水，喝完直接补水只记录净变化。断电前从未校时的记录保留为待确认时间，不擅自算入联网当天。
