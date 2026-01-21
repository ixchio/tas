# 📦 TAS - Use Telegram as Your Cloud Storage

> **Free. Encrypted. Unlimited.** Stop paying for cloud storage.

```
████████╗ █████╗ ███████╗
╚══██╔══╝██╔══██╗██╔════╝
   ██║   ███████║███████╗
   ██║   ██╔══██║╚════██║
   ██║   ██║  ██║███████║
   ╚═╝   ╚═╝  ╚═╝╚══════╝
```

I got tired of paying $10/month for cloud storage. So I built this.

**TAS turns your Telegram bot into unlimited cloud storage.** Files are encrypted with AES-256 before upload — not even Telegram can read them.

The killer feature? **Mount it as a folder.** Drag and drop files like it's Google Drive, but it's actually your private Telegram chat.

---

## ⚡ TL;DR

```bash
npm install -g @nightowne/tas-cli
tas init
tas mount ~/cloud
# Now use ~/cloud like any folder. Files go to Telegram.
```

---

## 🤔 Why?

| | TAS | Google Drive | Dropbox |
|---|:---:|:---:|:---:|
| **Price** | Free forever | $10/mo after 15GB | $12/mo after 2GB |
| **Storage** | Unlimited | Limited | Limited |
| **E2E Encrypted** | ✅ | ❌ | ❌ |
| **Mounts as folder** | ✅ | ❌ | ❌ |
| **Your data, your control** | ✅ | ❌ | ❌ |

---

## 🚀 Quick Start

### 1. Get a Telegram Bot (30 seconds)
- Message [@BotFather](https://t.me/BotFather) on Telegram
- Send `/newbot`, pick a name
- Copy the token

### 2. Install & Setup
```bash
npm install -g tas-cli
tas init
# Paste token, set password, message your bot
```

### 3. Use It
```bash
# Upload files
tas push secret.pdf

# Mount as a folder (the magic ✨)
tas mount ~/cloud
cp anything.zip ~/cloud/      # uploads to Telegram
open ~/cloud/secret.pdf       # downloads from Telegram
```

---

## � The Folder Thing

This is the part that makes TAS different. Run `tas mount ~/cloud` and you get a folder that:

- **Looks normal** in your file manager
- **Drag & drop** = upload to Telegram
- **Open files** = download from Telegram
- **Delete files** = removes from Telegram

It's like Dropbox, except free and you own your data.

```bash
$ ls ~/cloud
secret.pdf  photos.zip  notes.txt

$ cp newfile.doc ~/cloud/
# Compresses → Encrypts → Uploads to Telegram
```

---

## 🏷️ Organize with Tags

```bash
tas tag add report.pdf work finance
tas tag list work           # shows all "work" files
tas tag remove report.pdf finance
```

---

## 🔄 Auto-Sync Folders

Dropbox-style sync. Any changes in the folder → auto-upload to Telegram.

```bash
tas sync add ~/Documents/work
tas sync start
# Now any file changes auto-sync to Telegram
```

Two-way sync:
```bash
tas sync pull    # Download everything from Telegram → local
```

---

## �️ Security

- **AES-256-GCM** encryption
- **PBKDF2** key derivation (100k iterations)
- **Random IV** per file
- Password never stored (only hash for verification)

Your files are encrypted **before** they leave your computer. Telegram sees gibberish.

---

## 📖 All Commands

```bash
tas init                 # Setup
tas push <file>          # Upload
tas pull <file>          # Download
tas list                 # List files
tas delete <file>        # Remove
tas mount <folder>       # 🔥 Mount as folder
tas unmount <folder>     # Unmount
tas tag add/remove/list  # Tags
tas sync add/start/pull  # Folder sync
tas verify               # Check file integrity
tas status               # Stats
```

---

## ⚙️ Auto-Start on Boot

Want sync running 24/7? Check out [systemd/README.md](systemd/README.md) for the setup.

---

## 🧪 Development

```bash
git clone https://github.com/ixchio/tas
cd tas
npm install
npm test  # 28 tests
```

---

## 📝 License

MIT — do whatever you want.

---

**Made because cloud storage shouldn't cost money.** ☁️

If this saved you some subscription fees, star the repo ⭐
