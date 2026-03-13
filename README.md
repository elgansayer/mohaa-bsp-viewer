# MOHAA BSP Viewer

A web-based viewer for Medal of Honor: Allied Assault (MOHAA) assets.

## Features
- BSP map parsing
- Shader support
- Static model loading
- Terrain rendering
- Tiki parser
- Virtual File System for game assets

## Development

### Setup

The viewer needs access to your MOHAA game files. By default it looks for them at `/home/elgan/mohaa-web-base`. You can change this in one of two ways:

**Option 1 — Environment variable (recommended):**
```bash
MOHAA_BASE_PATH=/path/to/your/mohaa npm run dev
```

**Option 2 — Edit the config directly:**

Open `vite.config.ts` and change the fallback path:
```ts
allow: ['..', process.env.MOHAA_BASE_PATH || '/your/path/here']
```

### Running

```bash
npm install
npm run dev
```

## Docker

Build locally:

```bash
docker build -t mohaa-viewer:local .
```

Run locally with runtime env vars:

```bash
docker run --rm -it \
	-p 5173:5173 \
	-e PORT=5173 \
	-e MOHAA_BASE_PATH=/data/mohaa \
	-v /path/to/your/mohaa-files:/data/mohaa:ro \
	mohaa-viewer:local
```

Notes:
- `PORT` controls the Vite server port inside the container.
- `MOHAA_BASE_PATH` must match the in-container path where your MOHAA files are mounted.

## GitHub Action (Docker Image)

Workflow file: `.github/workflows/docker-image.yml`

- On pull requests: builds the image (no push).
- On `main`/`master`: builds and pushes to GHCR (`ghcr.io/<owner>/<repo>`), including `latest` on the default branch.
- On tag pushes like `v1.2.3`: builds and pushes semver tags (`1.2.3`, `1.2`).

This image can be pulled directly from GHCR in Portainer once the package is published and accessible.

## Portainer Stack (Pull Prebuilt GHCR Image)

Use `docker-compose.ghcr.yml` when you want Portainer to pull an already-built image from GHCR.

Required environment variables:
- `IMAGE_NAME` (example: `ghcr.io/owner/repo`)
- `IMAGE_TAG` (example: `latest` or `sha-abc1234` or `1.2.3`)
- `PORT` (example: `5173`)
- `MOHAA_BASE_PATH` (example: `/data/mohaa`)
- `MOHAA_HOST_PATH` (absolute host path to MOHAA files)

Example values:

```env
IMAGE_NAME=ghcr.io/owner/repo
IMAGE_TAG=latest
PORT=5173
MOHAA_BASE_PATH=/data/mohaa
MOHAA_HOST_PATH=/absolute/path/to/your/mohaa-files
```

In Portainer:
1. Create a new Stack.
2. Paste `docker-compose.ghcr.yml` content.
3. Add the environment values above.
4. Deploy the stack.

If your GHCR package is private, configure registry credentials in Portainer first.

## Portainer Stack (Build Image Locally)

Use `docker-compose.yml` in this repo for a Portainer stack that builds the image directly from source.

Required environment variables:
- `PORT` (example: `5173`)
- `MOHAA_BASE_PATH` (example: `/data/mohaa`)
- `MOHAA_HOST_PATH` (absolute host path to MOHAA files)

Example values:

```env
PORT=5173
MOHAA_BASE_PATH=/data/mohaa
MOHAA_HOST_PATH=/absolute/path/to/your/mohaa-files
```

In Portainer:
1. Create a new Stack.
2. Paste `docker-compose.yml` content.
3. Add the three env vars above in the stack environment section.
4. Deploy the stack.

The app will be available on `http://<host>:<PORT>`.
