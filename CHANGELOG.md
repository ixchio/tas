# Changelog

All notable changes to TAS (Telegram as Storage) will be documented in this file.

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
