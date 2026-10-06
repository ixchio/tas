# TAS 3 FAQ

## Is storage unlimited or guaranteed?

No. Telegram gives TAS no storage quota, retention SLA, durability promise, or recovery service. Keep another tested copy.

## Can Telegram restrict or ban this use?

Yes. A documented upload method is not a guarantee that a cloud-storage-style application is permitted. Telegram's current [Bot Developer Terms](https://telegram.org/tos/bot-developers) restrict divergent cloud-storage use cases and rate-limit circumvention. Multi-bot mode does not remove that risk.

## Why are chunks 19 MiB when uploads allow more?

The hosted Bot API documents a larger upload allowance than its `getFile` download allowance. TAS keeps the payload at 19 MiB plus its 64-byte public routing header so newly uploaded chunks remain below the documented 20 MB read limit.

## How do I read old chunks that exceed 20 MB?

Run `tas doctor` first. If it reports oversized legacy chunks, operate a local Telegram Bot API server and configure the bot that owns those chunks with `tas bot endpoint http://127.0.0.1:8081 --bot primary --password "$TAS_PASSWORD"`. The server receives the bot token and file traffic, so use one you administer. `tas index repair` identifies old records with no or incomplete chunk metadata.

## What metadata can Telegram see?

For new TAS 3 uploads, file content, user filename, original size, and remote recovery manifest contents are encrypted or omitted from public chunk fields. Telegram still observes bot/chat identity, timing, IP/network information, chunk count, encrypted sizes, message IDs, and generic TAS protocol captions. TAS 2.x chunks may contain filenames and original sizes in their legacy headers/captions.

## Is TAS zero-knowledge?

TAS uses client-side AES-256-GCM and has no hosted TAS service, but it is not a formally analyzed zero-knowledge protocol and does not hide traffic metadata. Use a strong unique password and protect the local machine.

## What happens if `index.db` is lost?

Run `tas index rebuild`. It downloads and authenticates the latest encrypted remote manifest referenced by `config.json`. Recovery still requires the password, config pointer, owning bot, and manifest message.

## Do I need to run `tas resume` after every failed sync upload?

No in TAS 3.1. `tas sync start` resumes valid staged uploads before its initial scan and repairs the matching local sync state after completion. Damaged staging is reported without sending more chunks. Use `tas resume` for an interactive view, `tas resume --yes` for scripts, or `tas resume --clear` when you intentionally want to discard pending work.

## Why are temporary chunks still on disk?

They are the durable state that makes upload recovery possible. Completed uploads remove their chunks immediately. Sync startup also prunes TAS-owned staging directories that are unreferenced by SQLite and older than 24 hours; it does not touch active, referenced, or unrelated directories.

## Does multi-bot mode provide redundancy?

No. Each chunk has one owning bot. TAS records that bot so reads and deletes route correctly, but all bots remain controlled by Telegram. A disabled bot stays configured for old chunks; removal is refused while chunks or the manifest depend on it.

## Does mount work on macOS?

Yes with current macFUSE, Xcode Command Line Tools, and a locally rebuilt native addon. TAS never installs or replaces macFUSE; its install hook selects the system `libfuse` and compiles the optional addon for the active CPU. Run `tas doctor` before use. If the real mount/readdir/unmount smoke test does not pass, do not mount data.

## Why can I list a mount locally but not open its Samba share?

FUSE mounts are private to the mounting user by default. Add `user_allow_other` to `/etc/fuse.conf`, then mount with `tas mount /mnt/tg-drive --allow-other`. TAS keeps this opt-in because it grants other local users and services access subject to Unix permissions. Version 3.0.3 also implements the filesystem statistics, directory handles, sync operations, and extended attributes expected by desktop and SMB clients.
