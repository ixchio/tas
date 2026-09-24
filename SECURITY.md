# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.x.x   | :white_check_mark: |
| 2.x.x   | Security fixes only |
| 1.1.x   | :x:                |
| 1.0.x   | :x:                |
| < 1.0   | :x:                |

## Security Model

TAS uses industry-standard encryption:

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: PBKDF2 with SHA-512, 600,000 iterations (OWASP 2025 recommendation)
- **Salt**: 32 bytes, random per file
- **IV**: 12 bytes (96-bit), random per file
- **Auth Tag**: 16 bytes (128-bit) for integrity verification
- **Config v3**: Every bot token is encrypted at rest with the user's password (AES-256-GCM)
- **Remote manifest**: File/chunk ownership and tags are gzip-compressed, AES-256-GCM encrypted, and authenticated before rebuild
- **Public chunk metadata**: New uploads omit user filename and original size; legacy 2.x chunks may still expose them
- **Password verification**: PBKDF2-based hash stored locally (not the password itself)

TAS has no hosted service that receives your password. Telegram stores encrypted blobs but still observes traffic metadata including bot/chat identity, timing, encrypted sizes, chunk counts, IP/network data, and message identifiers. This is client-side encryption, not a formal zero-knowledge protocol.

## Reporting a Vulnerability

If you discover a security vulnerability, please:

1. **Do NOT** open a public issue
2. Email security concerns to the maintainer privately
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We aim to respond within 48 hours and will work with you to understand and resolve the issue.

## Known Limitations

- **Not a backup solution**: Telegram can delete content without notice
- **Provider/policy risk**: Telegram can limit or terminate bot/account access; multi-bot mode does not mitigate this
- **Password storage**: Password hash is stored locally for verification (not the password itself)
- **Metadata**: Filenames and sizes are stored in local SQLite (unencrypted locally)
- **Recovery dependency**: Index rebuild requires config.json, password, manifest message, and its owning bot
- **Legacy metadata**: TAS 2.x Telegram chunks/captions may contain filenames and original sizes
- **Share server**: HTTP-only; file content is encrypted but share page metadata is not TLS-protected

## Best Practices

1. Use a strong, unique password (12+ characters)
2. Don't share your `~/.tas/config.json` file
3. Keep your bot token secret
4. Regularly update to the latest version
5. When using `tas share`, prefer running behind a reverse proxy with TLS
