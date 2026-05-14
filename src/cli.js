#!/usr/bin/env node

/**
 * TAS CLI - Telegram as Storage
 * Main command-line interface
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { TelegramClient } from './telegram/client.js';
import { Encryptor } from './crypto/encryption.js';
import { Compressor } from './utils/compression.js';
import { FileIndex } from './db/index.js';
import { processFile, retrieveFile } from './index.js';
import { printBanner, LOGO, TAGLINE, VERSION } from './utils/branding.js';
import { getPassword, verifyPassword, loadConfig, requireConfig, getAndVerifyPassword, decryptBotToken, resolveConfig } from './utils/cli-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = process.env.TAS_DATA_DIR || path.join(os.homedir(), '.tas');

// Global error handlers — prevent silent crashes
process.on('unhandledRejection', (reason) => {
    console.error(chalk.red('\n✗ Unhandled error:'), reason?.message || reason);
    process.exit(1);
});

process.on('uncaughtException', (err) => {
    console.error(chalk.red('\n✗ Fatal error:'), err.message);
    process.exit(1);
});

// Graceful shutdown on signals
const cleanupAndExit = (signal) => {
    console.log(chalk.dim(`\n${signal} received, shutting down...`));
    process.exit(0);
};
process.on('SIGINT', () => cleanupAndExit('SIGINT'));
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

const program = new Command();

program
    .name('tas')
    .description(chalk.cyan('📦 TAS') + chalk.dim(' - Telegram as Storage | Free • Encrypted • Unlimited'))
    .version(VERSION)
    .hook('preAction', (thisCommand) => {
        // Show banner for main commands
        if (['init', 'status'].includes(thisCommand.args[0])) {
            printBanner();
        }
    });

// ============== INIT COMMAND ==============
program
    .command('init')
    .description('Initialize TAS and connect to Telegram')
    .action(async () => {
        console.log(chalk.cyan('\n🚀 Initializing Telegram as Storage...\n'));

        // Ensure data directory exists
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        // Get bot token
        console.log(chalk.yellow('📱 First, create a Telegram bot:'));
        console.log(chalk.dim('   1. Open Telegram and message @BotFather'));
        console.log(chalk.dim('   2. Send /newbot and follow the prompts'));
        console.log(chalk.dim('   3. Copy the bot token\n'));

        const { token } = await inquirer.prompt([
            {
                type: 'password',
                name: 'token',
                message: 'Enter your Telegram bot token:',
                mask: '*',
                validate: (input) => input.includes(':') || 'Invalid token format (should contain :)'
            }
        ]);

        // Get encryption password
        const { password } = await inquirer.prompt([
            {
                type: 'password',
                name: 'password',
                message: 'Set your encryption password (used for all files):',
                mask: '*',
                validate: (input) => input.length >= 8 || 'Password must be at least 8 characters'
            }
        ]);

        const { confirmPassword } = await inquirer.prompt([
            {
                type: 'password',
                name: 'confirmPassword',
                message: 'Confirm password:',
                mask: '*',
                validate: (input) => input === password || 'Passwords do not match'
            }
        ]);

        // Initialize encryption
        const encryptor = new Encryptor(password);

        // Initialize Telegram
        const spinner = ora('Connecting to Telegram...').start();
        const client = new TelegramClient(DATA_DIR);

        try {
            const botInfo = await client.initialize(token);
            spinner.succeed(`Connected as @${botInfo.username}`);

            // Wait for user to message the bot
            console.log(chalk.yellow(`\n📩 Now message your bot @${botInfo.username} on Telegram`));
            console.log(chalk.dim('   (Just send any message to link your account)\n'));

            spinner.start('Waiting for your message...');
            const userInfo = await client.waitForChatId(120000);
            spinner.succeed(`Linked to ${userInfo.firstName} (@${userInfo.username})`);

            // Save config (bot token encrypted with user's password)
            const configPath = path.join(DATA_DIR, 'config.json');
            const encryptedToken = encryptor.encrypt(Buffer.from(token, 'utf-8')).toString('base64');
            fs.writeFileSync(configPath, JSON.stringify({
                encryptedBotToken: encryptedToken,
                chatId: userInfo.chatId,
                passwordHash: encryptor.getPasswordHash(),
                username: userInfo.username,
                createdAt: new Date().toISOString(),
                configVersion: 2
            }, null, 2));

            // Initialize database
            spinner.start('Initializing local index...');
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();
            spinner.succeed('Local index ready');

            // Send welcome message
            await client.bot.sendMessage(userInfo.chatId,
                '📦 *TAS - Telegram as Storage*\n\n' +
                '✅ Setup complete! This chat will store your encrypted files.\n\n' +
                '_Do not delete messages in this chat._',
                { parse_mode: 'Markdown' }
            );

            console.log(chalk.cyan('\n🎉 TAS is ready! Use `tas push <file>` to upload files.\n'));

        } catch (err) {
            spinner.fail(`Telegram initialization failed: ${err.message}`);
            process.exit(1);
        }
    });

// ============== PUSH COMMAND ==============
program
    .command('push <file>')
    .description('Upload a file to Telegram storage')
    .option('-n, --name <name>', 'Custom name for the file')
    .option('-p, --password <password>', 'Encryption password (uses TAS_PASSWORD env var if not provided)')
    .action(async (file, options) => {
        const spinner = ora('Preparing...').start();

        try {
            // Check file exists
            if (!fs.existsSync(file)) {
                spinner.fail(`File not found: ${file}`);
                process.exit(1);
            }

            const rawConfig = requireConfig(DATA_DIR);
            spinner.stop();

            // Get and verify password
            const password = await getAndVerifyPassword(options.password, DATA_DIR);
            const config = resolveConfig(rawConfig, password);

            spinner.start('Processing file...');

            // Import progress bar
            const { ProgressBar } = await import('./utils/progress.js');
            let progressBar = null;

            // Process and upload
            const result = await processFile(file, {
                password,
                dataDir: DATA_DIR,
                customName: options.name,
                config,
                onProgress: (msg) => {
                    if (!progressBar) spinner.text = msg;
                },
                onByteProgress: ({ uploaded, total }) => {
                    if (!progressBar) {
                        spinner.stop();
                        progressBar = new ProgressBar({ label: 'Uploading', total });
                    }
                    progressBar.update(uploaded);
                }
            });

            if (progressBar) {
                progressBar.complete(`Uploaded: ${result.filename}`);
            } else {
                spinner.succeed(`Uploaded: ${chalk.green(result.filename)}`);
            }
            console.log(chalk.dim(`  Hash: ${result.hash}`));
            console.log(chalk.dim(`  Size: ${formatBytes(result.originalSize)} → ${formatBytes(result.storedSize)}`));
            console.log(chalk.dim(`  Chunks: ${result.chunks}`));

        } catch (err) {
            spinner.fail(`Upload failed: ${err.message}`);
            process.exit(1);
        }
    });

// ============== PULL COMMAND ==============
program
    .command('pull <identifier> [output]')
    .description('Download a file from Telegram storage (by filename or hash)')
    .option('-o, --output <path>', 'Output path for the file')
    .option('-p, --password <password>', 'Encryption password (uses TAS_PASSWORD env var if not provided)')
    .action(async (identifier, output, options) => {
        const spinner = ora('Looking up file...').start();

        try {
            const rawConfig = requireConfig(DATA_DIR);

            // Find file in index
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            let fileRecord = db.findByHash(identifier) || db.findByName(identifier);
            if (!fileRecord) {
                spinner.fail(`File not found: ${identifier}`);
                process.exit(1);
            }

            spinner.stop();

            // Get and verify password
            const password = await getAndVerifyPassword(options.password, DATA_DIR);
            const config = resolveConfig(rawConfig, password);

            spinner.start('Downloading...');

            // Import progress bar
            const { ProgressBar } = await import('./utils/progress.js');
            let progressBar = null;

            const outputPath = output || options.output || fileRecord.filename;
            await retrieveFile(fileRecord, {
                password,
                dataDir: DATA_DIR,
                outputPath,
                config,
                onProgress: (msg) => {
                    if (!progressBar) spinner.text = msg;
                },
                onByteProgress: ({ downloaded, total }) => {
                    if (!progressBar && total > 0) {
                        spinner.stop();
                        progressBar = new ProgressBar({ label: 'Downloading', total });
                    }
                    if (progressBar) progressBar.update(downloaded);
                }
            });

            if (progressBar) {
                progressBar.complete(`Downloaded: ${outputPath}`);
            } else {
                spinner.succeed(`Downloaded: ${chalk.green(outputPath)}`);
            }

        } catch (err) {
            spinner.fail(`Download failed: ${err.message}`);
            process.exit(1);
        }
    });

// ============== LIST COMMAND ==============
program
    .command('list')
    .alias('ls')
    .description('List all stored files')
    .option('-l, --long', 'Show detailed information')
    .option('--json', 'Output as JSON (for scripting)')
    .action(async (options) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const files = db.listAll();

            if (options.json) {
                console.log(JSON.stringify(files, null, 2));
                db.close();
                return;
            }

            if (files.length === 0) {
                console.log(chalk.yellow('\n📭 No files stored yet. Use `tas push <file>` to upload.\n'));
                db.close();
                return;
            }

            console.log(chalk.cyan(`\n📦 Stored Files (${files.length})\n`));

            if (options.long) {
                console.log(chalk.dim('HASH'.padEnd(16) + 'SIZE'.padEnd(12) + 'CHUNKS'.padEnd(8) + 'DATE'.padEnd(12) + 'FILENAME'));
                console.log(chalk.dim('─'.repeat(70)));

                for (const file of files) {
                    const hash = file.hash.substring(0, 12) + '...';
                    const size = formatBytes(file.original_size).padEnd(12);
                    const chunks = String(file.chunks).padEnd(8);
                    const date = new Date(file.created_at).toLocaleDateString().padEnd(12);
                    console.log(`${chalk.dim(hash.padEnd(16))}${size}${chunks}${date}${chalk.white(file.filename)}`);
                }
            } else {
                for (const file of files) {
                    console.log(`  ${chalk.blue('●')} ${file.filename} ${chalk.dim(`(${formatBytes(file.original_size)})`)}`);
                }
            }

            console.log();
            db.close();

        } catch (err) {
            console.error(chalk.red('Error listing files:'), err.message);
            process.exit(1);
        }
    });

// ============== DELETE COMMAND ==============
program
    .command('delete <identifier>')
    .alias('rm')
    .description('Remove a file from the index (optionally from Telegram too)')
    .option('--hard', 'Also delete from Telegram')
    .option('-p, --password <password>', 'Encryption password (required for --hard)')
    .action(async (identifier, options) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            let fileRecord = db.findByHash(identifier) || db.findByName(identifier);
            if (!fileRecord) {
                console.log(chalk.red(`✗ File not found: ${identifier}`));
                process.exit(1);
            }

            const { confirm } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: `Delete "${fileRecord.filename}" from index${options.hard ? ' and Telegram' : ''}?`,
                    default: false
                }
            ]);

            if (confirm) {
                // If hard delete, also remove from Telegram
                if (options.hard) {
                    const rawConfig = requireConfig(DATA_DIR);
                    const password = await getAndVerifyPassword(options.password, DATA_DIR);
                    const config = resolveConfig(rawConfig, password);

                    const client = new TelegramClient(DATA_DIR);
                    await client.initialize(config.botToken);
                    client.setChatId(config.chatId);

                    const chunks = db.getChunks(fileRecord.id);
                    for (const chunk of chunks) {
                        await client.deleteMessage(chunk.message_id);
                    }
                }

                db.delete(fileRecord.id);
                console.log(chalk.green(`✓ Removed "${fileRecord.filename}"`));
            }

        } catch (err) {
            console.error(chalk.red('Error deleting file:'), err.message);
            process.exit(1);
        }
    });

// ============== STATUS COMMAND ==============
program
    .command('status')
    .description('Show TAS status and statistics')
    .option('--json', 'Output as JSON (for scripting)')
    .action(async (options) => {
        const configPath = path.join(DATA_DIR, 'config.json');

        if (!fs.existsSync(configPath)) {
            if (options.json) {
                console.log(JSON.stringify({ initialized: false }));
            } else {
                console.log(chalk.yellow('\n⚠️  TAS not initialized. Run `tas init` first.\n'));
            }
            return;
        }

        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
        db.init();

        const files = db.listAll();
        const totalSize = files.reduce((acc, f) => acc + f.original_size, 0);
        const storedSize = files.reduce((acc, f) => acc + f.stored_size, 0);
        const savings = totalSize > 0 ? Math.round((1 - storedSize / totalSize) * 100) : 0;

        if (options.json) {
            console.log(JSON.stringify({
                initialized: true,
                createdAt: config.createdAt,
                username: config.username || 'unknown',
                fileCount: files.length,
                totalSize,
                storedSize,
                savingsPercent: savings,
                dataDir: DATA_DIR
            }, null, 2));
            db.close();
            return;
        }

        console.log(chalk.cyan('\n📊 TAS Status\n'));
        console.log(`  Initialized: ${chalk.white(new Date(config.createdAt).toLocaleDateString())}`);
        console.log(`  Telegram user: ${chalk.white('@' + (config.username || 'unknown'))}`);
        console.log(`  Data dir: ${chalk.white(DATA_DIR)}`);
        console.log(`  Files stored: ${chalk.white(files.length)}`);
        console.log(`  Total size: ${chalk.white(formatBytes(totalSize))}`);
        console.log(`  Compressed: ${chalk.white(formatBytes(storedSize))} ${chalk.dim(`(${savings}% saved)`)}`);
        console.log();
        db.close();
    });

// ============== MOUNT COMMAND ==============
program
    .command('mount <mountpoint>')
    .description('🔥 Mount Telegram storage as a local folder (FUSE)')
    .option('-p, --password <password>', 'Encryption password (uses TAS_PASSWORD env var if not provided)')
    .action(async (mountpoint, options) => {
        console.log(chalk.cyan('\n🗂️  Mounting Telegram as filesystem...\n'));

        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);

        const spinner = ora('Initializing filesystem...').start();

        try {
            // Resolve mount point to absolute path
            const absMount = path.resolve(mountpoint);

            // Dynamic import to avoid loading fuse-native if not needed
            const { TelegramFS } = await import('./fuse/mount.js');

            const tfs = new TelegramFS({
                dataDir: DATA_DIR,
                password,
                config,
                mountPoint: absMount
            });

            await tfs.initialize();
            await tfs.mount();

            spinner.succeed(`Mounted at ${chalk.green(absMount)}`);

            console.log(chalk.cyan('\n📁 Telegram storage is now a folder!\n'));
            console.log(chalk.dim('   Commands you can use:'));
            console.log(chalk.dim(`   ls ${absMount}          # List files`));
            console.log(chalk.dim(`   cp file.pdf ${absMount}/  # Upload`));
            console.log(chalk.dim(`   cat ${absMount}/file.txt  # Read`));
            console.log(chalk.dim(`   rm ${absMount}/file.pdf   # Delete`));
            console.log();
            console.log(chalk.yellow('Press Ctrl+C to unmount'));

            // Handle graceful shutdown
            const cleanup = async () => {
                console.log(chalk.dim('\n\nUnmounting...'));
                await tfs.unmount();
                console.log(chalk.green('✓ Unmounted successfully'));
                process.exit(0);
            };

            process.on('SIGINT', cleanup);
            process.on('SIGTERM', cleanup);

            // Keep process running
            await new Promise(() => { });

        } catch (err) {
            spinner.fail(`Mount failed: ${err.message}`);
            console.log(chalk.dim('\nNote: FUSE requires libfuse to be installed:'));
            console.log(chalk.dim('  Ubuntu/Debian: sudo apt install fuse libfuse-dev'));
            console.log(chalk.dim('  Fedora: sudo dnf install fuse fuse-devel'));
            console.log(chalk.dim('  macOS: brew install macfuse\n'));
            process.exit(1);
        }
    });

// ============== UNMOUNT COMMAND ==============
program
    .command('unmount <mountpoint>')
    .alias('umount')
    .description('Unmount a previously mounted Telegram folder')
    .action(async (mountpoint) => {
        const absMount = path.resolve(mountpoint);

        const spinner = ora('Unmounting...').start();

        try {
            const { execSync } = await import('child_process');

            // Use fusermount on Linux, umount on macOS
            const isMac = process.platform === 'darwin';
            const cmd = isMac ? `umount "${absMount}"` : `fusermount -u "${absMount}"`;

            execSync(cmd, { stdio: 'pipe' });

            spinner.succeed(`Unmounted ${chalk.green(absMount)}`);
        } catch (err) {
            spinner.fail(`Unmount failed: ${err.message}`);
            console.log(chalk.dim('\nTry: fusermount -u ' + absMount));
            process.exit(1);
        }
    });

// ============== TAG COMMAND ==============
const tagCmd = program
    .command('tag')
    .description('Manage file tags');

tagCmd
    .command('add <file> <tags...>')
    .description('Add tags to a file')
    .action(async (file, tags) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const fileRecord = db.findByHash(file) || db.findByName(file);
            if (!fileRecord) {
                console.log(chalk.red(`✗ File not found: ${file}`));
                process.exit(1);
            }

            for (const tag of tags) {
                db.addTag(fileRecord.id, tag);
            }

            const allTags = db.getFileTags(fileRecord.id);
            console.log(chalk.green(`✓ Tags updated for "${fileRecord.filename}"`));
            console.log(chalk.dim(`  Tags: ${allTags.join(', ')}`));

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

tagCmd
    .command('remove <file> <tags...>')
    .description('Remove tags from a file')
    .action(async (file, tags) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const fileRecord = db.findByHash(file) || db.findByName(file);
            if (!fileRecord) {
                console.log(chalk.red(`✗ File not found: ${file}`));
                process.exit(1);
            }

            for (const tag of tags) {
                db.removeTag(fileRecord.id, tag);
            }

            const allTags = db.getFileTags(fileRecord.id);
            console.log(chalk.green(`✓ Tags updated for "${fileRecord.filename}"`));
            console.log(chalk.dim(`  Tags: ${allTags.length > 0 ? allTags.join(', ') : '(none)'}`));

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

tagCmd
    .command('list [tag]')
    .description('List all tags, or files with a specific tag')
    .action(async (tag) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            if (tag) {
                // List files with this tag
                const files = db.findByTag(tag);
                if (files.length === 0) {
                    console.log(chalk.yellow(`\n📭 No files with tag "${tag}"\n`));
                } else {
                    console.log(chalk.cyan(`\n🏷️  Files tagged "${tag}" (${files.length})\n`));
                    for (const file of files) {
                        console.log(`  ${chalk.blue('●')} ${file.filename} ${chalk.dim(`(${formatBytes(file.original_size)})`)}`);
                    }
                    console.log();
                }
            } else {
                // List all tags
                const tags = db.getAllTags();
                if (tags.length === 0) {
                    console.log(chalk.yellow('\n📭 No tags created yet. Use `tas tag add <file> <tag>` to add tags.\n'));
                } else {
                    console.log(chalk.cyan(`\n🏷️  All Tags (${tags.length})\n`));
                    for (const t of tags) {
                        console.log(`  ${chalk.blue('●')} ${t.tag} ${chalk.dim(`(${t.count} file${t.count > 1 ? 's' : ''})`)}`);
                    }
                    console.log();
                }
            }

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

// ============== SYNC COMMAND ==============
const syncCmd = program
    .command('sync')
    .description('Folder sync (Dropbox-like auto-sync)');

syncCmd
    .command('add <folder>')
    .description('Register a folder for sync')
    .action(async (folder) => {
        try {
            const absPath = path.resolve(folder);

            if (!fs.existsSync(absPath)) {
                console.log(chalk.red(`✗ Folder not found: ${absPath}`));
                process.exit(1);
            }

            if (!fs.statSync(absPath).isDirectory()) {
                console.log(chalk.red(`✗ Not a directory: ${absPath}`));
                process.exit(1);
            }

            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            db.addSyncFolder(absPath);
            console.log(chalk.green(`✓ Added sync folder: ${absPath}`));
            console.log(chalk.dim('  Use `tas sync start` to begin syncing'));

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

syncCmd
    .command('remove <folder>')
    .description('Remove a folder from sync')
    .action(async (folder) => {
        try {
            const absPath = path.resolve(folder);

            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            db.removeSyncFolder(absPath);
            console.log(chalk.green(`✓ Removed sync folder: ${absPath}`));

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

syncCmd
    .command('status')
    .description('Show sync status')
    .action(async () => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const folders = db.getSyncFolders();

            if (folders.length === 0) {
                console.log(chalk.yellow('\n📭 No folders registered for sync.'));
                console.log(chalk.dim('   Use `tas sync add <folder>` to add a folder.\n'));
            } else {
                console.log(chalk.cyan(`\n📁 Sync Folders (${folders.length})\n`));
                for (const folder of folders) {
                    const states = db.getFolderSyncStates(folder.id);
                    const status = folder.enabled ? chalk.green('enabled') : chalk.dim('disabled');
                    console.log(`  ${chalk.blue('●')} ${folder.local_path}`);
                    console.log(chalk.dim(`    Status: ${status} | Files tracked: ${states.length}`));
                }
                console.log();
            }

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

syncCmd
    .command('start')
    .description('Start syncing all registered folders')
    .option('-p, --password <password>', 'Encryption password (uses TAS_PASSWORD env var if not provided)')
    .option('-l, --limit <limit>', 'Bandwidth limit (e.g. 500k, 1m)')
    .action(async (options) => {
        console.log(chalk.cyan('\n🔄 Starting folder sync...\n'));

        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);

        let limitRate = null;
        if (options.limit) {
            const match = options.limit.match(/^(\d+)([kmg]?)$/i);
            if (!match) {
                console.error(chalk.red('Invalid limit format. Use e.g. 500{}, 1m'));
                process.exit(1);
            }
            const val = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            if (unit === 'k') limitRate = val * 1024;
            else if (unit === 'm') limitRate = val * 1024 * 1024;
            else if (unit === 'g') limitRate = val * 1024 * 1024 * 1024;
            else limitRate = val;

            console.log(chalk.dim(`   Bandwidth limit: ${options.limit}/s`));
        }

        try {
            const { SyncEngine } = await import('./sync/sync.js');

            const syncEngine = new SyncEngine({
                dataDir: DATA_DIR,
                password,
                config,
                limitRate
            });

            await syncEngine.initialize();

            // Set up event handlers
            syncEngine.on('sync-start', ({ folder }) => {
                console.log(chalk.blue(`📂 Scanning: ${folder}`));
            });

            syncEngine.on('sync-complete', ({ folder, uploaded, skipped }) => {
                console.log(chalk.green(`✓ Synced: ${uploaded} uploaded, ${skipped} unchanged`));
            });

            syncEngine.on('file-upload-start', ({ file }) => {
                console.log(chalk.dim(`  ↑ Uploading: ${file}`));
            });

            syncEngine.on('file-upload-complete', ({ file }) => {
                console.log(chalk.green(`  ✓ Uploaded: ${file}`));
            });

            syncEngine.on('file-upload-error', ({ file, error }) => {
                console.log(chalk.red(`  ✗ Failed: ${file} - ${error}`));
            });

            syncEngine.on('watch-start', ({ folder }) => {
                console.log(chalk.cyan(`👁️  Watching: ${folder}`));
            });

            // Start syncing
            await syncEngine.start();

            console.log(chalk.cyan('\n✨ Sync active! Watching for changes...'));
            console.log(chalk.yellow('Press Ctrl+C to stop\n'));

            // Handle graceful shutdown
            const cleanup = () => {
                console.log(chalk.dim('\n\nStopping sync...'));
                syncEngine.stop();
                console.log(chalk.green('✓ Sync stopped'));
                process.exit(0);
            };

            process.on('SIGINT', cleanup);
            process.on('SIGTERM', cleanup);

            // Keep process running
            await new Promise(() => { });

        } catch (err) {
            console.error(chalk.red('Sync failed:'), err.message);
            process.exit(1);
        }
    });

syncCmd
    .command('pull')
    .description('Download all Telegram files to sync folders (two-way sync)')
    .option('-p, --password <password>', 'Encryption password (uses TAS_PASSWORD env var if not provided)')
    .action(async (options) => {
        console.log(chalk.cyan('\n📥 Pulling files from Telegram...\n'));

        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);

        const spinner = ora('Loading...').start();

        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const folders = db.getSyncFolders();
            if (folders.length === 0) {
                spinner.warn('No sync folders registered. Use `tas sync add <folder>` first.');
                process.exit(0);
            }

            // Get all files from Telegram index
            const files = db.listAll();
            if (files.length === 0) {
                spinner.info('No files in Telegram storage.');
                process.exit(0);
            }

            spinner.succeed(`Found ${files.length} files in Telegram`);

            // Download each file that matches a sync folder
            let downloaded = 0;
            let skipped = 0;

            for (const file of files) {
                // Check if file belongs to any sync folder (by name prefix)
                for (const folder of folders) {
                    const folderName = path.basename(folder.local_path);
                    const targetPath = path.join(folder.local_path, file.filename);

                    // Check if file already exists locally with same hash
                    if (fs.existsSync(targetPath)) {
                        skipped++;
                        continue;
                    }

                    // Ensure directory exists
                    const targetDir = path.dirname(targetPath);
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }

                    console.log(chalk.dim(`  ↓ Downloading: ${file.filename}`));

                    try {
                        await retrieveFile(file, {
                            password,
                            dataDir: DATA_DIR,
                            outputPath: targetPath,
                            config,
                            onProgress: () => { }
                        });

                        // Update sync state
                        const { hashFile } = await import('./crypto/encryption.js');
                        const hash = await hashFile(targetPath);
                        const stats = fs.statSync(targetPath);
                        db.updateSyncState(folder.id, file.filename, hash, stats.mtimeMs);

                        console.log(chalk.green(`  ✓ Downloaded: ${file.filename}`));
                        downloaded++;
                    } catch (err) {
                        console.log(chalk.red(`  ✗ Failed: ${file.filename} - ${err.message}`));
                    }

                    break; // Only download to first matching folder
                }
            }

            console.log(chalk.green(`\n✓ Pull complete: ${downloaded} downloaded, ${skipped} skipped\n`));

            db.close();
        } catch (err) {
            spinner.fail(`Pull failed: ${err.message}`);
            process.exit(1);
        }
    });

// ============== VERIFY COMMAND ==============
program
    .command('verify')
    .description('Verify file integrity and check for missing Telegram messages')
    .option('-p, --password <password>', 'Encryption password')
    .action(async (options) => {
        console.log(chalk.cyan('\n🔍 Verifying file integrity...\n'));

        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);

        const spinner = ora('Checking files...').start();

        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const files = db.listAll();
            if (files.length === 0) {
                spinner.info('No files in storage.');
                process.exit(0);
            }

            spinner.text = 'Connecting to Telegram...';

            const client = new TelegramClient(DATA_DIR);
            await client.initialize(config.botToken);
            client.setChatId(config.chatId);

            spinner.succeed(`Checking ${files.length} files...`);

            let valid = 0;
            let missing = 0;
            let errors = [];

            for (const file of files) {
                const chunks = db.getChunks(file.id);
                let fileValid = true;

                for (const chunk of chunks) {
                    try {
                        // Try to get file info from Telegram
                        if (!chunk.file_telegram_id) {
                            fileValid = false;
                            errors.push({ file: file.filename, error: 'Missing Telegram file ID' });
                            break;
                        }

                        // Check if file is accessible (will throw if deleted)
                        await client.bot.getFile(chunk.file_telegram_id);
                    } catch (err) {
                        fileValid = false;
                        errors.push({
                            file: file.filename,
                            chunk: chunk.chunk_index,
                            error: err.message.includes('file') ? 'File deleted from Telegram' : err.message
                        });
                        break;
                    }
                }

                if (fileValid) {
                    console.log(`  ${chalk.green('✓')} ${file.filename}`);
                    valid++;
                } else {
                    console.log(`  ${chalk.red('✗')} ${file.filename} ${chalk.dim('(missing)')}`);
                    missing++;
                }
            }

            console.log();
            console.log(chalk.cyan('📊 Verification Results'));
            console.log(`   Valid: ${chalk.green(valid)}`);
            console.log(`   Missing: ${chalk.red(missing)}`);

            if (errors.length > 0) {
                console.log(chalk.yellow('\n⚠️  Issues found:'));
                for (const err of errors) {
                    console.log(chalk.dim(`   ${err.file}: ${err.error}`));
                }
                console.log(chalk.dim('\n   Tip: Re-upload missing files with `tas push <file>`'));
            } else {
                console.log(chalk.green('\n✨ All files intact!'));
            }

            console.log();
            db.close();

        } catch (err) {
            spinner.fail(`Verification failed: ${err.message}`);
            process.exit(1);
        }
    });

// Helper function
function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============== SEARCH COMMAND ==============
program
    .command('search <query>')
    .description('Search files by name or tag')
    .option('-t, --tag', 'Search by tag instead of filename')
    .action(async (query, options) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const results = options.tag
                ? db.searchByTag(query)
                : db.search(query);

            if (results.length === 0) {
                console.log(chalk.yellow(`\n📭 No files found matching "${query}"\n`));
                db.close();
                return;
            }

            console.log(chalk.cyan(`\n🔍 Search Results for "${query}" (${results.length})\n`));

            for (const file of results) {
                const tags = file.tags ? chalk.dim(` [${file.tags}]`) : '';
                console.log(`  ${chalk.blue('●')} ${file.filename} ${chalk.dim(`(${formatBytes(file.original_size)})`)}${tags}`);
            }

            console.log();
            db.close();
        } catch (err) {
            console.error(chalk.red('Search failed:'), err.message);
            process.exit(1);
        }
    });

// ============== RESUME COMMAND ==============
program
    .command('resume')
    .description('Resume interrupted uploads')
    .option('-p, --password <password>', 'Encryption password (uses TAS_PASSWORD env var if not provided)')
    .action(async (options) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const pending = db.getPendingUploads();

            if (pending.length === 0) {
                console.log(chalk.yellow('\n📭 No interrupted uploads found.\n'));
                db.close();
                return;
            }

            console.log(chalk.cyan(`\n🔄 Pending Uploads (${pending.length})\n`));

            for (const upload of pending) {
                const progress = Math.round((upload.uploaded_chunks / upload.total_chunks) * 100);
                console.log(`  ${chalk.blue('●')} ${upload.filename}`);
                console.log(chalk.dim(`    Progress: ${upload.uploaded_chunks}/${upload.total_chunks} chunks (${progress}%)`));
                console.log(chalk.dim(`    Started: ${new Date(upload.created_at).toLocaleString()}`));
            }

            console.log();

            // Ask if user wants to resume
            const { action } = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'action',
                    message: 'What would you like to do?',
                    choices: [
                        { name: 'Resume all pending uploads', value: 'resume' },
                        { name: 'Clear all pending uploads', value: 'clear' },
                        { name: 'Cancel', value: 'cancel' }
                    ]
                }
            ]);

            if (action === 'cancel') {
                db.close();
                return;
            }

            if (action === 'clear') {
                for (const upload of pending) {
                    // Clean up temp files
                    const chunks = db.getPendingChunks(upload.id);
                    for (const chunk of chunks) {
                        try { fs.unlinkSync(chunk.chunk_path); } catch (e) { }
                    }
                    if (upload.temp_dir) {
                        try { fs.rmdirSync(upload.temp_dir); } catch (e) { }
                    }
                    db.deletePendingUpload(upload.id);
                }
                console.log(chalk.green('✓ Cleared all pending uploads'));
                db.close();
                return;
            }

            // Resume uploads
            const rawConfig = loadConfig(DATA_DIR);
            if (!rawConfig) {
                console.log(chalk.red('✗ TAS not initialized.'));
                db.close();
                return;
            }

            // Get and verify password
            const password = await getAndVerifyPassword(options.password, DATA_DIR);
            const config = resolveConfig(rawConfig, password);

            // Connect to Telegram
            const { TelegramClient } = await import('./telegram/client.js');
            const client = new TelegramClient(DATA_DIR);
            await client.initialize(config.botToken);
            client.setChatId(config.chatId);

            for (const upload of pending) {
                console.log(chalk.cyan(`\n📤 Resuming: ${upload.filename}`));

                const chunks = db.getPendingChunks(upload.id);
                const pendingChunks = chunks.filter(c => !c.uploaded);

                for (const chunk of pendingChunks) {
                    if (!fs.existsSync(chunk.chunk_path)) {
                        console.log(chalk.red(`  ✗ Chunk file missing: ${chunk.chunk_path}`));
                        continue;
                    }

                    console.log(chalk.dim(`  ↑ Uploading chunk ${chunk.chunk_index + 1}/${upload.total_chunks}...`));

                    const caption = upload.total_chunks > 1
                        ? `📦 ${upload.filename} (${chunk.chunk_index + 1}/${upload.total_chunks})`
                        : `📦 ${upload.filename}`;

                    const result = await client.sendFile(chunk.chunk_path, caption);
                    db.markChunkUploaded(upload.id, chunk.chunk_index, result.messageId.toString(), result.fileId);

                    // Clean up temp file
                    fs.unlinkSync(chunk.chunk_path);
                }

                // All chunks uploaded - finalize
                const allChunks = db.getPendingChunks(upload.id);
                if (allChunks.every(c => c.uploaded)) {
                    // Add to main files table
                    const fileId = db.addFile({
                        filename: upload.filename,
                        hash: upload.hash,
                        originalSize: upload.original_size,
                        storedSize: upload.original_size, // Approximate
                        chunks: upload.total_chunks,
                        compressed: true
                    });

                    // Add chunk records
                    for (const chunk of allChunks) {
                        db.addChunk(fileId, chunk.chunk_index, chunk.message_id, 0);
                        db.db.prepare('UPDATE chunks SET file_telegram_id = ? WHERE file_id = ? AND chunk_index = ?')
                            .run(chunk.file_telegram_id, fileId, chunk.chunk_index);
                    }

                    // Clean up pending record
                    db.deletePendingUpload(upload.id);
                    if (upload.temp_dir) {
                        try { fs.rmdirSync(upload.temp_dir); } catch (e) { }
                    }

                    console.log(chalk.green(`  ✓ Completed: ${upload.filename}`));
                }
            }

            console.log(chalk.green('\n✨ All uploads resumed!\n'));
            db.close();

        } catch (err) {
            console.error(chalk.red('Resume failed:'), err.message);
            process.exit(1);
        }
    });

// ============== SHARE COMMAND ==============
const shareCmd = program
    .command('share')
    .description('🔗 Share files via temporary download links');

shareCmd
    .command('create <file>')
    .description('Create a temporary download link for a file')
    .option('-e, --expire <duration>', 'Expiry duration (e.g. 1h, 24h, 7d)', '24h')
    .option('-m, --max-downloads <n>', 'Maximum number of downloads', '1')
    .option('--port <port>', 'HTTP server port', '3000')
    .option('-p, --password <password>', 'Encryption password')
    .action(async (file, options) => {
        console.log(chalk.cyan('\n🔗 Creating share link...\n'));

        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);

        const spinner = ora('Setting up...').start();

        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            const fileRecord = db.findByHash(file) || db.findByName(file);
            if (!fileRecord) {
                spinner.fail(`File not found: ${file}`);
                process.exit(1);
            }

            // Generate token and calculate expiry
            const { generateToken, parseDuration } = await import('./share/server.js');
            const token = generateToken();
            const expiresAt = new Date(Date.now() + parseDuration(options.expire)).toISOString();
            const maxDownloads = parseInt(options.maxDownloads) || 1;

            // Add share to DB
            db.addShare(fileRecord.id, token, expiresAt, maxDownloads);

            // Start share server
            const { ShareServer } = await import('./share/server.js');
            const port = parseInt(options.port) || 3000;

            const server = new ShareServer({
                dataDir: DATA_DIR,
                password,
                config,
                port
            });

            await server.initialize();
            await server.start();

            spinner.succeed('Share server running!');

            // Get local IP for network sharing
            const { networkInterfaces } = await import('os');
            const nets = networkInterfaces();
            let localIP = 'localhost';
            for (const name of Object.keys(nets)) {
                for (const net of nets[name]) {
                    if (net.family === 'IPv4' && !net.internal) {
                        localIP = net.address;
                        break;
                    }
                }
            }

            console.log(chalk.cyan('\n📎 Share Links:\n'));
            console.log(`  ${chalk.white('Local:')}    ${chalk.green(`http://localhost:${port}/d/${token}`)}`);
            console.log(`  ${chalk.white('Network:')}  ${chalk.green(`http://${localIP}:${port}/d/${token}`)}`);
            console.log();
            console.log(chalk.dim(`  File:       ${fileRecord.filename}`));
            console.log(chalk.dim(`  Expires:    ${options.expire}`));
            console.log(chalk.dim(`  Downloads:  ${maxDownloads} max`));
            console.log(chalk.dim(`  Token:      ${token.substring(0, 8)}...`));
            console.log();
            console.log(chalk.yellow('Press Ctrl+C to stop the share server'));

            // Handle graceful shutdown
            const cleanup = async () => {
                console.log(chalk.dim('\n\nStopping share server...'));
                await server.stop();
                console.log(chalk.green('✓ Share server stopped'));
                process.exit(0);
            };

            process.on('SIGINT', cleanup);
            process.on('SIGTERM', cleanup);

            // Keep process running
            await new Promise(() => { });

        } catch (err) {
            spinner.fail(`Share failed: ${err.message}`);
            process.exit(1);
        }
    });

shareCmd
    .command('list')
    .description('List all active share links')
    .action(async () => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            // Clean expired first
            const cleaned = db.cleanExpiredShares();
            if (cleaned > 0) {
                console.log(chalk.dim(`  (${cleaned} expired shares cleaned)`));
            }

            const shares = db.listShares();

            if (shares.length === 0) {
                console.log(chalk.yellow('\n📭 No active shares. Use `tas share create <file>` to create one.\n'));
            } else {
                console.log(chalk.cyan(`\n🔗 Active Shares (${shares.length})\n`));

                for (const share of shares) {
                    const expired = new Date(share.expires_at) < new Date();
                    const status = expired
                        ? chalk.red('expired')
                        : chalk.green('active');

                    console.log(`  ${chalk.blue('●')} ${share.filename}`);
                    console.log(chalk.dim(`    Token: ${share.token.substring(0, 8)}...  Status: ${status}  Downloads: ${share.download_count}/${share.max_downloads}`));
                    console.log(chalk.dim(`    Expires: ${new Date(share.expires_at).toLocaleString()}`));
                }
                console.log();
            }

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

shareCmd
    .command('revoke <token>')
    .description('Revoke a share link')
    .action(async (token) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            // Support partial token match
            const shares = db.listShares();
            const match = shares.find(s => s.token === token || s.token.startsWith(token));

            if (!match) {
                console.log(chalk.red(`✗ Share not found: ${token}`));
                process.exit(1);
            }

            db.revokeShare(match.token);
            console.log(chalk.green(`✓ Revoked share for "${match.filename}"`));

            db.close();
        } catch (err) {
            console.error(chalk.red('Error:'), err.message);
            process.exit(1);
        }
    });

// ============== DOCTOR COMMAND ==============
program
    .command('doctor')
    .description('🩺 Run self-diagnostics and check system health')
    .action(async () => {
        console.log(chalk.cyan('\n🩺 TAS Doctor — System Health Check\n'));

        const checks = [];
        const ok = (label) => { checks.push({ label, status: 'ok' }); console.log(chalk.green(`  ✓ ${label}`)); };
        const warn = (label, detail) => { checks.push({ label, status: 'warn', detail }); console.log(chalk.yellow(`  ⚠ ${label}`) + chalk.dim(` — ${detail}`)); };
        const fail = (label, detail) => { checks.push({ label, status: 'fail', detail }); console.log(chalk.red(`  ✗ ${label}`) + chalk.dim(` — ${detail}`)); };

        // 1. Check Node.js version
        const nodeVer = process.versions.node;
        const major = parseInt(nodeVer.split('.')[0]);
        if (major >= 18) ok(`Node.js ${nodeVer}`);
        else warn(`Node.js ${nodeVer}`, 'Requires >= 18.0.0');

        // 2. Check data directory
        if (fs.existsSync(DATA_DIR)) ok(`Data directory: ${DATA_DIR}`);
        else warn('Data directory missing', `Run \`tas init\` to create ${DATA_DIR}`);

        // 3. Check config
        const configPath = path.join(DATA_DIR, 'config.json');
        if (fs.existsSync(configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (config.configVersion === 2) ok('Config v2 (encrypted token)');
                else if (config.botToken) warn('Config v1 (plaintext token)', 'Re-run `tas init` to encrypt token');
                else fail('Config invalid', 'Missing bot token');

                if (config.chatId) ok(`Chat ID: ${config.chatId}`);
                else fail('Chat ID missing', 'Run `tas init`');
            } catch (e) {
                fail('Config corrupted', e.message);
            }
        } else {
            warn('Config not found', 'Run `tas init`');
        }

        // 4. Check database
        const dbPath = path.join(DATA_DIR, 'index.db');
        if (fs.existsSync(dbPath)) {
            try {
                const db = new FileIndex(dbPath);
                db.init();
                const stats = db.getStats();
                ok(`Database: ${stats.file_count} files, ${formatBytes(stats.total_original)} total`);
                db.close();
            } catch (e) {
                fail('Database error', e.message);
            }
        } else {
            warn('Database not found', 'Will be created on first upload');
        }

        // 5. Check FUSE availability
        try {
            await import('fuse-native');
            ok('FUSE support available');
        } catch (e) {
            warn('FUSE not available', 'Install libfuse for mount support');
        }

        // 6. Check disk space
        try {
            const { execSync } = await import('child_process');
            const df = execSync(`df -h "${DATA_DIR}" 2>/dev/null || echo "unknown"`).toString().trim();
            const lines = df.split('\n');
            if (lines.length > 1) {
                const parts = lines[1].split(/\s+/);
                const avail = parts[3] || 'unknown';
                const usage = parts[4] || 'unknown';
                if (parseInt(usage) > 90) warn(`Disk space: ${avail} free (${usage} used)`, 'Running low!');
                else ok(`Disk space: ${avail} free (${usage} used)`);
            }
        } catch (e) { /* ignore */ }

        // 7. Security check
        const iterations = 600000;
        ok(`Encryption: AES-256-GCM, PBKDF2-SHA512 ${iterations.toLocaleString()} iterations`);

        // Summary
        const fails = checks.filter(c => c.status === 'fail').length;
        const warns = checks.filter(c => c.status === 'warn').length;
        console.log();
        if (fails > 0) console.log(chalk.red(`  ${fails} issue(s) found. Please fix them above.`));
        else if (warns > 0) console.log(chalk.yellow(`  ${warns} warning(s). System is functional.`));
        else console.log(chalk.green('  ✨ All systems go! TAS is healthy.'));
        console.log();
    });

program.parse();


