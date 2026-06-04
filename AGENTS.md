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
- `src/utils/download-stream.js` — Shared Telegram→Decrypt→Decompress pipeline (used by index.js, server.js, mount.js)
- `src/share/server.js` — HTTP server for temporary file sharing (binds 127.0.0.1 by default)
- `src/sync/sync.js` — Folder sync engine with fs.watch
- `src/fuse/mount.js` — FUSE filesystem mount (fuse-native)

## Key Technical Details
- Data directory: `~/.tas` (or `TAS_DATA_DIR` env var)
- Config version 2: bot token encrypted with user's password in config.json, chmod 600
- Config version 1 (legacy): plaintext bot token — backward compatible
- PBKDF2 iterations: 600,000 (OWASP 2025 recommendation)
- Chunk size: 49MB (Telegram Bot API limit is 50MB)
- File header: 64 bytes "WAS1" format with filename, size, chunk info
- Password hash comparison uses `crypto.timingSafeEqual()` (both PBKDF2 and legacy paths)

## Testing
- `npm test` runs all tests via `node --test tests/*.test.js`
- 71 tests across 6 files: encryption (buffer + streaming), WAS1 header, compression, tags, sync DB, share DB
- Tests cover: streaming encrypt/decrypt roundtrips, cross-API compatibility (buffer↔stream), small-chunk stress, truncation/corruption errors, Unicode filename handling
- No mocking of Telegram API — tests focus on pure logic

## Common Pitfalls
- `findByName`/`findByHash` use LIKE queries — wildcards must be escaped
- `cleanExpiredShares` compares ISO date strings directly (not SQL date functions)
- Share server HTML must escape filenames to prevent XSS
- Content-Disposition headers need RFC 6266 encoding for Unicode filenames
- FUSE `fileCache` is module-level with LRU eviction at 100 entries
- Version in `src/utils/branding.js` must match `package.json` version
- `Chunker` class in `chunker.js` is dead code — superseded by streaming chunker in `index.js`
- `formatBytes` still has 3 implementations: `cli.js`, `branding.js` (as `formatSize`), `progress.js`
