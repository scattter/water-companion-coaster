# 容器部署说明

一个 HTTPS 域名同时提供网页与 `/api/`，SQLite 放在持久卷，**单个 Docker 主机、单实例**运行（后端把限流计数放在进程内存，不能横向扩容，也不要用副本模式）。

| 文件 | 作用 |
| --- | --- |
| [Dockerfile](../Dockerfile) | 两个构建目标：`api`（Node 24 后端）、`web`（Nginx + 静态网页） |
| [compose.yaml](compose.yaml) | 生产编排：`api` + `web` + 持久卷 |
| [compose.caddy.yaml](compose.caddy.yaml) | 可选叠加：用 Caddy 自动申请 HTTPS 证书 |
| [nginx.conf](nginx.conf) | 网页容器的 Nginx 配置：托管 `web/dist` 并转发 `/api/` |
| [.env.example](.env.example) | 生产变量示例，复制为 `deploy/.env` 使用 |

## 一、前置条件

- Docker 与 Compose v2；能拉取 `node:24-bookworm-slim`、`nginx:stable-alpine`。
- 域名已解析到本机，80/443 可用（设备固件要求**有效证书**的 HTTPS，不能省）。
- 服务器时钟同步（`timedatectl set-ntp true`）：事件时间和 15 秒在线判定都依赖它。

## 二、首次部署

```sh
cd deploy
cp .env.example .env
vi .env                     # 至少把 APP_ORIGIN 改成真实域名
docker compose up -d --build
docker compose ps           # api 应为 healthy，web 为 running
```

`APP_ORIGIN` 必须与浏览器地址、证书域名**完全一致**且不带路径。后端会校验 `Host`，用 IP 或 `www.` 等别的域名访问都会返回 `403 请从正式网站访问`。

## 三、验证

```sh
# 网页与 API 都通过同一个域名
curl -sS https://你的域名/api/health          # {"ok":true}
curl -sSI https://你的域名/ | head -1
# 从容器角度看：健康检查必须带正式域名，否则 403（应用的 Host 校验）
curl -sS -H 'Host: 你的域名' http://127.0.0.1:8080/api/health
```

再走一遍真实流程：注册 → 登录 → 重启容器后仍是登录态：

```sh
docker compose restart api
curl -sS -H 'Host: 你的域名' http://127.0.0.1:8080/api/auth/session
```

## 四、管理员初始化、签名配置与设备登记

网站启动后，先注册要用作管理员的普通账号，再在服务器明确提升该账号。服务本身不会根据注册顺序分配管理员权限：

```sh
cd deploy
docker compose exec api node server/dist/admin.js --username 已注册账号
```

重新读取会话后，网站显示管理员入口。管理员无须先绑定杯垫。

首次启用蓝牙配网前，在持久卷内生成部署专用签名私钥：

```sh
docker compose exec api node server/dist/provisioning-key.js --out /data/provisioning-private.pem
```

工具只输出公开的 `deploymentId` 和 `publicKey`；私钥以受限权限保存在指定文件，不覆盖已有文件。把输出的部署 UUID 以及容器内文件路径写入 `deploy/.env`：

```dotenv
PROVISION_SIGNING_KEY_FILE=/data/provisioning-private.pem
PROVISION_DEPLOYMENT_ID=工具输出的UUID
```

再执行 `docker compose up -d api` 让新环境生效。部署身份与公钥首次写入数据库后固定；密钥/部署配置不匹配会拒绝启动，不会默默更换设备信任根。未配置签名时旧服务仍可运行，但不能签发新的蓝牙配网授权。

工厂将 `{deploymentId,publicKey}` 包装成 `trust` USB 命令写入设备，原始设备 ID/token 仍逐台独立生成。完整步骤见 [出厂登记与蓝牙配网](../docs/factory-provisioning.md)。

管理员进入网页的设备管理后：

- 上传工厂导出的登记清单，或单台登记编号与 token。数据库只保存哈希；同编号同凭证幂等，冲突拒绝，不覆盖归属。
- 设置设备服务器 HTTPS origin。首次默认取 HTTPS `APP_ORIGIN`，之后以数据库管理设置为准，服务重启不会恢复成旧环境值。
- 地址不带 `/api` 路径，必须连接同一套部署、账号和绑定数据。普通用户在下次蓝牙配网时自动收到签名的地址配置。

原 CLI `provision --import` 继续用于运维；新增设备后无需重新部署或重启 API。仅更新镜像不会同步工厂本机数据库，不要用本机库覆盖生产卷。

## 五、备份与恢复

数据库是命名卷 `coaster-data`，位于 `/data/coaster.sqlite`。SQLite 开了 WAL，**不要只复制主库文件**。还必须受控备份 `/data/provisioning-private.pem` 与 `PROVISION_DEPLOYMENT_ID`；数据库中的部署公钥会校验私钥是否匹配，丢失密钥后不能直接重新生成来恢复已交付设备的信任。

```sh
# 备份：VACUUM INTO 会生成一致的副本，包含尚未合并进主库的 WAL 内容
docker compose exec api node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
rmSync('/data/backup.sqlite', { force: true });
new DatabaseSync('/data/coaster.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\");
"
docker compose cp api:/data/backup.sqlite "./coaster-backup-$(date +%F).sqlite"

# 恢复：先停服务，清掉旧的 -wal/-shm，再放回副本并交还给 node 用户
docker compose stop api
docker compose run --rm api sh -c 'rm -f /data/coaster.sqlite /data/coaster.sqlite-wal /data/coaster.sqlite-shm'
docker compose cp ./coaster-backup-2026-01-01.sqlite api:/data/coaster.sqlite
docker compose run --rm --user root api chown node:node /data/coaster.sqlite
docker compose start api
```

换数据库文件等于旧账号、设备归属和密钥全部作废，恢复前先确认备份来源。

## 六、升级

```sh
cd deploy
# 1) 先备份数据库、签名私钥及部署UUID（见上）
git -C .. pull
docker compose up -d --build
docker compose ps
```

首次启动自动执行事务化版本迁移，保留原账号、凭证和已明确归属的历史。已有设备升级固件时保留分区；旧事件按兼容规则处理，无明确归属的数据不会转给新用户。迁移前必须保留备份；回退旧应用前应恢复相匹配的备份，不能假设旧版本识别新批次结构。

## 七、HTTPS 的三种接法

1. **宿主机已有 Nginx/Caddy**（默认）：容器只监听 `127.0.0.1:8080`，宿主机反代到它，`proxy_set_header Host $host;` 必须保留原始域名。
2. **用 Caddy 叠加文件**（没有宿主机反代时）：
   ```sh
   cd deploy
   vi .env                       # 设置 APP_HOST=你的域名
   docker compose -f compose.yaml -f compose.caddy.yaml up -d --build
   ```
   前置条件：域名已解析到本机，80/443 对公网开放。
3. **CDN 回源**：可用，但 Nginx 看到的对端会变成 CDN 地址，按 IP 限流会聚合成一个桶；需要按 CDN 文档配置真实来源头，并相应调整 `TRUST_PROXY`。

## 八、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 全站 `403 请从正式网站访问` | 访问用的域名与 `APP_ORIGIN` 不一致，或反代没有保留原始 `Host`；健康检查也一样要带正式域名 |
| 第 11 个注册/登录请求被 `429` | `TRUST_PROXY` 没覆盖实际反代网段，所有人的来源被算成同一个地址。用 `docker compose exec web wget -qO- http://api:3001/api/health` 之外的日志确认来源，然后把真实网段加进 `TRUST_PROXY` |
| `502` | api 容器不健康或名称解析失败：`docker compose logs api`；确认 `HOST=0.0.0.0` 未被改动 |
| 升级后网页正常但接口 502 | 用 `docker compose down && docker compose up -d`（本套件的 Nginx 已用 Docker 内置 DNS 动态解析 api，正常情况不需要） |
| 数据丢失 | 数据库卷被删：`docker compose down -v` 会删除卷，升级只用 `down` |
| 容器起不来，提示 `APP_ORIGIN` 未设置 | 没有在 `deploy/` 目录下创建 `.env`，或有开发机的 `.env` 干扰；确认 `deploy/.env` 存在且 `cd deploy` 后执行 |

## 九、本套件的验证状态

本次已验证 TypeScript/Vue 类型检查、临时 SQLite/API 与蓝牙传输替身回归、网页生产构建和后端生产 JS 编译。编译后的密钥/管理员 CLI 通过独立临时目录验证（私钥 0600、不覆盖已有文件、明确账号提升权限）；Compose 示例配置通过 `docker compose config --quiet`。

浏览器在独立临时数据库验证了管理员登录、单台登记、清单粘贴导入、HTTPS 地址校验与保存、未绑定历史页面，以及手机宽度的添加向导。未连接真实 BLE 杯垫。

**未验证**：本机 Docker daemon 未运行，无法执行镜像构建与容器启动；未部署、改动生产数据库、烧录或做真机配对。完整检查结果及硬件边界见 [验收记录](../docs/validation.md)。
