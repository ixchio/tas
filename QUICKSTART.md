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

New data uses 19 MiB payload chunks so each stored document remains below the hosted Bot API's documented 20 MB `getFile` limit. Interrupted network-stage uploads can be continued with `tas resume`.

## Recovery

```bash
tas index backup
tas index rebuild
```

TAS updates an authenticated encrypted remote manifest after storage mutations. `rebuild` restores the files/chunks/tags mapping if `index.db` is lost; it cannot help if the manifest message, owning bot, config pointer, or password is also lost.

## Optional multi-bot pool

```bash
tas bot add --name secondary
tas bot list
tas bot disable secondary
```

Multi-bot mode distributes chunks. It is not redundancy, quota assurance, ban protection, or permission to evade Telegram limits.

## Mount support

`tas mount` is supported only on validated Linux/libfuse hosts in this release. Run `tas doctor` first; it performs a real mount/readdir/unmount smoke test. macOS mount is disabled until TAS has a maintained current-macFUSE backend and macOS CI.
