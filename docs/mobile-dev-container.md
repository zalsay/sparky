**Mobile Dev Containers**

这套配置专门给移动端 Codex UI 联调使用，不复用现有业务容器，也不占用现有 `3001/3101/3102` 端口。

**目标**

- Web 使用独立端口 `3006`
- Server 使用独立端口 `3301`
- Executor 使用独立端口 `3302`
- 数据根使用 `/tmp/sparky-mobile-dev`
- `CODEX_HOME` 使用 `/tmp/sparky-mobile-dev/codex-config`
- 默认不连接 Postgres，直接使用内存鉴权，避免污染现有业务数据库
- `server` 和 `executor` 共用同一份隔离 `CODEX_HOME`，用于读取 Codex rollout timeline

**启动**

```bash
mkdir -p /tmp/sparky-mobile-dev/{projects,codex-config,go,go-cache,python-local,pip-cache,uv-cache}
./scripts/up-mobile-dev.sh
```

默认会把仓库内的 `./codex-config` 样例数据同步到 `/tmp/sparky-mobile-dev/codex-config`，并把 rollout 里的 `cwd` 重写为 `/projects/codex-mobile-dev`，这样移动端 Codex timeline 可以直接在隔离环境里联调。

如果你只想起容器、不灌样例数据：

```bash
MOBILE_DEV_SEED_CODEX_SAMPLE=0 ./scripts/up-mobile-dev.sh
```

**访问**

- 移动端 Web: `http://<宿主机IP>:3006`
- Server API: `http://<宿主机IP>:3301`
- Executor 调试入口: `http://<宿主机IP>:3302`

**停止**

```bash
docker compose -f docker-compose.mobile-dev.yml stop
```

**销毁**

```bash
docker compose -f docker-compose.mobile-dev.yml down
```

**可选环境变量**

- `MOBILE_DEV_WEB_PORT`
- `MOBILE_DEV_SERVER_PORT`
- `MOBILE_DEV_EXECUTOR_PORT`
- `MOBILE_DEV_HOST_DATA_ROOT`
- `MOBILE_DEV_CODEX_HOME`
- `MOBILE_DEV_DATABASE_URL`
- `MOBILE_DEV_SAMPLE_CODEX_SOURCE`
- `MOBILE_DEV_SAMPLE_PROJECT_PATH`
- `MOBILE_DEV_SEED_CODEX_SAMPLE`

如果你确实需要在 dev 容器里验证 Postgres 持久化，再显式设置 `MOBILE_DEV_DATABASE_URL`。

**注意**

- 不要用这套 compose 替换现有 `docker-compose.yml`
- 不要把 dev 容器挂到现有 nginx 或现有业务入口
- 如果要验证 Codex timeline，优先在 dev 数据根下准备独立的 `codex-config`
