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

## 四、登记设备（出厂流程）

新设备编号使用 `coaster-000001`–`coaster-999999`。本机录入的完整步骤见 [本机出厂登记与上线](../docs/factory-provisioning.md)。**代码部署和设备登记是两件事，更新镜像不会同步本机 SQLite。**

### 本机录入后导入线上

在本机项目根目录完成逐台登记和 USB 身份写入，再导出登记清单。固件 0.5.1 支持另外发送 `{"cmd":"server","url":"https://你的域名"}` 设置正式地址，不需要在登记时指定域名：

```sh
npm run provision -- --id coaster-000001
npm run provision -- --export ./output/factory/batch-001.json --id coaster-000001
```

批量导出时省略 `--id`，工具只导出符合新编号规则的设备。相对输出路径以项目根目录为基准；已有文件不会被覆盖，下一批使用新文件名。清单只含编号、凭证哈希和创建时间，没有原始 token、用户或绑定关系，不能代替原始密钥备份。

先备份线上库并部署包含新版登记工具的镜像，然后通过 SSH/SCP 将清单传到服务器项目的 `output/factory/` 下。在服务器执行：

```sh
cd deploy
docker compose exec -T api node server/dist/provision.js --import - < ../output/factory/batch-001.json
```

`--import -` 通过标准输入读取清单，避免把受限权限文件复制进容器后的属主问题。

导入使用容器已有的 `DB_PATH=/data/coaster.sqlite`，服务不必停，导入后立即生效。相同编号、相同哈希重复导入会跳过，并保留已有归属和历史；编号或凭证冲突会整批回滚。不要用本机 SQLite 覆盖生产库，也不要在两边分别对同一编号生成不同密钥。

### 直接在线上登记

如果尚未在本机登记，也可以直接在 API 容器执行：

```sh
cd deploy
docker compose exec api node server/dist/provision.js --id coaster-000001 --url https://你的域名
```

该方式直接写入运行服务使用的数据库，不需要再导入清单。输出的 `{"cmd":"server",...}` 经 Arduino 串口（115200，新行）发给对应杯垫，收到 `ok: true` 后发送 `{"cmd":"reboot"}`。原始输出含设备密钥，应单独受控保管，不截图或外传；数据库哈希不能还原原 token。仅丢失输出不影响已经配置好的设备，正常更新也无需重写设备身份。

整机标定（`tare` / `calibrate` / `status`）仍走固件串口，不经过容器。线上导入后需真机配网，核对 `serverConnected: true`、`httpStatus: 200` 和未绑定状态再交付。

## 五、备份与恢复

数据库是命名卷 `coaster-data`，位于 `/data/coaster.sqlite`。SQLite 开了 WAL，**不要只复制主库文件**：

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
# 1) 先备份（见上）
docker compose down                    # 全量重建，避免 Nginx 缓存旧的容器地址
git -C .. pull
docker compose up -d --build
docker compose ps
```

首次启动会自动建表（`CREATE TABLE IF NOT EXISTS`），不需要单独执行迁移；但项目没有版本化迁移，若将来给**已有表**加列或改约束，需要手工迁移后再启动。

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

已在本机验证（Node 24.17，与容器同版本）：

- `npm run check`：类型检查 + 30 项测试全部通过（含新增的 `server/test/proxy.test.ts` 反代限流用例）。
- `tsc -p server/tsconfig.build.json` 能把后端编译成 JS，按镜像内目录结构直接运行通过；`docker` 镜像的 `CMD` 就是这条命令。
- 健康检查用的 `node --input-type=module` 一行命令实测返回 0；Node 的 `fetch` 不允许自定义 `Host`，所以镜像里只能用 `node:http`。
- `TRUST_PROXY` 按网段生效：同一来源第 11 次注册 429，换一个来源立刻 200。
- 服务运行中执行 `provision` 可登记设备；重启进程后会话与数据保留。

**未验证**：本机 Docker 守护进程无法启动，因此 `docker build`/`docker compose up` 没有实际执行过。首次部署时请留意构建日志；若某个 `COPY` 路径或基础镜像标签报错，按报错调整即可，业务代码无需改动。真机、烧录与生产证书验收仍需按[验收边界](../docs/validation.md)执行。
