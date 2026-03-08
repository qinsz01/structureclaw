# StructureClaw

> 开源建筑结构分析与设计平台原型，包含 Web 前端、Node.js API 和 Python 分析引擎。

## 当前状态

这个仓库目前已经整理成可运行的多服务原型，包含：

- `frontend`: Next.js 14 前端
- `backend`: Fastify + Prisma + Redis/Postgres 接入的 API 服务
- `core`: FastAPI 结构分析引擎
- `docker-compose.yml`: 编排数据库、缓存、前后端和 Nginx

目前更接近“可运行的项目骨架”而不是完整产品，部分接口是可用的最小实现，用于保证工程链路能跑通。

## 技术架构

```text
Browser
  -> Next.js frontend (:3000)
  -> Agent Orchestration (/api/v1/agent/run)
  -> Fastify backend (:8000)
  -> FastAPI analysis engine (:8001)
  -> PostgreSQL / Redis
  -> Nginx reverse proxy (Docker only)
```

## 目录结构

```text
structureclaw/
├── backend/                 # Fastify API + Prisma
├── core/                    # FastAPI 分析引擎
├── frontend/                # Next.js 前端
├── docker/                  # Nginx 配置
├── docs/                    # 预留文档目录
├── plugins/                 # 预留插件目录
├── services/                # 预留微服务目录
├── tests/                   # 预留测试目录
├── .env.example             # Docker Compose 用环境变量示例
├── Makefile                 # 常用开发命令
└── docker-compose.yml
```

## 环境要求

推荐直接使用 Docker（门槛最低）：

- Docker Engine / Docker Desktop
- Docker Compose v2

本地源码开发（非 Docker）时需要：

- Node.js >= 18
- `uv`（推荐，用于自动创建 Python 3.11 环境）
- Python >= 3.10（未使用 `uv` 时）
- PostgreSQL >= 14（必须）
- Redis >= 7（可选，不启用时自动降级内存缓存）

## 快速开始

### 30 秒上手（默认推荐）

第一次进入仓库，只需要这 3 条命令：

```bash
make doctor
make start
make status
```

补充：

- `make doctor`: 启动前自检（不拉起完整服务）
- `make start`: 新手默认启动（lite 分析依赖 + uv 管理 Python 3.11）
- `make status`: 查看进程和健康状态
- `make stop`: 停止本地服务和基础设施
- `make logs`: 查看日志（默认 frontend/backend/core）

### 命令入口（独立 CLI）

仓库根目录内可直接使用：

```bash
./sclaw help
./sclaw doctor
./sclaw start
./sclaw status
./sclaw logs all --follow
./sclaw stop
```

安装为全局命令（更像 openclaw）：

```bash
make sclaw-install
sclaw version
sclaw start
```

也支持 npm 全局安装（安装后可直接用 `sclaw`）：

```bash
npm install -g .
sclaw version
sclaw start
```

### 进阶场景

1. 完整分析依赖（非 lite）：

```bash
make start-full
```

2. 继续使用兼容保留的旧命令：

```bash
make local-up-uv
make local-up-full-uv
make local-down
make local-status
```

3. Docker 全容器栈：

```bash
cp .env.example .env
make up
```

4. 手动分步启动（调试某个服务）：

```bash
make install
make db-init
make setup-core-lite-uv
make dev-backend
make dev-frontend
make dev-core-lite
```

## 最常用命令

```bash
make doctor
make start
make status
make stop
make logs
```

启动后访问：

- Web: `http://localhost:3000`
- API: `http://localhost:8000`
- API Docs: `http://localhost:8000/docs`
- Analysis Engine: `http://localhost:8001`

## 开发文档

- 开发路线与已完成功能清单：`docs/development-roadmap.md`
- Agent 流式执行协议：`docs/agent-stream-protocol.md`

## 环境变量

### 根目录 `.env`

用于 `docker compose`：

```bash
OPENAI_API_KEY=
```

### `backend/.env`

复制自 `backend/.env.example`，主要字段：

- `DATABASE_URL`
- `REDIS_URL`
- `JWT_SECRET`
- `ANALYSIS_ENGINE_URL`
- `OPENAI_API_KEY`

说明：

- `OPENAI_API_KEY` 是可选的，未配置时聊天接口自动降级提示
- `REDIS_URL=disabled` 表示禁用 Redis，后端自动降级为内存缓存

### Prisma 初始化

后端现在已经包含：

- `backend/prisma/migrations/20260308000100_init/migration.sql`
- `backend/prisma/seed.ts`

常用命令：

```bash
npm run db:validate --prefix backend
npm run db:deploy --prefix backend
npm run db:seed --prefix backend
npm run db:init --prefix backend
```

### `frontend/.env.local`

可参考 `frontend/.env.example`：

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## 已验证的运行状态

2026-03-08 在当前环境已验证：

- 后端可成功编译
- 后端 lint 可运行
- 后端测试命令可运行（当前无测试用例）
- Prisma schema 校验通过
- 前端类型检查通过
- 前端 lint 通过
- `uv 0.10.8` 可创建 Python 3.11 环境
- `core` 可在 lite 依赖下导入并执行简化静力分析
- `make doctor`（等价于 `make check-startup`）可通过

说明：

- 在当前机器上 Docker daemon 无访问权限，因此未能在本机完成 `make local-up` 的全链路实启；如你的环境 Docker 可用，该流程应可直接跑通。
- 前端 `next build` 在当前文件系统上触发 `EXDEV`（跨设备 rename）错误；这通常与宿主文件系统挂载方式有关，不影响 `next dev` 本地开发启动。
- 当前沙箱不允许本地监听端口，因此这里未直接完成 `uvicorn` 端口绑定验证；已通过导入和分析调用确认 `core` 进程本身可启动。

## 当前已实现的主要接口

### Backend

- `GET /health`
- `GET /docs`
- `GET /api/v1`
- `POST /api/v1/agent/run`
- `GET /api/v1/agent/tools`
- `POST /api/v1/chat/execute`
- `POST /api/v1/chat/stream` (`mode=chat|execute|auto`)
- `GET /api/v1/users/*`
- `GET /api/v1/projects/*`
- `GET /api/v1/skills/*`
- `GET /api/v1/community/*`
- `GET /api/v1/analysis/*`

### Core

- `GET /`
- `GET /health`
- `GET /schema/converters`
- `POST /analyze`
- `POST /code-check`
- `POST /design/beam`
- `POST /design/column`

## 已知说明

- 当前部分后端业务实现属于“最小可运行版本”，用于确保启动链路、数据流和接口结构可用
- 如果未配置 Redis，后端会使用内存缓存降级模式
- `core/requirements.txt` 包含较重的工程分析依赖，首次安装可能较慢
- `core/requirements-lite.txt` 适合本地快速起服务，但不代表具备完整分析能力
- 对新手来说，最省事的路径是先 `make doctor`，再 `make start`

## 后续建议

适合下一步继续完善的方向：

1. 为后端补充 Prisma migration 和初始化 seed
2. 为主要 API 增加自动化测试
3. 给前端补更多真实页面，而不仅是首页
4. 把当前最小实现逐步替换成真实业务逻辑

## 许可证

本项目采用 MIT 许可证，详见 `LICENSE`。
