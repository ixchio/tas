# TAS 3 FAQ

## Is storage unlimited or guaranteed?

No. Telegram gives TAS no storage quota, retention SLA, durability promise, or recovery service. Keep another tested copy.

## Can Telegram restrict or ban this use?

Yes. A documented upload method is not a guarantee that a cloud-storage-style application is permitted. Telegram's current [Bot Developer Terms](https://telegram.org/tos/bot-developers) restrict divergent cloud-storage use cases and rate-limit circumvention. Multi-bot mode does not remove that risk.

## Why are chunks 19 MiB when uploads allow more?

The hosted Bot API documents a larger upload allowance than its `getFile` download allowance. TAS keeps the payload at 19 MiB plus its 64-byte public routing header so newly uploaded chunks remain below the documented 20 MB read limit.

## What metadata can Telegram see?

For new TAS 3 uploads, file content, user filename, original size, and remote recovery manifest contents are encrypted or omitted from public chunk fields. Telegram still observes bot/chat identity, timing, IP/network information, chunk count, encrypted sizes, message IDs, and generic TAS protocol captions. TAS 2.x chunks may contain filenames and original sizes in their legacy headers/captions.

## Is TAS zero-knowledge?

TAS uses client-side AES-256-GCM and has no hosted TAS service, but it is not a formally analyzed zero-knowledge protocol and does not hide traffic metadata. Use a strong unique password and protect the local machine.

## What happens if `index.db` is lost?

Run `tas index rebuild`. It downloads and authenticates the latest encrypted remote manifest referenced by `config.json`. Recovery still requires the password, config pointer, owning bot, and manifest message.

## Does multi-bot mode provide redundancy?

No. Each chunk has one owning bot. TAS records that bot so reads and deletes route correctly, but all bots remain controlled by Telegram. A disabled bot stays configured for old chunks; removal is refused while chunks or the manifest depend on it.

## Does mount work on macOS?

Yes with current macFUSE, Xcode Command Line Tools, and a locally rebuilt native addon. TAS never installs or replaces macFUSE; its install hook selects the system `libfuse` and compiles the optional addon for the active CPU. Run `tas doctor` before use. If the real mount/readdir/unmount smoke test does not pass, do not mount data.

## Why can I list a mount locally but not open its Samba share?

FUSE mounts are private to the mounting user by default. Add `user_allow_other` to `/etc/fuse.conf`, then mount with `tas mount /mnt/tg-drive --allow-other`. TAS keeps this opt-in because it grants other local users and services access subject to Unix permissions. Version 3.0.3 also implements the filesystem statistics, directory handles, sync operations, and extended attributes expected by desktop and SMB clients.
