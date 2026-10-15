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
- 服务器时钟同步（`timedatectl set-ntp true`）：事件时间和 90 秒在线判定都依赖它。

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

## 四、自动注册与管理员设置

0.7.0 杯垫在普通用户首次 BLE 配网时自动注册并绑定，设备编号与凭证由服务端生成。新部署不需要初始化签名密钥、逐台登记或通过 USB 写信任配置。设备服务 origin 默认取 `APP_ORIGIN`，生产必须使用有效 HTTPS 证书。

只有需要维护配网地址或查看设备列表时，才把明确的已注册账号设为管理员；不会根据注册顺序自动授权：

```sh
cd deploy
docker compose exec api node server/dist/admin.js --username 已注册账号
```

重新读取会话后显示管理入口，管理员无需先绑定杯垫。已保存的服务地址优先于环境默认值，不带 `/api` 路径。已登记设备的 BLE v2 重配保留原 origin，服务器迁移需保留账号、设备和绑定数据库，并按受控运维流程更新设备地址。

### 旧固件兼容（可选）

仍有已部署的 0.6.x 签名设备时，保留原有签名配置。旧版签名工具继续保留供兼容运维：

```sh
docker compose exec api node server/dist/provisioning-key.js --out /data/provisioning-private.pem
```

工具只公开输出 `deploymentId` / `publicKey`，私钥以受限权限保存且不覆盖已有文件。将容器内路径及部署 UUID 写入 `deploy/.env` 后更新 api 容器环境：

```dotenv
PROVISION_SIGNING_KEY_FILE=/data/provisioning-private.pem
PROVISION_DEPLOYMENT_ID=工具输出的UUID
```

0.7.2 已移除手工登记与清单导入；新设备统一升级后自动注册，已登记旧设备仍可使用原签名流程。签名配置缺失只阻止 v1 授权，不影响 v2 自动注册；固定部署或公钥不匹配仍拒绝启动。详情见 [出厂与兼容运维](../docs/factory-provisioning.md)。

## 五、备份与恢复

数据库是命名卷 `coaster-data`，位于 `/data/coaster.sqlite`。SQLite 开了 WAL，**不要只复制主库文件**。若启用了旧版签名，还须受控备份 `/data/provisioning-private.pem` 与 `PROVISION_DEPLOYMENT_ID`；数据库中的部署公钥会校验私钥是否匹配，丢失密钥后不能直接重新生成来恢复已交付设备的信任。

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
# 1) 先备份数据库；兼容旧版时也备份签名私钥和部署UUID（见上）
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

0.7.0 自动注册改动已进行 TypeScript/Vue 类型检查、临时数据库/API 测试、网页蓝牙传输替身测试及固件主机测试和目标语法检查。本轮未执行网页/固件完整构建、镜像构建、容器启动、部署或真机配对。

旧版部署、网页构建与浏览器验证记录保留在 [验收记录](../docs/validation.md)，不能代替本次改动的容器和硬件验收。
