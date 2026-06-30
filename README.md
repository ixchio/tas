<p align="center">
  <img src="assets/demo.gif" alt="TAS — Telegram as Storage CLI demo" width="680">
</p>

<h1 align="center">📦 TAS — Telegram as Storage</h1>

<h3 align="center">
  Turn your Telegram bot into unlimited, encrypted cloud storage.<br>
  <strong>Free forever. Zero-knowledge. No sign-up. No credit card. No limits.</strong>
</h3>

<p align="center">
  <a href="https://github.com/ixchio/tas/actions/workflows/ci.yml"><img src="https://github.com/ixchio/tas/actions/workflows/ci.yml/badge.svg" alt="CI Status"></a>
  <a href="https://www.npmjs.com/package/@nightowne/tas-cli"><img src="https://img.shields.io/npm/v/@nightowne/tas-cli?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@nightowne/tas-cli"><img src="https://img.shields.io/npm/dm/@nightowne/tas-cli?color=blue&label=downloads&logo=npm" alt="Monthly Downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-brightgreen.svg" alt="License: MIT"></a>
  <a href="https://github.com/ixchio/tas/stargazers"><img src="https://img.shields.io/github/stars/ixchio/tas?style=social" alt="GitHub Stars"></a>
  <a href="https://github.com/ixchio/tas/network/members"><img src="https://img.shields.io/github/forks/ixchio/tas?style=social" alt="GitHub Forks"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js" alt="Node.js >= 18">
  <img src="https://img.shields.io/badge/encryption-AES--256--GCM-blueviolet?logo=shield" alt="AES-256-GCM">
  <img src="https://img.shields.io/badge/tests-71%20passing-success" alt="71 Tests Passing">
</p>

<p align="center">
  <a href="QUICKSTART.md"><strong>📚 Quick Start</strong></a> &nbsp;•&nbsp;
  <a href="FAQ.md">FAQ</a> &nbsp;•&nbsp;
  <a href="#-why-tas">Why TAS?</a> &nbsp;•&nbsp;
  <a href="#-features">Features</a> &nbsp;•&nbsp;
  <a href="#-security-model">Security</a> &nbsp;•&nbsp;
  <a href="#-cli-reference">CLI Docs</a> &nbsp;•&nbsp;
  <a href="#-docker--cicd">Docker / CI</a> &nbsp;•&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

> **TL;DR** — One `npm install`, one `tas init`, then `tas push yourfile.pdf`. Your file is now AES-256 encrypted and stored for free on Telegram's infrastructure. No accounts, no fees, no vendor lock-in. Seriously.

---

## The Problem With "Free" Cloud Storage

Every major cloud provider has one of three business models: **scanning your data**, **charging you money**, or **capping your storage**. There is no free lunch.

| Provider | Free Tier | Reads Your Data? | CLI-First? | Encryption At Rest (by you)? |
|---|---|---|---|---|
| Google Drive | 15 GB | ✅ Yes (indexes for ads) | ❌ | ❌ |
| Dropbox | 2 GB | ✅ Can access | ❌ | ❌ |
| iCloud | 5 GB | ✅ Apple ToS | ❌ | ❌ |
| Mega | 20 GB | ❓ Closed-source E2EE | ❌ | ❓ |
| Backblaze B2 | 10 GB | ❌ | ✅ | ❌ (you add it) |
| **TAS + Telegram** | **♾️ Unlimited** | **❌ Impossible (AES-256)** | **✅ First-class** | **✅ Always** |

Meanwhile, Telegram gives every bot **unlimited file storage** via its public Bot API — and almost nobody is using it.

---

## The Solution

**TAS** compresses, encrypts (AES-256-GCM), chunks, and uploads your files to your own private Telegram bot chat. Your password never leaves your machine. Telegram only ever sees **encrypted noise**. You get a fully-featured, CLI-native cloud drive with FUSE mount, Dropbox-style sync, expiring share links, and tagging — at **$0/month, forever.**

```
  Your Machine                                    Telegram Cloud
┌─────────────────────────────┐               ┌──────────────────────────┐
│                             │               │                          │
│  tas push secret.tar.gz     │──→ gzip ──→   │   🔒 Encrypted Blob #1   │
│  tas mount ~/cloud          │──→ AES-256 ──→│   🔒 Encrypted Blob #2   │
│  tas sync start             │──→ chunk ──→  │   🔒 Encrypted Blob #3   │
│                             │               │   (Private Bot Chat)     │
│  tas pull secret.tar.gz     │←── decrypt ←──│                          │
│  (SHA-256 verified)         │←── decomp  ←──│   ← Stream on demand     │
│                             │               │                          │
└─────────────────────────────┘               └──────────────────────────┘
         SQLite Index                              Unlimited & Free
```

---

## ⚡ Quick Start

**Three commands. Under two minutes. Zero cost.**

```bash
# 1. Install globally
npm install -g @nightowne/tas-cli

# 2. Connect your Telegram bot (guided wizard — takes ~60 seconds)
tas init

# 3. Start using it
tas push secret.pdf          # Encrypt + compress + upload
tas pull secret.pdf          # Download + decrypt + verify
tas list                     # See everything you've stored
```

> **Need a Telegram bot?** Open Telegram → search `@BotFather` → `/newbot` → copy the token. That's it.

---

## 💡 Why TAS?

<table>
<tr>
<td width="50%" valign="top">

### ❌ The Alternative
- Google Drive scans & indexes your files for ads
- Dropbox costs $12/mo — and can read your data
- iCloud locks you into the Apple ecosystem
- Self-hosting (Nextcloud, MinIO) costs VPS money + maintenance time
- S3 / B2 needs encryption wiring and costs per GB transferred
- rclone + any backend still needs a paid backend

</td>
<td width="50%" valign="top">

### ✅ TAS gives you
- **$0/month** — forever, no storage caps, no bandwidth fees
- **Zero-knowledge** — only you hold the decryption key
- **AES-256-GCM** — same cipher used by banks and governments
- **FUSE mount** — Telegram storage appears as a real folder
- **Auto-sync** — Dropbox-style folder watcher built-in
- **Expiring share links** — send files without sharing your password
- **CLI-first** — pipe to `jq`, run in cron, automate everything
- **Open source** — audit every single line of crypto code

</td>
</tr>
</table>

---

## 🔥 Features

### 🗂️ Mount as a Local Folder (FUSE)

Use Telegram storage exactly like a USB drive — drag and drop, open in any app.

```bash
tas mount ~/cloud            # Mount your Telegram storage as ~/cloud
ls ~/cloud                   # Browse your encrypted files normally
cp report.pdf ~/cloud/       # Drop files in — auto-encrypted and uploaded
tas unmount ~/cloud          # Clean unmount when done
```

> **Requirements:** `apt install fuse libfuse-dev` (Linux) · `brew install macfuse` (macOS)

---

### 🔄 Auto-Sync Folders (Dropbox-style)

Register a local folder and TAS watches it. Any new or changed file is automatically encrypted and uploaded.

```bash
tas sync add ~/Documents        # Register ~/Documents for auto-sync
tas sync start                  # Start the watcher (runs in background)
tas sync pull                   # Pull all synced files back down
tas sync status                 # See what's queued / synced / pending
```

---

### 🔗 Expiring Share Links

Generate time-limited, download-limited share links. Recipients get a clean dark-themed download page. **Your password is never shared — files are decrypted on-the-fly by the local server.**

```bash
tas share create report.pdf --expire 24h --max-downloads 5
# → http://localhost:3000/d/a1b2c3d4e5f6...

tas share create backup.tar.gz --expire 1h --max-downloads 1  # Burn-after-read
tas share list                  # See active links with expiry info
tas share revoke a1b2c3d4       # Revoke instantly, anytime
```

---

### 🏷️ Tags & Full-Text Search

```bash
tas tag add report.pdf work Q4 finance
tas tag add keys.env secrets production
tas search "report"             # Search by filename pattern
tas search -t work              # All files tagged "work"
tas search -t secrets           # Quickly find your credentials
```

---

### 🩺 Self-Diagnostics

```bash
tas doctor
# ✓ Node.js 20.11.0
# ✓ Config v2 (encrypted bot token — AES-256-GCM at rest)
# ✓ Database: 42 files, 1.3 GB total across 28 chunks
# ✓ Disk space: 50 GB free (32% used)
# ✓ Encryption: AES-256-GCM · PBKDF2-SHA512 · 600,000 iterations (OWASP 2025)
# ✓ Telegram connectivity: OK
# ✨ All systems go!
```

---

### 🤖 Built for Automation — CI/CD, Docker, Cron

TAS is fully scriptable. No interactive prompts needed when `TAS_PASSWORD` is set.

```bash
# Environment-based automation
export TAS_PASSWORD="your-password"
export TAS_DATA_DIR="/custom/path"

# Pipe to jq
tas list --json | jq '.[].filename'
tas list --json | jq '.[] | select(.size > 1000000)'  # Files > 1MB

# GitHub Actions backup step
tas push db-backup-$(date +%Y%m%d).sql.gz

# cron: nightly backup at 2am
0 2 * * * TAS_PASSWORD=$SECRET tas push /var/backups/db.tar.gz

# JSON machine output everywhere
tas status --json
tas list --json
```

---

## 🐳 Docker & CI/CD

```dockerfile
FROM node:20-alpine

RUN npm install -g @nightowne/tas-cli

ENV TAS_PASSWORD=""
ENV TAS_DATA_DIR="/data"

VOLUME ["/data"]

CMD ["tas", "status"]
```

```yaml
# .github/workflows/backup.yml
name: Nightly Backup

on:
  schedule:
    - cron: '0 2 * * *'

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Install TAS
        run: npm install -g @nightowne/tas-cli

      - name: Push backup
        env:
          TAS_PASSWORD: ${{ secrets.TAS_PASSWORD }}
          TAS_DATA_DIR: ${{ runner.temp }}/tas-data
        run: |
          tas init --token ${{ secrets.TELEGRAM_BOT_TOKEN }} --chat ${{ secrets.TELEGRAM_CHAT_ID }}
          tar czf backup-$(date +%Y%m%d).tar.gz ./important-data/
          tas push backup-$(date +%Y%m%d).tar.gz
```

---

## 🛡️ Security Model

TAS implements **zero-knowledge encryption** — we can't read your data, Telegram can't read your data, and nobody without your password ever can.

| Layer | Implementation | Standard |
|---|---|---|
| **Cipher** | AES-256-GCM (authenticated encryption) | NIST FIPS 197 |
| **Key Derivation** | PBKDF2-SHA512, **600,000 iterations** | OWASP 2025 |
| **Salt** | 32 bytes, `crypto.randomBytes()` — unique per file | No rainbow tables |
| **IV/Nonce** | 12 bytes, `crypto.randomBytes()` — unique per file | No nonce reuse |
| **Auth Tag** | 16 bytes GCM tag — any tampered bit = instant rejection | Tamper detection |
| **Bot Token** | Encrypted at rest in `config.json` (AES-256-GCM) | Config v2 |
| **Password Verification** | `crypto.timingSafeEqual()` on both PBKDF2 and legacy paths | Timing-safe |
| **Config Permissions** | `chmod 600 config.json` on creation | No world-readable secrets |
| **Integrity** | SHA-256 hash verified on every single download | Bit-perfect guarantee |
| **Share Server** | Binds `127.0.0.1` by default, XSS-escaped, RFC 6266 filenames | LAN-safe |

### What Telegram Actually Sees

```
📦  a7f3b2c1e9d4f820.tas  —  12.4 MB  —  application/octet-stream
```

An opaque, encrypted blob. No filename. No content type. No metadata. Just noise.

### Threat Model

| Threat | Mitigated? | How |
|---|---|---|
| Telegram reads your files | ✅ Yes | AES-256-GCM — mathematically impossible without key |
| Someone steals your config.json | ✅ Yes | Bot token encrypted at rest; password hash is PBKDF2 |
| Brute-force your password | ✅ Yes | 600k PBKDF2 iterations ≈ 100ms/attempt minimum |
| Tampered download | ✅ Yes | SHA-256 check + GCM auth tag on every download |
| Timing attack on password | ✅ Yes | `crypto.timingSafeEqual()` on all comparisons |
| Share link exposure | ✅ Yes | Localhost-only by default; expiry + download limits |

---

## 🔄 Reliability

Built with the same philosophy as professional backup tools (restic, borg, rclone):

| Feature | Implementation |
|---|---|
| **Exponential Backoff** | Auto-retry with jitter on Telegram 429 errors and network timeouts |
| **Rate Limiting** | Built-in 1 msg/sec — never trips Telegram's rate limits |
| **Integrity Verification** | SHA-256 hash verified after every single download |
| **Resume Uploads** | `tas resume` picks up interrupted multi-chunk uploads |
| **Graceful Shutdown** | SIGINT/SIGTERM handled — zero corruption risk on Ctrl-C |
| **Self-Diagnostics** | `tas doctor` validates your entire setup end-to-end |

---

## 📋 CLI Reference

<details>
<summary><strong>Core Commands</strong></summary>

```bash
tas init                          # 🚀 Interactive setup wizard (create bot in ~60s)
tas push <file> [file2...]        # ⬆️  Encrypt + compress + upload
tas pull <file|hash>              # ⬇️  Download + decrypt + verify
tas list [-l] [--json]            # 📋 List all stored files
tas delete <file|hash>            # 🗑️  Remove from index (--hard removes from Telegram)
tas status [--json]               # 📊 Storage stats & database health
tas search <query> [-t tag]       # 🔍 Find by filename or tag
tas resume                        # 🔄 Resume interrupted uploads
tas verify                        # ✅ Verify every file still exists and is intact
tas doctor                        # 🩺 Full system health check
```

</details>

<details>
<summary><strong>Mount & Sync</strong></summary>

```bash
# FUSE Mount
tas mount <path>                  # Mount Telegram storage as a local folder
tas unmount <path>                # Clean unmount

# Dropbox-style Folder Sync
tas sync add <folder>             # Register folder for auto-sync
tas sync start                    # Start watching for changes
tas sync pull                     # Download all synced files locally
tas sync status                   # Show sync queue and status
```

</details>

<details>
<summary><strong>Share & Tags</strong></summary>

```bash
# Expiring Share Links
tas share create <file> [--expire 1h|24h|7d] [--max-downloads N]
tas share list                    # Active links with expiry countdown
tas share revoke <token>          # Instantly revoke a share

# File Tagging
tas tag add <file> <tag> [tag2...]
tas tag remove <file> <tag>
tas tag list [tag]                # List all tags, or files with a specific tag
```

</details>

<details>
<summary><strong>Environment Variables</strong></summary>

```bash
TAS_PASSWORD="..."          # Skip password prompts (CI/CD, cron, Docker)
TAS_DATA_DIR="/custom/path" # Override default ~/.tas data directory
```

</details>

---

## 🏗️ Architecture

```
src/
├── cli.js                    # Commander-based CLI — all commands defined here
├── index.js                  # Core streaming upload/download pipeline
├── crypto/
│   └── encryption.js         # AES-256-GCM + PBKDF2-SHA512 (600k iterations)
├── db/
│   └── index.js              # SQLite index: files, chunks, tags, shares, sync
├── telegram/
│   └── client.js             # Bot API wrapper — retry, rate-limit, streaming
├── fuse/
│   └── mount.js              # FUSE filesystem — mount Telegram as a local folder
├── share/
│   └── server.js             # HTTP server — expiring encrypted share links
├── sync/
│   └── sync.js               # fs.watch folder watcher — Dropbox-style auto-sync
└── utils/
    ├── download-stream.js     # Shared Telegram→Decrypt→Decompress pipeline
    ├── compression.js         # Smart gzip (skips already-compressed formats)
    ├── chunker.js             # 49 MB chunks + WAS1 binary file headers
    ├── progress.js            # Terminal progress bars with MB/s + ETA
    ├── throttle.js            # Bandwidth limiter (stream transform)
    ├── branding.js            # ASCII art + version display
    └── cli-helpers.js         # Password management + config resolution
```

**Tech stack:** Node.js 18+ · better-sqlite3 · node-telegram-bot-api · fuse-native · Commander · Chalk · Ora · Inquirer

---

## 💡 Perfect For

| Use Case | Example |
|---|---|
| 📄 **Personal document vault** | Taxes, contracts, scans, receipts — encrypted |
| 🔑 **Secrets & credentials** | `.env` files, SSH private keys, API tokens |
| 🗝️ **Password manager sync** | KeePass `.kdbx`, 1Password vaults, Bitwarden exports |
| 📦 **Code project backups** | Git bundles, build artifacts, config files |
| 🎬 **Private media archive** | Photos, videos, music — encrypted & searchable |
| 🔗 **Ephemeral file sharing** | Burn-after-read links with download limits |
| 💾 **Offsite backup** | Nightly database dumps, system configs via cron |
| 🤖 **CI/CD artifacts** | Store build outputs, test reports, deployment keys |

**Not ideal for:** Mission-critical business data (use professional backup tools alongside this), team collaboration (no multi-user support yet), or replacing full backup systems — **Telegram can theoretically delete old messages.**

---

## ❓ Is This Allowed? (The Legal Question)

### Will Telegram ban me?

**No.** Here's the complete picture:

- ✅ **Bot API is a public, documented feature** — Telegram designed file uploads into the Bot API intentionally
- ✅ **You're sending to your own private bot chat** — not a public channel, not spamming
- ✅ **Content is encrypted** — Telegram cannot detect what you're storing
- ✅ **No published storage limits** — individual files cap at 2 GB (TAS chunks automatically)
- ✅ **Strong precedent** — thousands of file-sharing bots, backup tools, and media archives use this API
- ⚠️ **Worst case** — Telegram might prune old messages to free infrastructure space. They won't ban you for using a documented API

**Your responsibility:** Don't store illegal content. Telegram's ToS prohibits copyright infringement, malware, CSAM, etc. Use responsibly. See [FAQ.md](FAQ.md) for the full legal breakdown.

---

## ⚠️ Good to Know

| | |
|---|---|
| 📌 **Not a replacement for backups** | Telegram can purge old messages. Use TAS alongside, not instead of, real backup solutions. |
| 📌 **49 MB chunk size** | Files are split automatically — fully transparent to you. Telegram's Bot API limit is 50 MB. |
| 📌 **Single-user** | Designed for personal use. No multi-tenant or shared-account support. |
| 📌 **FUSE = Linux/macOS only** | Mount requires `libfuse`. The CLI itself works anywhere Node.js 18+ runs. |
| 📌 **No versioning (yet)** | Overwriting a file replaces the previous version. |
| 📌 **Internet required** | Telegram-backed — offline access requires files pulled locally first. |

---

## 🛠️ Development

```bash
git clone https://github.com/ixchio/tas
cd tas && npm install

npm test               # Run all 71 tests (encryption, WAS1 headers, tags, sync, shares)
npm test -- --watch    # Watch mode for active development
```

**Test coverage:** streaming encrypt/decrypt roundtrips · cross-API compat (buffer↔stream) · small-chunk stress testing · truncation/corruption error paths · Unicode filename handling · WAS1 binary header parsing · timing-safe comparison paths

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## 🌟 Contributing

TAS is open source and contributions are genuinely appreciated:

- 🐛 **Found a bug?** [Open an issue](https://github.com/ixchio/tas/issues) — include `tas doctor` output
- 💡 **Have a feature idea?** [Start a discussion](https://github.com/ixchio/tas/discussions)
- 🔧 **Want to contribute code?** Fork → branch → PR → 🎉
- ⭐ **Just want to help?** A GitHub star dramatically increases discoverability

---

## 📄 License

MIT — use it, fork it, ship it, sell it. Do whatever you want with it.

---

## Related Projects

If TAS fits your workflow, you might also find these useful:

- [rclone](https://github.com/rclone/rclone) — rsync for cloud storage (dozens of backends)
- [restic](https://github.com/restic/restic) — encrypted, deduplicated backup program
- [age](https://github.com/FiloSottile/age) — simple, modern file encryption tool
- [magic-wormhole](https://github.com/magic-wormhole/magic-wormhole) — encrypted file transfer between machines

---

<p align="center">
  <sub>Built with ☕ and stubbornness by <a href="https://github.com/ixchio">@ixchio</a></sub><br>
  <sub>If TAS saved you money, a ⭐ on GitHub is the best way to say thanks — it helps others find the project.</sub><br><br>
  <a href="https://github.com/ixchio/tas/stargazers">
    <img src="https://img.shields.io/github/stars/ixchio/tas?style=for-the-badge&logo=github&label=Star%20TAS&color=ffd700" alt="Star TAS on GitHub">
  </a>
</p>
