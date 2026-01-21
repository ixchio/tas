# TAS — Telegram as Storage

A CLI tool that uses your Telegram bot as encrypted file storage. Files are compressed, encrypted locally, then uploaded to your private bot chat.

```
┌─────────────┐     ┌───────────────┐     ┌──────────────┐
│   CLI       │────▶│  Compress &   │────▶│  Telegram    │
│   FUSE      │     │  Encrypt      │     │  Bot API     │
└─────────────┘     └───────────────┘     └──────────────┘
       │                    │                     │
       ▼                    ▼                     ▼
┌─────────────┐     ┌───────────────┐     ┌──────────────┐
│ SQLite Index│     │ 49MB Chunks   │     │ Private Chat │
└─────────────┘     └───────────────┘     └──────────────┘
```

## Why TAS?

| Feature | TAS | Session-based tools (e.g. teldrive) |
|---------|:---:|:-----------------------------------:|
| Account ban risk | **None** (Bot API) | High (session hijack detection) |
| Encryption | AES-256-GCM | Usually none |
| Dependencies | SQLite only | Rclone, external DB |
| Setup complexity | 2 minutes | Docker + multiple services |

**Key differences:**
- Uses **Bot API**, not session-based auth — Telegram can't ban your account
- **Encryption by default** — files encrypted before leaving your machine
- **Local-first** — SQLite index, no cloud dependencies
- **FUSE mount** — use Telegram like a folder

## Security Model

| Component | Implementation |
|-----------|----------------|
| Cipher | AES-256-GCM |
| Key derivation | PBKDF2-SHA512, 100,000 iterations |
| Salt | 32 bytes, random per file |
| IV | 12 bytes, random per file |
| Auth tag | 16 bytes (integrity) |

Your password never leaves your machine. Telegram stores encrypted blobs.

## Limitations

- **Not a backup** — Telegram can delete content without notice
- **No versioning** — overwriting a file deletes the old version
- **49MB chunks** — files split due to Bot API limits
- **FUSE required** — mount feature needs `libfuse` on Linux/macOS
- **Single user** — designed for personal use, not multi-tenant

## Quick Start

```bash
# Install
npm install -g @nightowne/tas-cli

# Setup (creates bot connection + encryption password)
tas init

# Upload a file
tas push secret.pdf

# Download a file
tas pull secret.pdf

# Mount as folder (requires libfuse)
tas mount ~/cloud
```

### Prerequisites
- Node.js ≥18
- Telegram account + bot token from [@BotFather](https://t.me/BotFather)
- `libfuse` for mount feature:
  ```bash
  # Debian/Ubuntu
  sudo apt install fuse libfuse-dev
  
  # Fedora
  sudo dnf install fuse fuse-devel
  
  # macOS
  brew install macfuse
  ```

## CLI Reference

```bash
# Core
tas init                    # Setup wizard
tas push <file>             # Upload file
tas pull <file|hash>        # Download file
tas list [-l]               # List files (long format)
tas delete <file|hash>      # Remove file
tas status                  # Show stats

# Search & Resume (v1.1.0)
tas search <query>          # Search by filename
tas search -t <query>       # Search by tag
tas resume                  # Resume interrupted uploads

# FUSE Mount
tas mount <path>            # Mount as folder
tas unmount <path>          # Unmount

# Tags
tas tag add <file> <tags...>    # Add tags
tas tag remove <file> <tags...> # Remove tags
tas tag list [tag]              # List tags or files by tag

# Sync (Dropbox-style)
tas sync add <folder>       # Register folder for sync
tas sync start              # Start watching
tas sync pull               # Download all to sync folders
tas sync status             # Show sync status

# Verification
tas verify                  # Check file integrity
```

## Auto-Start (systemd)

See [systemd/README.md](systemd/README.md) for running sync as a service.

## Development

```bash
git clone https://github.com/ixchio/tas
cd tas
npm install
npm test  # 28 tests
```

### Project Structure
```
src/
├── cli.js           # Command definitions
├── index.js         # Upload/download pipeline
├── crypto/          # AES-256-GCM encryption
├── db/              # SQLite file index
├── fuse/            # FUSE filesystem mount
├── sync/            # Folder sync engine
├── telegram/        # Bot API client
└── utils/           # Compression, chunking
```

## License

MIT
