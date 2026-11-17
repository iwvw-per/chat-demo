# chat-demo

[English](README.md) | 简体中文

带内置后端的 DeepSeek 聊天应用。会话与附件保存在服务端,可多端同步;支持用户登录鉴权,上游 API 与密钥由管理员统一配置并通过后端代理,普通用户无需填写 API Key。

## 功能

- 多用户账号:注册开关、密码登录、管理员角色。
- 上游 API(地址、密钥、默认模型)在服务端配置一次,普通用户不接触密钥。
- 管理员可视化配置:上游 API、应用名称、欢迎语、顶部公告、系统提示词、新用户默认开关与注册开关;保存后通过 SSE 推送到在线客户端,无需重启或刷新。
- 会话、消息分支、附件与界面设置存入 SQLite,多端共享。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用。
- 附件上传、语音输入与回复朗读;Markdown、代码高亮、KaTeX 公式与 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、历史导入导出。

## Docker 部署

镜像由 GitHub Actions 自动构建并发布到 GitHub Container Registry:推送到 `main`、打 `v*` 标签或手动运行都会触发,同时构建 `linux/amd64` 与 `linux/arm64`。

```sh
cp .env.example .env
# 在 .env 中填写 API_KEY(可选:ADMIN_USERNAME / ADMIN_PASSWORD)
docker compose pull
docker compose up -d
```

打开 http://localhost:3000。首个注册的账号会成为管理员;如果首次启动前设置了 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`,会直接创建该管理员。

如果想用本地源码构建镜像:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

如果 GHCR 包是私有的,先执行 `docker login ghcr.io`,或在仓库的 Package 设置里把可见性改为公开。工作流位于 [.github/workflows/docker.yml](.github/workflows/docker.yml)。

数据保存在 `chat-data` 卷的 `/app/data/chat-demo.sqlite`。配置项:

| 变量                 | 默认值                     | 说明                                             |
| -------------------- | -------------------------- | ------------------------------------------------ |
| `PORT`               | `3000`                     | HTTP 端口                                        |
| `DATA_DIR`           | `./data`                   | SQLite 与数据目录                                |
| `ALLOW_REGISTRATION` | `false`                    | 首个账号之后的自行注册开关;管理员始终可以创建用户 |
| `ADMIN_USERNAME`     | 空                         | 预置管理员用户名(仅在没有用户时生效)            |
| `ADMIN_PASSWORD`     | 空                         | 预置管理员密码(至少 8 位)                       |
| `API_BASE_URL`       | `https://api.deepseek.com` | 初始上游 API 地址                                |
| `API_KEY`            | 空                         | 初始上游 API Key                                 |
| `API_MODEL`          | `deepseek-flash`           | 初始默认模型                                     |
| `API_MESSAGES_PATH`  | `/anthropic/v1/messages`   | 上游 Messages 路径(自定义网关)                  |
| `API_FILES_PATH`     | `/anthropic/v1/files`      | 上游 Files 路径                                  |
| `API_MODELS_PATH`    | `/models`                  | 上游模型列表路径                                 |
| `API_ASR_PATH`       | `/v1/tools/asr`            | 上游语音识别路径                                 |
| `API_TTS_PATH`       | `/v1/tools/tts`            | 上游语音合成路径                                 |
| `COOKIE_SECURE`      | `false`                    | 通过 HTTPS 访问时设为 `true`                     |
| `TRUST_PROXY`        | `false`                    | 信任第一层反向代理                               |
| `SESSION_DAYS`       | `30`                       | 登录有效期(天)                                  |

初始值之后可由管理员在 **设置 → 管理控制台** 中修改。

## 本地开发

准备 Node.js 24+ 和 pnpm:

```sh
pnpm install
pnpm dev:server   # API 监听 http://localhost:3001
pnpm dev          # 界面监听 http://localhost:8090,/api 代理到 3001
```

打开 http://localhost:8090 注册首个账号;也可以在启动服务前设置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`。

本地构建并运行生产服务:

```sh
pnpm build:all
pnpm start
```

服务会在 3000 端口托管 `dist/` 与 API。

## 命令

| 命令               | 用途                       |
| ------------------ | -------------------------- |
| `pnpm dev`         | 启动界面开发服务器         |
| `pnpm dev:server`  | 以监听模式启动 API         |
| `pnpm build`       | 构建前端到 `dist/`         |
| `pnpm build:server`| 编译后端到 `server/dist/`  |
| `pnpm build:all`   | 同时构建前端与后端         |
| `pnpm start`       | 运行编译后的服务           |
| `pnpm type`        | TypeScript 类型检查        |
| `pnpm lint`        | oxlint 检查                |
| `pnpm format`      | oxfmt 格式化               |

## 数据与鉴权

- 密码使用 scrypt 加盐哈希;登录态为 HttpOnly、SameSite=Lax 的 Cookie,令牌哈希后存入 SQLite。
- 管理员在 **设置 → 管理控制台** 中可视化调整上游 API、应用名称、欢迎语、顶部公告、系统提示词、新用户默认开关与注册开关。保存后写入 SQLite,并通过 `/api/config/events` 推送到在线客户端,新消息和界面文案立即使用最新配置。
- 会话、附件与用户设置按账号隔离存放在 SQLite。删除会话时,不再被其他会话引用的原件会一并清理。
- 历史导入导出仍使用 ZIP;导入会替换当前账号在服务端的会话与附件。
- 浏览器把模型、文件、ASR、TTS 请求发到 `/api/llm/*`,后端注入管理员的密钥并转发流式响应。

## 目录结构

```text
server/                Express API、SQLite 存储、鉴权与上游代理
src/
  app/                 应用布局、主题与登录页
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中文与英文文案
  services/
    api/               后端请求、SSE 与协议类型
    chat/              会话、消息分支、存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读播放
  utils/               共享工具
```

## 许可证

[MIT](LICENSE)。构建会把许可证复制到 `dist/LICENSE`;分发时请一并保留。第三方依赖遵循各自的许可证。
