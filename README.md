<p align="center">
  <img src="assets/demo.gif" alt="TAS — Telegram as Storage" width="640">
</p>

<h1 align="center">
  📦 TAS — Telegram as Storage
</h1>

<h3 align="center">
  Turn Telegram into your personal encrypted cloud drive.<br>
  Free forever. Zero-knowledge. No credit card. No limits.
</h3>

<p align="center">
  <a href="https://github.com/ixchio/tas/actions/workflows/ci.yml"><img src="https://github.com/ixchio/tas/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@nightowne/tas-cli"><img src="https://img.shields.io/npm/v/@nightowne/tas-cli?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@nightowne/tas-cli"><img src="https://img.shields.io/npm/dm/@nightowne/tas-cli?color=blue" alt="Downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT"></a>
  <a href="https://github.com/ixchio/tas/stargazers"><img src="https://img.shields.io/github/stars/ixchio/tas?style=social" alt="GitHub Stars"></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-why-tas">Why TAS</a> •
  <a href="#-features">Features</a> •
  <a href="#%EF%B8%8F-security">Security</a> •
  <a href="#-cli-reference">Docs</a> •
  <a href="#-contributing">Contributing</a>
</p>

---

<br>

## The Problem

Google Drive scans your files. Dropbox costs $12/mo. iCloud locks you into Apple. Every "free" cloud storage either **reads your data**, **charges you money**, or **caps your storage**.

Meanwhile, Telegram gives every user **unlimited storage** with a bot API — and nobody's using it.

## The Solution

**TAS** compresses, encrypts, and uploads your files to your own private Telegram bot chat. Your password never leaves your machine. Telegram only sees encrypted noise. You get a real CLI-powered cloud drive — with mount, sync, share, and search — for **$0/month, forever.**

```
  Your Machine                          Telegram Cloud
┌──────────────────┐               ┌──────────────────────┐
│                  │   Compress    │                      │
│   tas push       │──→ Encrypt ──→│  🔒 Encrypted Blobs  │
│   tas mount      │──→ Chunk   ──→│  🔒 Private Bot Chat │
│   tas sync       │               │  🔒 Your Data, Safe  │
│                  │   Decrypt    │                      │
│   tas pull       │←── Decomp ←──│  ← Download on demand│
│                  │               │                      │
└──────────────────┘               └──────────────────────┘
     SQLite Index                     Unlimited & Free
```

<br>

## ⚡ Quick Start

Three commands. Two minutes. Zero cost.

```bash
npm install -g @nightowne/tas-cli

tas init              # Connect your Telegram bot (guided wizard)
tas push secret.pdf   # Upload — encrypted, compressed, done
tas pull secret.pdf   # Download — decrypted, verified, instant
```

That's it. You now have encrypted cloud storage.

<br>

## 💡 Why TAS

<table>
<tr>
<td width="50%">

### vs. Google Drive
- ❌ Google scans & indexes your files
- ❌ 15 GB free tier
- ❌ No encryption at rest (by you)

### vs. Dropbox
- ❌ $12/mo for 2 TB
- ❌ Can access your data
- ❌ No CLI-first experience

### vs. Mega / pCloud
- ❌ Freemium with tight caps
- ❌ Closed source encryption
- ❌ Can't self-host or script

</td>
<td width="50%">

### TAS gives you
- ✅ **$0/month** — forever, no caps
- ✅ **Zero-knowledge** — only you can decrypt
- ✅ **AES-256-GCM** — military-grade encryption
- ✅ **Mount as folder** — FUSE filesystem
- ✅ **Auto-sync** — Dropbox-style folder sync
- ✅ **Share links** — expiring, download-limited
- ✅ **CLI-first** — cron, Docker, CI/CD ready
- ✅ **Open source** — audit every line

</td>
</tr>
</table>

<br>

## 🔥 Features

### 🗂️ Mount as a Local Folder
Drag and drop files into Telegram storage like it's a regular drive.

```bash
tas mount ~/cloud        # Mount your Telegram storage
# Now use Finder, Explorer, or any app — files sync to Telegram
tas unmount ~/cloud
```

> Requires `libfuse` — `apt install fuse libfuse-dev` on Linux, `brew install macfuse` on macOS.

### 🔄 Auto-Sync Folders
Dropbox-style: register a folder, and TAS watches for changes and uploads automatically.

```bash
tas sync add ~/Documents    # Register a folder
tas sync start              # Watch & auto-upload changes
tas sync pull               # Download everything back
tas sync status             # See what's synced
```

### 🔗 Share with Expiring Links
Generate one-time download links with a sleek dark-themed download page. Files are decrypted on-the-fly — the link holder never sees your password.

```bash
tas share create report.pdf --expire 1h --max-downloads 3
# → http://localhost:3000/d/a1b2c3d4...

tas share list              # See active shares
tas share revoke a1b2c3d4   # Revoke anytime
```

### 🏷️ Tags & Search
Organize and find files instantly.

```bash
tas tag add report.pdf work Q4
tas search "report"          # Search by filename
tas search -t work           # Search by tag
```

### 🩺 Self-Diagnostics
One command to check if everything is healthy.

```bash
tas doctor
# ✓ Node.js 20.11.0
# ✓ Config v2 (encrypted token)
# ✓ Database: 42 files, 1.3 GB total
# ✓ Disk space: 50 GB free (32% used)
# ✓ Encryption: AES-256-GCM, PBKDF2-SHA512 600,000 iterations
# ✨ All systems go!
```

### 🤖 Built for Automation
First-class JSON output, environment variable support, and zero interactivity mode.

```bash
export TAS_PASSWORD="your-password"     # Skip prompts
export TAS_DATA_DIR="/custom/path"      # Custom data location

tas push backup.tar.gz                  # Non-interactive upload
tas list --json | jq '.[].filename'     # Pipe to jq
tas status --json                       # Machine-readable status

# Works with: cron • GitHub Actions • Docker • systemd • any CI/CD
```

<br>

## 🛡️ Security

TAS implements **zero-knowledge encryption** — we can't read your data, Telegram can't read your data, nobody can read your data without your password.

| Layer | Implementation | Why It Matters |
|-------|----------------|----------------|
| **Cipher** | AES-256-GCM | Same cipher used by governments & banks |
| **Key Derivation** | PBKDF2-SHA512, **600k iterations** | OWASP 2025 compliant — brute-force resistant |
| **Salt** | 32 bytes, cryptographically random | Unique per file — no rainbow tables |
| **IV** | 12 bytes, cryptographically random | Unique per file — no pattern analysis |
| **Auth Tag** | 16 bytes GCM authentication | Tamper detection — any bit flip = rejected |
| **Bot Token** | Encrypted at rest (AES-256-GCM) | Even your config file is protected |
| **Password Hash** | PBKDF2-based verification | Your password hash is computationally expensive to crack |
| **Integrity** | SHA-256 verified on every download | Bit-perfect downloads, guaranteed |
| **Share Server** | XSS-safe, RFC 6266 headers | Hardened against injection attacks |

### What Telegram Sees

```
📦 a7f3b2c1e9d4.tas — 12.4 MB — application/octet-stream
```

That's it. An opaque encrypted blob. No filename, no content, no metadata. Just noise.

<br>

## 🔄 Reliability

Built like professional backup tools (inspired by restic, rclone, borg):

| Feature | Details |
|---------|---------|
| **Exponential Backoff** | Auto-retry with jitter on Telegram 429 errors and network timeouts |
| **Rate Limiting** | Built-in 1 msg/sec limiter — never hits Telegram's rate limits |
| **Integrity Verification** | SHA-256 hash check after every single download |
| **Resume Uploads** | Interrupted? Run `tas resume` to pick up where you left off |
| **Graceful Shutdown** | SIGINT/SIGTERM handled cleanly — zero data corruption risk |
| **Self-Diagnostics** | `tas doctor` validates your entire setup in seconds |

<br>

## 📋 CLI Reference

<details>
<summary><strong>Core Commands</strong></summary>

```bash
tas init                    # 🚀 Interactive setup wizard
tas push <file>             # ⬆️  Upload (encrypt + compress + upload)
tas pull <file|hash>        # ⬇️  Download (download + decrypt + verify)
tas list [-l] [--json]      # 📋 List all files
tas delete <file|hash>      # 🗑️  Remove from index (--hard to delete from Telegram)
tas status [--json]         # 📊 Storage stats
tas search <query>          # 🔍 Find files by name or tag
tas resume                  # 🔄 Resume interrupted uploads
tas verify                  # ✅ Verify all files exist & are intact
tas doctor                  # 🩺 System health check
```

</details>

<details>
<summary><strong>Mount & Sync</strong></summary>

```bash
# FUSE Mount (use Telegram like a local folder)
tas mount <path>            # Mount
tas unmount <path>          # Unmount

# Folder Sync (Dropbox-style auto-upload)
tas sync add <folder>       # Register a folder to sync
tas sync start              # Start watching for changes
tas sync pull               # Download all synced files
tas sync status             # Show sync status
```

</details>

<details>
<summary><strong>Share & Tags</strong></summary>

```bash
# Temporary Share Links
tas share create <file> [--expire 24h] [--max-downloads 3]
tas share list              # Active shares
tas share revoke <token>    # Revoke a share link

# File Tags
tas tag add <file> <tags...>
tas tag remove <file> <tags...>
tas tag list [tag]          # List tags or files with a specific tag
```

</details>

<br>

## 🏗️ Architecture

```
src/
├── cli.js              # Commander-based CLI — all commands
├── index.js            # Streaming upload/download pipeline
├── crypto/
│   └── encryption.js   # AES-256-GCM + PBKDF2-SHA512 key derivation
├── db/
│   └── index.js        # SQLite index (files, chunks, tags, shares, sync)
├── telegram/
│   └── client.js       # Bot API wrapper — retry, rate-limit, streaming
├── fuse/
│   └── mount.js        # FUSE filesystem — mount Telegram as a folder
├── share/
│   └── server.js       # HTTP server — expiring download links
├── sync/
│   └── sync.js         # Folder watcher — Dropbox-style auto-sync
└── utils/
    ├── compression.js   # Smart gzip (skips already-compressed formats)
    ├── chunker.js       # 49MB chunking with custom WAS1 file headers
    ├── progress.js      # Terminal progress bar with speed + ETA
    ├── throttle.js      # Bandwidth limiter (stream transform)
    ├── branding.js      # ASCII art + formatting
    └── cli-helpers.js   # Password management + config resolution
```

**Tech stack:** Node.js · better-sqlite3 · node-telegram-bot-api · fuse-native · Commander · Chalk · Ora · Inquirer

<br>

## ⚠️ Good to Know

| | |
|---|---|
| 📌 **Not a backup solution** | Telegram can delete content. Use TAS alongside proper backups, not instead of them. |
| 📌 **49 MB chunks** | Files are automatically split due to Telegram Bot API limits. Fully transparent. |
| 📌 **Single-user** | Designed for personal use. Not multi-tenant. |
| 📌 **FUSE = Linux/macOS** | Mount feature requires `libfuse`. CLI works everywhere Node.js runs. |
| 📌 **No versioning (yet)** | Overwriting a file replaces the previous version. |

<br>

## 🛠️ Development

```bash
git clone https://github.com/ixchio/tas
cd tas && npm install
npm test  # 43 tests, all passing
```

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

<br>

## 🌟 Contributing

TAS is open source and we love contributions:

- 🐛 **Found a bug?** [Open an issue](https://github.com/ixchio/tas/issues)
- 💡 **Have an idea?** [Start a discussion](https://github.com/ixchio/tas/issues)
- 🔧 **Want to contribute?** Fork → Branch → PR → 🎉

<br>

## 📄 License

MIT — use it, fork it, ship it, sell it. Do whatever you want.

---

<p align="center">
  <sub>Built with ☕ and stubbornness by <a href="https://github.com/ixchio">@ixchio</a></sub><br>
  <sub>If TAS saved you money, consider giving it a ⭐</sub>
</p>
