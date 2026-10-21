# 开发与部署指南（社区版）

> English version: [DEPLOYMENT.en.md](./DEPLOYMENT.en.md)

## 1. 环境要求

- Python 3.11+
- Node.js 20+
- npm 10+
- Docker 24+（如使用容器部署）

## 2. 环境变量

复制并修改示例配置：

```bash
cp .env.example .env
```

关键变量说明：

- `SECRET_KEY`：必须为 16/24/32 字节长度，建议 32 字符。务必修改为你自己的高强度随机值，不可使用示例值。
- `INITIAL_ADMIN_PASSWORD`：首次建库时用于初始化 `admin` 账号密码。必须满足密码复杂度要求，且首次登录后会强制修改。
- `DATABASE_URL`：默认 `sqlite:////data/app.db`。
- `SSH_KNOWN_HOSTS`：已知主机文件路径。
- `SSH_ALLOW_UNKNOWN_HOSTS`：是否允许未知主机。
- `VITE_API_BASE`：前端开发模式下 API 地址。

安全提示：上线前请再次确认 `SECRET_KEY` 与 `INITIAL_ADMIN_PASSWORD` 均已替换，否则会导致鉴权安全风险，且服务首次启动时无法完成管理员初始化。

## 3. 本地开发部署

### 3.1 启动后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 将根目录 .env 注入当前 shell（可按需改为手动 export）
set -a
source ../.env
set +a

uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

后端默认地址：`http://127.0.0.1:8080`

### 3.2 启动前端（开发模式）

新开一个终端：

```bash
cd frontend
npm ci
VITE_API_BASE=http://127.0.0.1:8080 npm run dev -- --host 0.0.0.0 --port 5173
```

前端地址：`http://127.0.0.1:5173`

### 3.3 本地一体化静态托管（可选）

若希望由后端直接托管前端静态文件：

```bash
cd frontend
npm ci
npm run build

cd ../backend
source .venv/bin/activate
set -a
source ../.env
set +a
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

构建结果会输出到 `backend/frontend/dist`，由后端自动挂载。

## 4. Docker 镜像部署

Docker Hub 镜像：`https://hub.docker.com/r/beibeizi/websshgateway`

快速启动示例（注意：`SECRET_KEY` 与 `INITIAL_ADMIN_PASSWORD` 均为示例，自行部署必须替换）：

```bash
docker run -d -p 8080:8080 \
  -e SECRET_KEY="67e457b4eab14012b34382b3d634f297" \
  -e INITIAL_ADMIN_PASSWORD="ChangeMe123" \
  beibeizi/websshgateway:latest
```

### 4.1 单容器部署

```bash
docker build -t webssh-gateway:community .
export DOCKER_IMAGE=beibeizi/websshgateway:latest

docker run -d \
  --name webssh-gateway \
  -p 8080:8080 \
  --env-file .env \
  -v webssh-data:/data \
  ${DOCKER_IMAGE:-webssh-gateway:community}
```

访问地址：`http://127.0.0.1:8080`

### 4.2 Docker Compose 部署

```bash
docker compose up -d --build
```

停止：

```bash
docker compose down
```

## 5. 首次登录

- 默认初始化账号：`admin`
- 初始密码来自 `.env` 中的 `INITIAL_ADMIN_PASSWORD`
- 首次登录后会强制修改密码
- 若需为现有用户重置密码，请在项目后端目录执行：`cd backend && python -m app.cli reset-password --username <用户名>`

## 6. 升级与回滚建议

### 6.1 升级

```bash
git pull
docker compose build --pull
docker compose up -d
```

### 6.2 备份数据卷

```bash
docker run --rm \
  -v webssh-data:/data \
  -v "$(pwd)":/backup \
  alpine sh -c "tar -czf /backup/webssh-data-backup.tgz -C /data ."
```

## 7. 常见问题

- 无法登录：检查 `SECRET_KEY` 长度是否满足 16/24/32 字节，并确认首次部署时已设置 `INITIAL_ADMIN_PASSWORD`。
- SSH 连接失败：确认目标主机可达、账号凭据正确、主机 key 策略配置正确。
- 前端请求 401：检查 token 是否过期，或 `VITE_API_BASE` 是否指向正确后端。
- 排查服务问题：登录后可在会话管理页点击“系统设置”右侧的“日志”，或直接访问 `/logs` 查看当前后端进程最近运行日志。该日志来自进程内存缓冲区，服务重启后会重新开始记录，不等同于宿主机或 Docker 的完整历史日志。


### 构建时拉不到基础镜像（registry-1.docker.io 超时 / no route to host）

国内服务器经常无法直连 Docker Hub，报错形如：

```text
failed to resolve source metadata for docker.io/library/node:20-slim:
dial tcp 108.160.169.54:443: connect: no route to host
```

这不是仓库代码问题，而是构建机连不上 `registry-1.docker.io`（域名还可能被解析到污染地址）。三种处理方式：

1. 给 Docker 配置镜像加速（推荐，全局生效）：

   ```bash
   sudo mkdir -p /etc/docker
   sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
   {
     "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run"]
   }
   JSON
   sudo systemctl daemon-reload && sudo systemctl restart docker
   ```

   镜像站地址会失效，用前先测：`curl -sS -o /dev/null -w '%{http_code}\n' https://docker.m.daocloud.io/v2/`，返回 200 或 401 才算可用。

2. 只替换本次构建的基础镜像（不改 Dockerfile）：

   ```bash
   docker build \
     --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:20-slim \
     --build-arg PYTHON_IMAGE=docker.m.daocloud.io/library/python:3.11-slim \
     -t webssh-gateway:community .
   ```

3. 构建机完全无外网时：在能联网的机器上 `docker pull` 两个基础镜像，`docker save` 后拷到服务器 `docker load`，再执行构建。
