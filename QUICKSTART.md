# TAS 3 Quick Start

TAS is experimental encrypted file transport over Telegram bots. It is not an unlimited-storage or durability service. Telegram can limit or terminate access, and its current [Bot Developer Terms](https://telegram.org/tos/bot-developers) restrict external cloud-storage use cases. Use TAS at your own risk and keep an independent backup.

## Install and initialize

```bash
npm install -g @nightowne/tas-cli
tas init
tas doctor --password "$TAS_PASSWORD"
```

`tas init` creates config v3 in `~/.tas/config.json`, encrypts the bot token with your TAS password, and creates the local SQLite index. Keep `config.json` and the password separately; both are needed for remote-manifest recovery.

## Push, list, and pull

```bash
tas push ./report.pdf
tas list --long
tas pull report.pdf ./restored-report.pdf
tas verify
```

New data uses 19 MiB payload chunks so each stored document remains below the hosted Bot API's documented 20 MB `getFile` limit. Interrupted network-stage uploads can be continued with `tas resume --yes`.

## Folder sync and automatic recovery

```bash
tas sync add ~/Documents
tas sync start
```

Sync startup resumes recoverable staged uploads before scanning the folder. It reports discovery and verification progress for large trees, and Ctrl+C stops it during startup or watch mode. It also removes TAS staging directories only when they are unreferenced and at least 24 hours old. Use `--no-resume` to defer recovery.

For systemd or another headless service, keep the password out of the command line:

```bash
mkdir -p ~/.config/tas
install -m 600 /dev/null ~/.config/tas/password
printf '%s\n' 'your-password' > ~/.config/tas/password
tas sync start --password-file ~/.config/tas/password
```

## Recovery

```bash
tas index backup
tas index rebuild
```

TAS updates an authenticated encrypted remote manifest after storage mutations. `rebuild` restores the files/chunks/tags mapping if `index.db` is lost; it cannot help if the manifest message, owning bot, config pointer, or password is also lost.

## Legacy reads

Old TAS uploads can contain chunks above the hosted Bot API download limit. Run `tas doctor` to identify them. A local Bot API server can read those chunks after you configure the owning bot:

```bash
tas bot endpoint http://127.0.0.1:8081 --bot primary --password "$TAS_PASSWORD"
tas index repair
```

`tas index repair --remove-zero-chunk` removes only local records with no chunk metadata and always asks for confirmation. Partial records remain available for manual recovery or an index rebuild.

## Optional multi-bot pool

```bash
tas bot add --name secondary
tas bot list
tas bot disable secondary
```

Multi-bot mode distributes chunks. It is not redundancy, quota assurance, ban protection, or permission to evade Telegram limits.

## Mount support

`tas mount` needs a native FUSE runtime. On Linux install `fuse` and `libfuse-dev`. On macOS install current macFUSE and Xcode Command Line Tools before installing TAS; TAS rebuilds its optional native addon against the installed macFUSE library. Run `tas doctor` first and mount only when its real mount/readdir/unmount smoke test passes.

For Samba or another service account, add `user_allow_other` to `/etc/fuse.conf` and mount with `tas mount /mnt/tg-drive --allow-other`. Shared access is opt-in because it exposes the mount to other local users subject to Unix permissions.
