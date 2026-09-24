# TAS — Repository Knowledge

## Project Overview
TAS (Telegram as Storage) is an experimental Node.js CLI that uses Telegram Bot API as an encrypted file transport. It is not unlimited storage or a durability service. Files are compressed, encrypted (AES-256-GCM), chunked, and uploaded to private bot chats.

## Architecture
- `src/cli.js` — Commander-based CLI entry point (all commands)
- `src/index.js` — Core upload/download pipeline (streaming)
- `src/telegram/client.js` — Telegram Bot API wrapper with retry + rate limiting
- `src/telegram/pool.js` — Stable multi-bot routing and per-bot ownership
- `src/manifest.js` — Encrypted remote index backup/rebuild
- `src/crypto/encryption.js` — AES-256-GCM encryption with PBKDF2-SHA512 key derivation
- `src/db/index.js` — SQLite (better-sqlite3) index for files, chunks, tags, sync, shares
- `src/utils/` — Compression (gzip), 19MiB chunking, logical paths, progress bars, throttling, branding
- `src/utils/download-stream.js` — Shared Telegram→Decrypt→Decompress pipeline (used by index.js, server.js, mount.js)
- `src/share/server.js` — HTTP server for temporary file sharing (binds 127.0.0.1 by default)
- `src/sync/sync.js` — Folder sync engine with fs.watch
- `src/fuse/mount.js` — FUSE filesystem mount (fuse-native)

## Key Technical Details
- Data directory: `~/.tas` (or `TAS_DATA_DIR` env var)
- Config version 3: bot pool with individually encrypted tokens, chmod 600
- Config versions 1/2 remain backward compatible
- Config version 1 (legacy): plaintext bot token — backward compatible
- PBKDF2 iterations: 600,000 (OWASP 2025 recommendation)
- Chunk payload size: 19MiB (keeps hosted Bot API documents under its 20MB getFile limit)
- File header: 64-byte "WAS1" routing header; new uploads omit filename/original size
- Password hash comparison uses `crypto.timingSafeEqual()` (both PBKDF2 and legacy paths)

## Testing
- `npm test` runs all tests via `node --test tests/*.test.js`
- 101 tests cover encryption, WAS1 headers, compression, modern macFUSE detection, nested FUSE paths (including 60k entries), schema migrations, multi-bot routing, resumable state, rate queues, manifests, uploads, tags, sync DB, and share DB
- Telegram network tests use local fakes; the suite never requires a live bot token

## Common Pitfalls
- `findByName`/`findByHash` use LIKE queries — wildcards must be escaped
- `cleanExpiredShares` compares ISO date strings directly (not SQL date functions)
- Share server HTML must escape filenames to prevent XSS
- Content-Disposition headers need RFC 6266 encoding for Unicode filenames
- FUSE `fileCache` is module-level with LRU eviction at 100 entries
- macOS mount uses current macFUSE only after `src/fuse/macfuse.cjs` rebuilds the addon against the system library; `tas doctor` must pass a real smoke mount before use
- Disabled bots must remain configured while chunks or the remote manifest depend on them
- Version in `src/utils/branding.js` must match `package.json` version
- `Chunker` class in `chunker.js` is dead code — superseded by streaming chunker in `index.js`
- `formatBytes` still has 3 implementations: `cli.js`, `branding.js` (as `formatSize`), `progress.js`
