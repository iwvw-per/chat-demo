# chat-demo

English | [简体中文](README.zh-CN.md)

A DeepSeek chat application with a built-in backend. The server stores conversations and attachments, syncs them across devices, authenticates users, and proxies all model and speech requests with an administrator-managed API key.

## Features

- Multi-user accounts with registration switch, password login, and administrator role.
- Upstream API (base URL, key, default model) configured once on the server; regular users never handle the key.
- Admin console for upstream API, application name, welcome text, announcement, system prompt, default toggles, and registration switch; changes are pushed to online clients over SSE without restarting or reloading.
- Conversations, message branches, attachments, and UI settings stored in SQLite and shared across devices.
- Streaming replies, deep thinking, smart search, link reading, and source citations.
- Attachments, voice input, and read-aloud; Markdown, syntax highlighting, KaTeX, and Mermaid.
- Simplified Chinese and English, light and dark themes, mobile layouts, history import and export.

## Docker deployment

Images are built automatically by GitHub Actions and published to GitHub Container Registry for pushes to `main`, version tags (`v*`), and manual runs. Both `linux/amd64` and `linux/arm64` are built.

```sh
cp .env.example .env
# Set API_KEY (and optionally ADMIN_USERNAME / ADMIN_PASSWORD) in .env
docker compose pull
docker compose up -d
```

Open http://localhost:3000. The first registered account becomes the administrator. If `ADMIN_USERNAME` and `ADMIN_PASSWORD` are set before the first start, that administrator is created automatically.

To build the image from local source instead:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

If the GHCR package is private, run `docker login ghcr.io` first or change the package visibility to public in the repository package settings. The workflow lives in [.github/workflows/docker.yml](.github/workflows/docker.yml).

Data is kept in the `chat-data` Docker volume (`/app/data/chat-demo.sqlite`). Configuration:

| Variable             | Default                    | Description                                              |
| -------------------- | -------------------------- | -------------------------------------------------------- |
| `PORT`               | `3000`                     | HTTP port                                                |
| `DATA_DIR`           | `./data`                   | SQLite and data directory                                |
| `ALLOW_REGISTRATION` | `false`                    | Allow self-registration after the first account; administrators can always add users |
| `ADMIN_USERNAME`     | empty                      | Seed administrator username (only when no user exists)   |
| `ADMIN_PASSWORD`     | empty                      | Seed administrator password (at least 8 characters)      |
| `API_BASE_URL`       | `https://api.deepseek.com` | Seeded upstream API base URL                             |
| `API_KEY`            | empty                      | Seeded upstream API key                                  |
| `API_MODEL`          | `deepseek-flash`           | Seeded default model                                     |
| `COOKIE_SECURE`      | `false`                    | Set to `true` when served over HTTPS                     |
| `TRUST_PROXY`        | `false`                    | Trust the first reverse proxy hop                        |
| `SESSION_DAYS`       | `30`                       | Login session lifetime in days                           |

Seeded values can be changed later in **Settings → Admin console** by an administrator.

## Local development

Install Node.js 24+ and pnpm, then:

```sh
pnpm install
pnpm dev:server   # API on http://localhost:3000
pnpm dev          # UI on http://localhost:8090, /api proxied to 3000
```

Open http://localhost:8090 and register the first account, or set `ADMIN_USERNAME` / `ADMIN_PASSWORD` before starting the server.

To build and run the production server locally:

```sh
pnpm build:all
pnpm start
```

The server serves `dist/` and the API on port 3000.

## Commands

| Command            | Description                       |
| ------------------ | --------------------------------- |
| `pnpm dev`         | Start the UI development server   |
| `pnpm dev:server`  | Start the API with watch mode     |
| `pnpm build`       | Build the frontend into `dist/`   |
| `pnpm build:server`| Compile the API into `server/dist`|
| `pnpm build:all`   | Build frontend and backend        |
| `pnpm start`       | Run the compiled server           |
| `pnpm type`        | TypeScript checks                 |
| `pnpm lint`        | Lint with oxlint                  |
| `pnpm format`      | Format with oxfmt                 |

## Data and authentication

- Passwords are hashed with scrypt. Login sessions use an HttpOnly, SameSite=Lax cookie; the token is stored hashed in SQLite.
- Administrators configure the server in **Settings → Admin console**. Upstream API, branding, welcome text, announcement, system prompt, new-user defaults, and the registration switch are saved to SQLite and pushed to connected clients through `/api/config/events`, so new messages and UI text use the latest values immediately.
- Conversations, attachments, and user settings are stored per user in SQLite. Deleting a conversation removes its stored files when no other conversation references them.
- History import and export use ZIP archives as before; importing replaces the server-side conversations and attachments of the current user.
- The browser sends all model, file, ASR, and TTS requests to `/api/llm/*`. The server injects the administrator's upstream key and streams responses back.

## Project layout

```text
server/                Express API, SQLite storage, auth, upstream proxy
src/
  app/                 Application layout, themes, login page
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               Backend client, SSE, and protocol types
    chat/              Conversations, branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
