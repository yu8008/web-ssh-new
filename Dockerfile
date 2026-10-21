# 基础镜像地址可通过 --build-arg 覆盖，便于使用内网镜像站
ARG NODE_IMAGE=node:20-slim
ARG PYTHON_IMAGE=python:3.11-slim

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --legacy-peer-deps && chmod -R +x node_modules/.bin/
COPY frontend ./
RUN mkdir -p /backend/frontend
RUN node node_modules/vite/bin/vite.js build

FROM ${PYTHON_IMAGE}
RUN useradd -m appuser
WORKDIR /app

COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY backend /app/backend
COPY session-transfer-files /app/session-transfer-files
COPY --from=frontend-build /backend/frontend/dist /app/backend/frontend/dist

WORKDIR /app/backend
RUN mkdir -p /data && chown -R appuser:appuser /data
USER appuser

EXPOSE 8080

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
