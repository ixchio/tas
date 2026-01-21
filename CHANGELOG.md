# Changelog

All notable changes to TAS (Telegram as Storage) will be documented in this file.

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
