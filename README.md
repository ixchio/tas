<p align="center">
  <img src="assets/demo.gif" alt="TAS Demo" width="600">
</p>

<h1 align="center">Telegram as Storage</h1>

<p align="center">
  <strong>Free, encrypted, unlimited cloud storage — inside Telegram.</strong>
</p>

<p align="center">
  <a href="https://github.com/ixchio/tas/actions/workflows/ci.yml"><img src="https://github.com/ixchio/tas/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@nightowne/tas-cli"><img src="https://img.shields.io/npm/v/@nightowne/tas-cli" alt="npm"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/@nightowne/tas-cli"><img src="https://img.shields.io/npm/dm/@nightowne/tas-cli" alt="Downloads"></a>
</p>

---

I built this because I wanted encrypted cloud storage that's actually free. Google Drive reads your files. Dropbox costs money. Telegram gives you unlimited storage with a bot API — so I wrote a CLI that turns it into a proper encrypted drive.

**What this does:** Compresses, encrypts (AES-256-GCM), and uploads your files to your own private Telegram bot chat. Mount it as a folder, sync directories, or share files with expiring links.

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

## ⚡ Quick Start

```bash
npm install -g @nightowne/tas-cli
tas init          # 2-minute setup wizard
tas push secret.pdf
tas pull secret.pdf
```

## 🔥 Features

### Mount as a folder
```bash
tas mount ~/cloud      # FUSE mount — drag & drop files
tas unmount ~/cloud
```
Requires `libfuse` (`apt install fuse libfuse-dev` on Debian/Ubuntu, `brew install macfuse` on macOS).

### Auto-sync folders
```bash
tas sync add ~/Documents    # Register
tas sync start              # Watch for changes, auto-upload
tas sync pull               # Download everything back
```

### Share files with expiring links
```bash
tas share create secret.pdf --expire 1h --max-downloads 3
# → http://localhost:3000/d/a1b2c3d4...

tas share list              # Active shares
tas share revoke a1b2c3d4   # Revoke
```
Spins up a local HTTP server. File is downloaded from Telegram, decrypted, and served. Dark-themed download page with file info.

## 🛡️ Security

| Component | Implementation |
|-----------|----------------|
| Cipher | AES-256-GCM |
| Key derivation | PBKDF2-SHA512, 100k iterations |
| Salt | 32 bytes, random per file |
| IV | 12 bytes, random per file |
| Auth tag | 16 bytes (integrity verification) |

Your password **never** leaves your machine. Telegram only sees encrypted blobs. Even if someone accesses your bot chat, they get meaningless data without your password.

## 📋 Full CLI Reference

```bash
# Core
tas init                    # Setup wizard
tas push <file>             # Upload
tas pull <file|hash>        # Download
tas list [-l]               # List files
tas delete <file|hash>      # Delete
tas status                  # Stats
tas search <query>          # Search files
tas resume                  # Resume interrupted uploads
tas verify                  # Check integrity

# FUSE Mount
tas mount <path>            # Mount as folder
tas unmount <path>          # Unmount

# Sync
tas sync add <folder>       # Register folder
tas sync start              # Start watching
tas sync pull               # Download all
tas sync status             # Show status

# Share
tas share create <file>     # Create download link
tas share list              # Active shares
tas share revoke <token>    # Revoke

# Tags
tas tag add <file> <tags...>
tas tag remove <file> <tags...>
tas tag list [tag]
```

## 🤖 Automation

```bash
# Skip password prompts
export TAS_PASSWORD="your-password"
tas push file.pdf

# Or inline
tas push -p "password" file.pdf
```

Works with cron, GitHub Actions, Docker, or any CI/CD.

## ⚠️ Limitations

- **Not a backup** — Telegram can delete content without notice
- **No versioning** — overwriting deletes the old version
- **49MB chunks** — files split due to Bot API limits
- **Single user** — personal use, not multi-tenant
- **FUSE required** — mount feature needs libfuse

## 🛠️ Development

```bash
git clone https://github.com/ixchio/tas
cd tas && npm install
npm test  # 43 tests
```

```
src/
├── cli.js           # Commands
├── index.js         # Upload/download pipeline
├── crypto/          # AES-256-GCM
├── db/              # SQLite index
├── fuse/            # FUSE filesystem
├── share/           # HTTP share server
├── sync/            # Folder sync engine
├── telegram/        # Bot API client
└── utils/           # Compression, chunking
```

## 📄 License

MIT — do whatever you want with it.
