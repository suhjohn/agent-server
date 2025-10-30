# Agent Server – Deployable Claude Code/Codex Container

[![Docker Publish](https://img.shields.io/github/actions/workflow/status/suhjohn/agent-server/docker-publish.yml?branch=main)](./.github/workflows/docker-publish.yml)
[![GHCR Image](https://img.shields.io/badge/ghcr.io-agent--server-blue?logo=docker)](https://ghcr.io)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org)

Agent Server is a production-ready service that exposes Claude Code and Codex-style coding agents over simple HTTP and WebSocket interfaces, packaged for easy deployment as a single Docker container. It includes durable session storage, a streaming generation API, a secure terminal WebSocket, and utility endpoints for environment, filesystem, and Git.

---

## Table of Contents

1. What is Agent Server?
   - Key benefits
   - Features
2. Getting Started
   - Requirements
   - Quick Start with Docker (GHCR or local build)
   - Local development
3. Configuration
4. API Overview
   - Health
   - Sessions
   - Generate (Claude Code / Codex)
   - Stop generation
   - Environment
   - Git
   - Terminal WebSocket
5. Persistence and Data Stores
6. Build from source
7. Testing
8. Deployment (GHCR)
9. Contributing
10. License

---

## What is Agent Server?

Agent Server is a lightweight orchestration layer that turns stateful coding agents into an easy-to-deploy service. It’s designed to run anywhere you can run Docker, with sensible defaults for security and durability.

### Key benefits

- Resilient streaming with graceful shutdown and backpressure handling
- Durable, resumable sessions with background execution
- Secure by default with API key auth and tokenized terminal access
- One-container deployment that also boots a local Redis and Python LLM helper
- Observability via clear logs and a simple health endpoint

### Features

- HTTP endpoints to create/list sessions and stream generations
- Supports `agent: "claude-code" | "codex"` with image input support
- Built‑in terminal WebSocket (`/ws/terminal`) protected by short‑lived JWTs
- Git utilities: repository discovery and structured diffs
- Filesystem upload and directory listing helpers
- SQLite storage by default; Redis used for lightweight coordination/locks

---

## Getting Started

### Requirements

- Docker Desktop (or any compatible runtime)
- For local dev: Node.js >= 22, pnpm >= 8
- Optional: Python 3.11+ (container uses `uv` to run the bundled `llm-server`)

### Quick Start with Docker

Pull from GHCR (replace `OWNER/REPO` if you fork):

```bash
docker pull ghcr.io/suhjohn/agent-server:latest

docker run --rm \
  -p 3000:3000 -p 22:22 \
  -e API_KEY=your-api-key \
  -e ANTHROPIC_API_KEY=your-optional-claude-key \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  ghcr.io/suhjohn/agent-server:latest
```

Or build locally:

```bash
docker build -t agent-server .
docker run --rm -p 3000:3000 -p 22:22 -e API_KEY=your-api-key agent-server
```

Server starts on port `3000` and exposes:

- HTTP API on `:3000` (see endpoints below)
- Terminal WebSocket on `ws://host:3000/ws/terminal`
- Optional SSH service on `:22` (controlled via environment in `entrypoint.sh`)

### Local development

```bash
pnpm install
cp env.example .env
pnpm dev
```

Build and run:

```bash
pnpm build && pnpm start
```

---

## Configuration

Agent Server reads environment variables via `dotenv`. See `env.example` for the full set. Common variables:

```env
# Server
PORT=3000
NODE_ENV=development
API_KEY=your-api-key-here                # Required for protected endpoints
ALLOWED_ORIGINS=http://localhost:3000

# Claude (optional)
ANTHROPIC_API_KEY=your-anthropic-api-key-here
USE_CLAUDE_CREDENTIALS=false

# Redis (internal by default)
REDIS_URL=redis://127.0.0.1:6379

# SQLite path (defaults to /home/appuser/data/agent_ts.db)
DATABASE_PATH=/home/appuser/data/agent_ts.db
```

Notes:

- API authentication uses `Authorization: Bearer <API_KEY>`.
- A local Redis is started by the container’s `entrypoint.sh` unless `REDIS_URL` points elsewhere.
- Data persists to an on-disk SQLite database; you can mount `/home/appuser` as a volume to retain state.

---

## API Overview

All protected endpoints require `Authorization: Bearer <API_KEY>`.

### Health

```bash
curl http://localhost:3000/health
```

Response includes server version and a database connectivity flag.

### Sessions

- `GET /sessions` – list sessions and metadata
- `POST /sessions` – create a session

Example:

```bash
curl -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "my-session-1",
    "agent": "claude-code",
    "cwd": "/home/appuser/workspaces",
    "model": "claude-code"
  }'
```

### Generate (streaming)

Endpoint: `POST /generate/v2` (SSE stream). Agent can be `"claude-code"` or `"codex"`.

```bash
curl -N http://localhost:3000/generate/v2 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "my-session-1",
    "agent": "claude-code",
    "prompt": "Add a REST endpoint that returns the current time",
    "cwd": "/home/appuser/workspaces/project",
    "model": "claude-code"
  }'
```

Background mode (returns a task id):

```bash
curl -X POST http://localhost:3000/generate/v2 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "my-session-1",
    "agent": "codex",
    "prompt": "Create unit tests for utils/date.ts",
    "background": true
  }'

curl http://localhost:3000/generate/v2/jobs/<taskId> \
  -H "Authorization: Bearer $API_KEY"

curl -N http://localhost:3000/generate/v2/jobs/<taskId>/stream \
  -H "Authorization: Bearer $API_KEY"
```

### Stop generation

```bash
curl -X DELETE http://localhost:3000/generate/<sessionId>/stop \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "<sessionId>"}'
```

### Environment

Check if environment variables exist (supports comma-separated names):

```bash
curl http://localhost:3000/env/OPENAI_API_KEY,ANTHROPIC_API_KEY \
  -H "Authorization: Bearer $API_KEY"
```

### Git

- `GET /git/repositories` – discover repos under the workspace (incl. worktrees)
- `GET /git/diff?path=/path/to/repo&base=main&head=HEAD&staged=true&context=3`

```bash
curl "http://localhost:3000/git/diff?path=/home/appuser/workspaces/proj&staged=false" \
  -H "Authorization: Bearer $API_KEY"
```

### Terminal WebSocket

1. Request a short‑lived token:

```bash
curl -X POST http://localhost:3000/terminal/token \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"deploymentId":"local-dev","terminalId":"term-1"}'
```

2. Connect using the token:

```bash
# Example with websocat
websocat "ws://localhost:3000/ws/terminal?token=<JWT>"
```

Messages are JSON with `{ type: "data" | "resize" | "close" | "error" | "info" }`.

---

## Persistence and Data Stores

- SQLite via `better-sqlite3` at `DATABASE_PATH` (default `/home/appuser/data/agent_ts.db`). WAL mode is enabled for concurrency.
- Redis for lightweight locks and coordination. The container starts a local Redis unless `REDIS_URL` is set.

---

## Build from source

```bash
pnpm install
pnpm build
pnpm start
```

Database tooling:

```bash
pnpm db:generate   # generate Drizzle migrations
pnpm db:migrate    # apply migrations
pnpm db:migrate:custom # run custom migration runner
```

---

## Testing

Integration tests use Vitest and Testcontainers:

```bash
pnpm test:integration
```

---

## Deployment (GHCR)

This repo publishes a container image to GitHub Container Registry via GitHub Actions. The workflow is defined in `.github/workflows/docker-publish.yml` and pushes tags for `latest`, semver tags, and the commit SHA.

To pull the latest image:

```bash
docker pull ghcr.io/suhjohn/agent-server:latest
```

---

## Contributing

Issues and PRs are welcome. Please run `pnpm lint` and `pnpm type-check` before submitting changes.

---

## License

This repository does not currently include a license file. Until a license is added, all rights are reserved.

---
