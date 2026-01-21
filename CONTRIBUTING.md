# Contributing to TAS

Thanks for your interest in contributing! Here's how you can help.

## Quick Start

```bash
git clone https://github.com/ixchio/tas
cd tas
npm install
npm test  # 28 tests should pass
```

## Ways to Contribute

### Report Bugs
- Open an issue with steps to reproduce
- Include your Node.js version and OS

### Suggest Features
- Open an issue with the `enhancement` label
- Explain the use case

### Submit Code
1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Commit (`git commit -m 'Add amazing feature'`)
6. Push (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## Code Style

- Use ES modules (`import`/`export`)
- 4-space indentation
- Meaningful variable names
- Add JSDoc comments for public functions

## Testing

```bash
npm test
```

All tests must pass before merging.

## Project Structure

```
src/
├── cli.js           # CLI commands
├── index.js         # Upload/download pipeline
├── crypto/          # AES-256-GCM encryption
├── db/              # SQLite file index
├── fuse/            # FUSE mount
├── sync/            # Folder sync engine
├── telegram/        # Bot API client
└── utils/           # Compression, chunking, progress
```

## Questions?

Open an issue or reach out on GitHub.
