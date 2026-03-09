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
