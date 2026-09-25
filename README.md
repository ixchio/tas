<p align="center">
  <img src="assets/demo.gif" alt="TAS — Telegram as Storage CLI demo" width="680">
</p>

<h1 align="center">📦 TAS</h1>

<h3 align="center">
  Encrypted file transport for data you already keep backed up.<br>
  <strong>Local index. Verifiable restores. Explicit provider risk.</strong>
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
  <img src="https://img.shields.io/badge/tests-104%20passing-success" alt="104 Tests Passing">
</p>

<p align="center">
  <a href="QUICKSTART.md"><strong>📚 Quick Start</strong></a> &nbsp;•&nbsp;
  <a href="FAQ.md">FAQ</a> &nbsp;•&nbsp;
  <a href="#why-tas">Why TAS?</a> &nbsp;•&nbsp;
  <a href="#-features">Features</a> &nbsp;•&nbsp;
  <a href="#-security-model">Security</a> &nbsp;•&nbsp;
  <a href="#-cli-reference">CLI Docs</a> &nbsp;•&nbsp;
  <a href="#-docker--cicd">Docker / CI</a> &nbsp;•&nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

> **TAS 3.0** — One `npm install`, one `tas init`, then `tas push yourfile.pdf`. TAS encrypts content locally and sends round-trip-safe chunks through the Bot API. It is experimental transport, not a durable backup service: Telegram can limit, remove, or terminate access. Keep an independent backup.

---

## What TAS Is

TAS is a local-first CLI for moving encrypted file blobs through your own Telegram bots. Its SQLite index lives on your machine; content is encrypted before upload; completed mutations publish an encrypted recovery manifest you can use to rebuild the index.

> **Operating boundary.** TAS is not unlimited storage, a backup guarantee, or a Telegram-supported cloud drive. Telegram provides no TAS quota, retention SLA, recovery service, or account guarantee. Its [Bot Developer Terms](https://telegram.org/tos/bot-developers) also restrict external apps that diverge into cloud-storage use cases. Use TAS only for data that already has an independent backup.

---

## How It Works

**TAS** compresses, encrypts (AES-256-GCM), chunks, and uploads files to private bot chats. Your password stays local. Content, filenames, original sizes, and the recovery manifest are encrypted or omitted from Telegram-visible chunk metadata. Telegram still sees bot/chat identity, timing, chunk count, and encrypted sizes.

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
         SQLite Index                         Remote Bot Messages
```

---

## ⚡ Quick Start

**Three commands to try it. Keep another copy of every file.**

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

## Why TAS?

TAS is for people who want a small, inspectable command-line transport rather than another account, dashboard, or opaque sync daemon. It makes the important state visible and keeps the recovery path in your hands.

- **A local source of truth.** The index is SQLite, paths are exact, and nested directories behave consistently in sync and FUSE.
- **A recovery story.** TAS writes an authenticated, encrypted remote manifest after completed changes; `tas index rebuild` can restore the file-to-message map when the local index is gone.
- **A clean automation surface.** Push, pull, search, tags, sync, and JSON output work from a shell, cron job, or CI runner.
- **Deliberate multi-bot routing.** Each chunk records its owner, so a pool is inspectable and reversible instead of a hidden round-robin trick.
- **No false promise.** The product is precise about the provider boundary: Telegram is not your storage vendor, and multi-bot mode is not a way around its rules.

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

> **Native FUSE is verified, not assumed:** Linux needs `fuse`/`libfuse-dev`. macOS uses current macFUSE and rebuilds the optional native addon against the installed system library on first install. Install Xcode Command Line Tools before TAS, then run `tas doctor`; mount is available only when its real mount → readdir → unmount smoke test passes.

Desktop file managers work with the normal private mount. Samba and other services run under a different local identity, so shared access must be enabled explicitly:

```bash
# Add this exact line to /etc/fuse.conf first: user_allow_other
tas mount /mnt/tg-drive --allow-other
```

`--allow-other` exposes the mount to other local users subject to Unix permissions. Do not enable it on an untrusted multi-user host.

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

### 🤖 Experimental Multi-Bot Pool

TAS can distribute new chunks deterministically across multiple bots and records the owning bot on every chunk. Disabled bots remain configured for reads; a bot cannot be removed while indexed chunks or the recovery manifest depend on it.

```bash
tas bot add --name archive-2       # Interactive token/chat setup + risk acknowledgement
tas bot list                       # IDs, state, chat, and dependent chunk counts
tas bot disable archive-2          # Stop new writes; old chunks remain readable
tas bot enable archive-2
tas bot remove archive-2           # Refuses unless no data depends on it
```

> **Use at your own risk.** Multiple bots do not guarantee more quota, durability, ban avoidance, or Terms compliance. Do not use this feature to evade Telegram limits. All bots remain under Telegram's control, so this is distribution—not redundancy.

### 🧯 Index Recovery

Every completed storage mutation publishes a gzip-compressed, AES-256-GCM-authenticated manifest containing the file/chunk mapping and tags. Ephemeral share tokens are deliberately excluded. The latest pointer is stored in `config.json`.

```bash
tas index backup                 # Publish a fresh encrypted recovery point
tas index rebuild               # Authenticate and rebuild index.db
```

Keep `config.json` and your password separately: recovery cannot discover the latest manifest if both the database and config are lost.

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
# ✓ Config v3 (encrypted multi-bot token set)
# ✓ Database: 42 files, 1.3 GB total across 28 chunks
# ✓ Disk space: 50 GB free (32% used)
# ✓ Encryption: AES-256-GCM · PBKDF2-SHA512 · 600,000 iterations (OWASP 2025)
# ✓ FUSE runtime: mount → readdir → unmount passed
# ✓ Telegram connectivity: 2/2 bots OK
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

TAS applies **client-side authenticated encryption**. TAS has no hosted service that receives your password, but this is not a formal zero-knowledge protocol and it does not hide all traffic metadata from Telegram.

| Layer | Implementation | Standard |
|---|---|---|
| **Cipher** | AES-256-GCM (authenticated encryption) | NIST FIPS 197 |
| **Key Derivation** | PBKDF2-SHA512, **600,000 iterations** | OWASP 2025 |
| **Salt** | 32 bytes, `crypto.randomBytes()` — unique per file | No rainbow tables |
| **IV/Nonce** | 12 bytes, `crypto.randomBytes()` — unique per file | No nonce reuse |
| **Auth Tag** | 16 bytes GCM tag — any tampered bit = instant rejection | Tamper detection |
| **Bot Tokens** | Encrypted independently at rest in `config.json` | Config v3 |
| **Password Verification** | `crypto.timingSafeEqual()` on both PBKDF2 and legacy paths | Timing-safe |
| **Config Permissions** | `chmod 600 config.json` on creation | No world-readable secrets |
| **Recovery Manifest** | gzip + AES-256-GCM; authenticated before SQLite import | Remote index recovery |
| **Integrity** | SHA-256 hash verified on completed downloads | Detects mismatch/corruption |
| **Share Server** | Binds `127.0.0.1` by default, XSS-escaped, RFC 6266 filenames | LAN-safe |

### What Telegram Actually Sees

```
chunk-000000.tas  —  12.4 MB  —  caption: tas:c1:42:1/2
```

New uploads expose no user filename or original size in the document name, caption, or public WAS1 routing header. Telegram can still observe encrypted size, chunk count, timing, bot/chat identity, IP/network data, and message identifiers. Files uploaded by TAS 2.5 and older may still expose filename/size metadata until re-uploaded.

### Threat Model

| Threat | Mitigated? | How |
|---|---|---|
| Telegram reads plaintext content | Mitigated | AES-256-GCM, assuming a strong password and uncompromised client |
| Telegram observes traffic metadata | Not mitigated | Bot/chat, timing, encrypted sizes, and chunk counts remain visible |
| Someone steals `config.json` | Partly mitigated | Tokens are encrypted; an offline password attack is still possible |
| Tampered download | Mitigated | GCM authentication plus final SHA-256 verification |
| Local machine compromise | Not mitigated | A process with password/filesystem access can read plaintext and tokens |
| Share link exposure | Limited | Localhost default, expiry, and download limits; the local server decrypts content |

---

## 🔄 Reliability

Reliability mechanisms implemented by TAS (not an SLA):

| Feature | Implementation |
|---|---|
| **Exponential Backoff** | Auto-retry with jitter on Telegram 429 errors and network timeouts |
| **Rate Limiting** | One serialized send queue per configured bot within a TAS process; parallel TAS processes and Telegram's dynamic limits still apply |
| **Integrity Verification** | SHA-256 hash verified after every single download |
| **Resume Uploads** | Network-stage chunks are staged on disk and persisted in `pending_uploads`; `tas resume` continues them |
| **Index Recovery** | Authenticated encrypted remote manifest; `tas index rebuild` restores file/chunk ownership |
| **Graceful Shutdown** | SIGINT/SIGTERM handled; staged chunks and SQLite WAL reduce partial-state risk |
| **Self-Diagnostics** | Checks config/database/chunk limits, all bots, and a real native FUSE smoke mount |

---

## 📋 CLI Reference

<details>
<summary><strong>Core Commands</strong></summary>

```bash
tas init [--token T --chat ID --password PW]  # 🚀 Wizard, or fully non-interactive for CI/Docker
tas push <files...>               # ⬆️  Encrypt + compress + upload (batch supported)
tas pull <file|hash>              # ⬇️  Download + decrypt + verify
tas list [-l] [--json]            # 📋 List all stored files
tas delete <file|hash>            # 🗑️  Remove from index (--hard removes from Telegram)
tas status [--json]               # 📊 Storage stats & database health
tas search <query> [-t tag]       # 🔍 Find by filename or tag
tas resume                        # 🔄 Resume interrupted uploads
tas verify                        # ✅ Check every Telegram file reference
tas verify --deep                 # ✅ Download/decrypt/hash every file (slow and bandwidth-heavy)
tas doctor                        # 🩺 Full system health check
tas index backup                  # 🧯 Publish encrypted recovery manifest
tas index rebuild                 # 🧯 Restore index.db from that manifest
tas bot add|list|enable|disable|remove  # 🤖 Manage experimental bot pool
```

</details>

<details>
<summary><strong>Mount & Sync</strong></summary>

```bash
# FUSE Mount (Linux/libfuse or macOS/current macFUSE)
tas mount <path>                  # Mount Telegram storage as a local folder
tas mount <path> --allow-other    # Opt in to Samba/service access
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
tas share create <file> [--expire 1h|24h|7d] [--max-downloads N] [--host 0.0.0.0] [--port 3000]
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
├── manifest.js               # Encrypted remote index backup/rebuild
├── crypto/
│   └── encryption.js         # AES-256-GCM + PBKDF2-SHA512 (600k iterations)
├── db/
│   └── index.js              # SQLite index: files, chunks, tags, shares, sync
├── telegram/
│   ├── client.js             # Bot API wrapper — retry + serialized send queue
│   └── pool.js               # Stable per-chunk multi-bot routing
├── fuse/
│   └── mount.js              # FUSE filesystem — mount Telegram as a local folder
├── share/
│   └── server.js             # HTTP server — expiring encrypted share links
├── sync/
│   └── sync.js               # fs.watch folder watcher — Dropbox-style auto-sync
└── utils/
    ├── download-stream.js     # Shared Telegram→Decrypt→Decompress pipeline
    ├── compression.js         # Smart gzip (skips already-compressed formats)
    ├── chunker.js             # 19 MiB payloads + metadata-free public WAS1 headers
    ├── logical-path.js        # Portable exact paths + virtual directory tree
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

**Not appropriate for:** the only copy of any data, mission-critical/business backups, regulated retention, team storage, or workloads that require an SLA. Telegram can remove messages or terminate access without giving TAS a recovery channel.

---

## ❓ Is This Allowed? (The Legal Question)

### Can Telegram restrict or terminate this use?

**Yes.** The Bot API supports sending documents, but that technical capability is not permission or a storage guarantee. Telegram's current [Bot Developer Terms](https://telegram.org/tos/bot-developers) explicitly restrict external applications that diverge into cloud-storage use cases, prohibit circumventing rate limits, and allow bot/account termination. TAS cannot promise that one bot—or a multi-bot pool—will remain available.

Use TAS only at your own risk, do not use multiple bots to evade limits, follow all applicable laws and Telegram terms, and keep a tested independent backup. Encryption protects content confidentiality; it does not make the usage invisible or policy-compliant.

---

## ⚠️ Good to Know

| | |
|---|---|
| 📌 **Not a replacement for backups** | Telegram can purge old messages. Use TAS alongside, not instead of, real backup solutions. |
| 📌 **19 MiB payload chunks** | Hosted Bot API uploads permit more, but `getFile` documents only 20 MB downloads. TAS stays below the read limit. |
| 📌 **Multi-bot is experimental** | It distributes chunks and preserves ownership mapping; it is not redundancy or ban protection. |
| 📌 **macOS needs a native build** | Install current macFUSE and Xcode Command Line Tools before installing TAS. `tas doctor` must pass its real FUSE smoke test before you mount data. |
| 📌 **Recovery needs config** | `index.db` can be rebuilt from the encrypted manifest only if `config.json`, password, manifest message, and owning bot survive. |
| 📌 **No versioning (yet)** | Overwriting a file replaces the previous version. |
| 📌 **Internet required** | Telegram-backed — offline access requires files pulled locally first. |

---

## 🛠️ Development

```bash
git clone https://github.com/ixchio/tas
cd tas && npm install

npm test               # Run all 97 tests (crypto, paths, migrations, multi-bot, resume, manifest, sync, shares)
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
