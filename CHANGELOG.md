# Changelog

All notable changes to TAS (Telegram as Storage) will be documented in this file.

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
- Password automation - Use `-p/--password` flag or `TAS_PASSWORD` env var to skip prompts
- Batch operations - Upload multiple files without password prompts for each one
- CI/CD ready - Works with GitHub Actions, GitLab CI, Docker, cron jobs
- Config validation - Better error messages for missing/invalid configuration

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
