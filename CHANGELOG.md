# Changelog

All notable changes to TAS (Telegram as Storage) will be documented in this file.

## [3.0.1] - 2026-09-25

### Fixed — current macFUSE mount support (#4)
- **System macFUSE build** — TAS no longer accepts the bundled OSXFUSE 3 library. On macOS it detects `/Library/Filesystems/macfuse.fs`, selects the installed `libfuse` headers and library, and rebuilds the optional `fuse-native` addon for the active CPU.
- **Apple Silicon support path** — the rebuilt addon uses macFUSE's supported v2 API surface rather than the legacy binary with no arm64 slice. TAS never installs, replaces, or removes a FUSE kernel extension.
- **Strict runtime guard** — TAS inspects the loaded native addon and refuses mount if it still links to `libosxfuse` or lacks a system-macFUSE build. `tas doctor` then performs the real mount → readdir → unmount smoke test.
- **Install guidance** — macOS requires current macFUSE and Xcode Command Line Tools before TAS is installed. A failed native build leaves push, pull, sync, and share available while mount stays disabled.

## [3.0.0] - 2026-09-24

### Fixed — FUSE and path correctness
- **Nested virtual directory tree (#3)** — sync-style names such as `subdir/file.txt` are now exposed as implicit directories. `readdir()` returns immediate children only; `getattr()` reports parent directories; file operations use exact normalized logical paths instead of fuzzy/basename lookup.
- **Disk-backed FUSE writes** — pending writes use private temp files instead of buffering the entire file in Node.js memory.
- **Safe truncate** — uncached remote content is downloaded before truncation; TAS no longer substitutes an empty buffer and silently destroys the rest of the file.
- **Duplicate-content paths** — migrated away from the legacy `UNIQUE(hash)` constraint, so identical bytes can exist at different logical paths without orphaning Telegram messages.
- **Safe unmount** — replaced interpolated shell commands with `execFileSync()` argument arrays.

### Changed — platform support (#4)
- **macOS mount is explicitly unsupported** in this release. `fuse-native@2.x` targets obsolete OSXFUSE APIs and is not considered compatible with current macFUSE/Apple Silicon. Push, pull, sync, share, and index recovery remain available.
- **Real FUSE diagnostics** — `tas doctor` calls `Fuse.isConfigured()` and, on supported Linux hosts, performs a temporary mount → async `readdir` → unmount smoke test. Importing the JS module alone no longer counts as success.

### Added — multi-bot and recovery
- **Config v3 bot pool** — `tas bot add/list/enable/disable/remove`, stable bot IDs, deterministic per-chunk routing, persisted `bot_id`, safe reads/deletes through the owning bot, and v1/v2 single-bot compatibility.
- **Explicit risk gate** — multi-bot setup requires acknowledgement and warns that it does not guarantee quota, durability, ban avoidance, or Terms compliance and must not be used to evade limits.
- **Encrypted remote manifest** — completed storage mutations publish a gzip-compressed AES-256-GCM manifest for files, chunks, ownership, and tags; ephemeral share tokens are excluded. `tas index backup` refreshes it and `tas index rebuild` authenticates and restores `index.db` while preserving a local backup.
- **Real resumable uploads** — encrypted chunks are staged on disk before network transfer, and normal uploads populate `pending_uploads`/`pending_chunks`. `tas resume` now continues actual interrupted uploads across bots.

### Security and protocol correctness
- **Opaque chunk metadata** — new uploads omit filename and original size from Telegram-visible WAS1 headers, use generic document names, and use opaque captions. Legacy chunks remain readable.
- **Hosted Bot API round-trip safety** — payload chunks are 19 MiB so the full document remains below the documented 20 MB `getFile` download limit. `tas doctor` flags legacy oversized chunks.
- **Serialized per-bot sends** — concurrent sync workers share one bot pool and one send queue per bot instead of bursting through independent client limiters.
- **Honest product claims** — removed “unlimited,” “free forever,” “zero-knowledge,” and “no ban risk” claims. Documentation now states observed metadata, recovery dependencies, Telegram policy risk, and the independent-backup requirement.

### Tests
- Added nested FUSE path integration tests, legacy schema migration tests, multi-bot routing/ownership tests, send-queue concurrency coverage, resumable-state tests, opaque-metadata tests, and encrypted manifest round-trip/rebuild coverage.

## [2.5.0] - 2026-09-17

### Fixed — reliability (failed uploads no longer brick files)
- **Atomic uploads** — `processFile` now deletes the partial `files` row + chunk rows + temp chunk if the pipeline throws, so retrying `tas push` no longer hits a phantom `File already uploaded (duplicate hash)`. DB connection is always closed on failure (was leaked).
- **Foreign keys enforced** — `FileIndex.init()` now sets `PRAGMA foreign_keys = ON` (SQLite disables it per connection), so `ON DELETE CASCADE` for chunks/tags/shares/sync-state actually works. Also sets `busy_timeout = 5000` for concurrent sync workers.
- **Exact-match lookup first** — `findByName`/`findByHash` now try exact match before LIKE fallback, so duplicate filenames resolve deterministically.
- **`tas resume` handles leftovers** — detects pre-2.5 incomplete file rows (`getIncompleteUploads`), offers one-shot cleanup, then resumes legacy `pending_uploads`. Finalize no longer hardcodes `compressed: true` or zero chunk sizes.
- **`tas sync pull` rewritten** — was skipping on mere existence and miscounting across folders. Now skips only when local content hash matches the index, re-pulls modified files, and downloads to the first registered folder.
- **Linux recursive watch** — `fs.watch({ recursive: true })` is macOS/Windows-only; `SyncEngine` now watches every subdirectory individually and picks up newly created subdirs. Previously subfolder changes were silently missed on Linux.
- **Sync no longer ignores dotfiles** — the generic `/^\./` ignore dropped `.env`/SSH keys while the README sells TAS as a secrets vault. Only junk (`.DS_Store`, `.git`, `node_modules`, `~`, `.swp`, `.tmp`) is ignored now.
- **FUSE large files** — `uploadFile` now chunks at 49MB like `tas push` (was single-chunk, so anything >~50MB failed), uploads atomically, cleans up its Telegram messages on failure, and no longer silently no-ops same-content-different-name copies. `rename` overwrites destination cleanly; `truncate` consults the on-disk cache.
- **Share download counting** — count increments after a successful stream (aborted connections no longer burn single-use links) and responses carry `Content-Length`.
- **`tas push <files...>`** — batch uploads with per-file results and a summary line; password verified once.

### Added — adoption (time-to-first-success)
- **Non-interactive `tas init`** — `--token/--chat/--password` flags (plus `TAS_PASSWORD` env). The README's Docker/CI example (`tas init --token … --chat …`) previously referenced flags that didn't exist — now it works.
- **`tas share create --host`** — bind address flag the 2.4.0 changelog already promised (`--host 0.0.0.0` for LAN). Network URL is only printed when actually reachable, with a warning when bound to all interfaces.
- **`tas doctor` checks Telegram** — verifies Bot API connectivity when the token is available (plaintext v1, or v2 with `--password`/`TAS_PASSWORD`); otherwise explains how to enable the check.
- **Honest delete prompts** — default delete says the Telegram copy is retained; `--hard` warns `file_id` blobs can outlive the message.
- **npm discoverability** — added `telegram-bot`, `zero-knowledge`, `end-to-end-encryption`, `offsite-backup`, `file-sharing`, `dropbox-alternative` keywords.

### Tests
- **78/78 passing** (was 71): new `tests/reliability.test.js` covers dotfile ignore rules, exact-match lookup, incomplete-upload detection, and cascade delete.

## [2.4.1] - 2026-06-30

### Security
- **Upgrade `node-telegram-bot-api` 0.66.0 → 1.1.2** — eliminates 9 vulnerabilities (2 critical, 7 moderate) inherited from the legacy `request` dependency: `form-data` CRLF injection, `qs` DoS via memory exhaustion, `tough-cookie` prototype pollution, `uuid` buffer bounds bypass
- **0 vulnerabilities** in full dependency tree after upgrade

### Fixed
- **Broken navigation anchor** — README `Security` nav link had incorrect URL-encoded variation selector (`#%EF%B8%8F-security-model`); corrected to `#-security-model` (matches GitHub's anchor generation algorithm)
- **Missing `node_modules`** — `better-sqlite3` was not resolvable, causing `share`, `sync`, and `tags` test suites to fail with `ERR_MODULE_NOT_FOUND`

### Tests
- **71/71 passing** after all fixes (was 41/71 due to missing dependency)

## [2.4.0] - 2026-06-04


### Security
- **Timing-safe password comparison** — `verifyPasswordHash` now uses `crypto.timingSafeEqual()` instead of `===` for both PBKDF2 and legacy SHA-256 paths, closing a timing side-channel
- **Config file permissions** — `config.json` is now `chmod 600` after creation, preventing other system users from reading your encrypted token and password hash
- **Share server binds to localhost** — Default bind address changed from `0.0.0.0` to `127.0.0.1` so the share server is no longer exposed to your entire LAN out of the box. Use `--host 0.0.0.0` if you need network access

### Fixed
- **Streaming encryption empty-data bug** — `getEncryptStream()` now correctly emits the salt/IV header even when zero bytes are piped through it. Previously, encrypting an empty stream produced malformed output that couldn't be decrypted. The header is now written in `flush()` if `transform()` was never called

### Added
- **31 new tests** — Streaming encryption/decryption (roundtrip, empty data, 1 MB, small-chunk stress, wrong password, truncation, cross-API compat) and WAS1 binary header (roundtrip, Unicode/CJK/emoji truncation, BigInt sizes, boundary values). Test count: 40 → 71
- **Shared download pipeline** — Extracted the triplicated Telegram→Decrypt→Decompress streaming pattern from `index.js`, `server.js`, and `mount.js` into a single reusable `createDownloadPipeline()` in `src/utils/download-stream.js`

### Changed
- **SECURITY.md rewritten** — Corrected PBKDF2 iterations (was 100,000, actual is 600,000), updated supported versions table to include 2.x, documented config v2 encrypted token storage and share server security model
- Internal download code in `index.js`, `server.js`, and `mount.js` now uses the shared pipeline instead of duplicated stream wiring

## [2.3.0] - 2026-05-30

### Added
- Landing page (`docs/index.html`) for GitHub Pages — dark/light theme, responsive, no frameworks
- `tas doctor` — Self-diagnostic command that checks Node.js version, config, database health, disk space, encryption parameters
- `tas verify` — Verify all uploaded files still exist and are intact on Telegram
- JSON output for `tas list --json` and `tas status --json`

### Changed
- README rewritten for Product Hunt — comparison table, collapsible CLI reference, security details table
- Config v2: bot token encrypted at rest with user's password (AES-256-GCM)
- PBKDF2 iterations raised to 600,000 (OWASP 2025 recommendation)

### Fixed
- ARM64 install crash (#1) — fuse-native moved to `optionalDependencies`
- 413 Request Entity Too Large (#2) — chunk size reduced to 49 MB

## [2.0.0] - 2026-02-12

### Added
- **`tas share`** — Temporary encrypted file sharing via local HTTP server
  - Create one-time download links with expiry (`--expire 1h/24h/7d`)
  - Configurable download limits (`--max-downloads`)
  - Dark-themed download page with file info
  - `tas share list` and `tas share revoke` for management
- **FUSE mount** — Mount Telegram storage as a local folder (`tas mount`)
- **Folder sync** — Dropbox-style auto-sync with file watching (`tas sync start`)

### Changed
- Major version bump for new feature set

## [1.2.0] - 2026-01-24

### Added
- Password automation — Use `-p/--password` flag or `TAS_PASSWORD` env var to skip prompts
- Batch operations — Upload multiple files without password prompts for each one
- CI/CD ready — Works with GitHub Actions, GitLab CI, Docker, cron jobs
- Config validation — Better error messages for missing/invalid configuration

### Changed
- All password-required commands now support automated workflows
- Improved config loading with detailed error reporting

## [1.1.0] - 2026-01-21

### Added
- **Progress bars with speed** — See actual MB/s during uploads/downloads
- **`tas search`** — Search files by name or content
- **Resume uploads** — Interrupted uploads can be resumed with `tas resume`
- **Streaming FUSE reads** — Large files no longer buffer entirely in RAM

### Changed
- README rewritten with technical focus (security model, architecture, limitations)

### Fixed
- FUSE mount stability improvements

## [1.0.0] - 2026-01-21

### Added
- Initial release
- AES-256-GCM encryption with PBKDF2 key derivation
- FUSE filesystem mount support
- File tagging system
- Dropbox-style folder sync
- Chunked uploads for files >49MB
