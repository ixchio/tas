# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.1.x   | :white_check_mark: |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Security Model

TAS uses industry-standard encryption:

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: PBKDF2 with SHA-512, 100,000 iterations
- **Salt**: 32 bytes, random per file
- **IV**: 12 bytes, random per file
- **Auth Tag**: 16 bytes for integrity verification

Your password never leaves your machine. Telegram only stores encrypted blobs.

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
- **Password storage**: Password hash is stored locally for verification (not the password itself)
- **Metadata**: Filenames and sizes are stored in local SQLite (unencrypted locally)

## Best Practices

1. Use a strong, unique password (12+ characters)
2. Don't share your `data/config.json` file
3. Keep your bot token secret
4. Regularly update to the latest version
