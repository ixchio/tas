# TAS — Repository Knowledge

## Project Overview
TAS (Telegram as Storage) is a Node.js CLI tool that uses Telegram Bot API as free encrypted cloud storage. Files are compressed, encrypted (AES-256-GCM), chunked, and uploaded to a private Telegram bot chat.

## Architecture
- `src/cli.js` — Commander-based CLI entry point (all commands)
- `src/index.js` — Core upload/download pipeline (streaming)
- `src/telegram/client.js` — Telegram Bot API wrapper with retry + rate limiting
- `src/crypto/encryption.js` — AES-256-GCM encryption with PBKDF2-SHA512 key derivation
- `src/db/index.js` — SQLite (better-sqlite3) index for files, chunks, tags, sync, shares
- `src/utils/` — Compression (gzip), chunking (49MB), progress bars, throttling, branding
- `src/share/server.js` — HTTP server for temporary file sharing with download pages
- `src/sync/sync.js` — Folder sync engine with fs.watch
- `src/fuse/mount.js` — FUSE filesystem mount (fuse-native)

## Key Technical Details
- Data directory: `~/.tas` (or `TAS_DATA_DIR` env var)
- Config version 2: bot token encrypted with user's password in config.json
- Config version 1 (legacy): plaintext bot token — backward compatible
- PBKDF2 iterations: 600,000 (OWASP 2025 recommendation)
- Chunk size: 49MB (Telegram Bot API limit is 50MB)
- File header: 64 bytes "WAS1" format with filename, size, chunk info

## Testing
- `npm test` runs all tests via `node --test tests/*.test.js`
- Tests cover: encryption, compression, tags, sync DB, share DB
- No mocking of Telegram API — tests focus on pure logic

## Common Pitfalls
- `findByName`/`findByHash` use LIKE queries — wildcards must be escaped
- `cleanExpiredShares` compares ISO date strings directly (not SQL date functions)
- Share server HTML must escape filenames to prevent XSS
- Content-Disposition headers need RFC 6266 encoding for Unicode filenames
- FUSE `fileCache` is module-level with LRU eviction at 100 entries
- Version in `src/utils/branding.js` must match `package.json` version
