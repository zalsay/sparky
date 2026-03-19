# WebIDE 远程 API 测试记录（2026-03-19）

测试目标：`docs/API.md` 中的线上地址 `https://i.meetlife.com.cn:3010`

认证方式：调用 `POST /api/auth/register` 注册临时账号，再用返回的 Bearer token 测试相关接口。

本轮用于测试的临时 project：
- `id`: `2`
- `name`: `ClaudeWebIDE-56e459`
- `path`: `/tmp/claude-webide-a39bbc6d`

## 已确认问题

### 1. `GET /api/web-ide/events` 在线上返回 404
- 文档位置：`docs/API.md:578-584`
- 实测结果：
  ```http
  GET /api/web-ide/events
  Authorization: Bearer <token>
  -> HTTP/1.1 404 Not Found
  ```
- 结论：文档声明了该接口，但当前线上服务没有可用的该路由，或对应功能未部署。

### 2. `GET /api/projects/:id/web-ide/status` 在线上返回 404
- 文档位置：`docs/API.md:588-597`
- 使用已创建 project `id=2` 实测：
  ```http
  GET /api/projects/2/web-ide/status
  Authorization: Bearer <token>
  -> HTTP/1.1 404 Not Found
  ```
- 结论：文档声明了该接口，但当前线上服务没有可用的该路由，或对应功能未部署。

### 3. `POST /api/projects/:id/web-ide/start` 在线上返回 404
- 文档位置：`docs/API.md:601-609`
- 使用已创建 project `id=2` 实测：
  ```http
  POST /api/projects/2/web-ide/start
  Authorization: Bearer <token>
  -> HTTP/1.1 404 Not Found
  ```
- 结论：文档声明了该接口，但当前线上服务没有可用的该路由，或对应功能未部署。

### 4. `GET /api/projects/:id/detail` 在线上返回 404
- 文档位置：`docs/API.md:230-249`
- 使用刚创建成功的 project `id=2` 实测：
  ```http
  GET /api/projects/2/detail
  Authorization: Bearer <token>
  -> HTTP/1.1 404 Not Found
  ```
- 结论：创建 project 成功且 `GET /api/projects` 可见，但 detail 接口当前不可用，和文档不一致。

