# 饮水陪伴杯垫：容器镜像
#
# 本文件产出两个镜像，用法与说明见 deploy/README.md：
#   --target api   Node 24 后端。构建阶段把 TypeScript 编译成 JS，运行阶段不需要 tsx。
#   --target web   Nginx 托管 web/dist，并把 /api/ 原路径转发给 api 容器。

# ---------- 依赖：构建前端与编译后端都需要 devDependencies（vite、vue-tsc、typescript） ----------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

# ---------- 构建：前端静态产物 + 后端 JS ----------
FROM deps AS build
COPY server server
COPY web web
RUN npm run build:web \
 && npx tsc --project server/tsconfig.build.json

# ---------- 生产依赖 ----------
FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
# serialport 目前列在 server 的 dependencies 中（实际只被测试引用）。保留编译工具，
# 让没有预编译包的平台也能安装；把它移到 devDependencies 后可以删掉这一层。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev

# ---------- 后端运行镜像 ----------
FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
# server/package.json 必须保留：后端产物是 ESM，Node 靠它的 "type": "module" 判定模块类型。
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
# SQLite 数据目录。命名卷首次创建时会继承这里的属主，node 用户才能写入。
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3001
# 健康检查必须带正式域名：应用按 Host 校验来源，而 Node 的 fetch 不允许自定义 Host，
# 因此这里用 node:http。返回值 200 才算健康。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "import http from 'node:http';const host=new URL(process.env.APP_ORIGIN).host;const req=http.get({host:'127.0.0.1',port:Number(process.env.PORT||3001),path:'/api/health',headers:{host}},(res)=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1);});"]
CMD ["node", "server/dist/index.js"]

# ---------- 网页镜像 ----------
FROM nginx:stable-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
