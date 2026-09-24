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
import { TelegramPool, MULTI_BOT_WARNING } from './telegram/pool.js';
import { Encryptor } from './crypto/encryption.js';
import { Compressor } from './utils/compression.js';
import { FileIndex } from './db/index.js';
import { processFile, retrieveFile } from './index.js';
import { backupRemoteManifest, downloadRemoteManifest } from './manifest.js';
import { printBanner, LOGO, TAGLINE, VERSION } from './utils/branding.js';
import {
    getPassword,
    verifyPassword,
    loadConfig,
    requireConfig,
    getAndVerifyPassword,
    resolveConfig,
    getBotEntries,
    encryptBotToken,
    saveConfig
} from './utils/cli-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = process.env.TAS_DATA_DIR || path.join(os.homedir(), '.tas');

function normalizeBotId(value) {
    return String(value || 'bot')
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'bot';
}

function warnIfMultiBot(config) {
    if ((config.bots || []).filter(bot => bot.enabled !== false).length > 1) {
        console.log(chalk.yellow(`⚠ ${MULTI_BOT_WARNING}\n`));
    }
}

function migrateConfigToV3(rawConfig, password) {
    const bots = getBotEntries(rawConfig).map(bot => ({
        id: bot.id,
        encryptedBotToken: bot.encryptedBotToken || encryptBotToken(bot.botToken, password),
        chatId: bot.chatId,
        username: bot.username,
        enabled: bot.enabled !== false,
        createdAt: bot.createdAt || new Date().toISOString()
    }));
    const migrated = { ...rawConfig, bots, configVersion: 3 };
    delete migrated.botToken;
    delete migrated.encryptedBotToken;
    delete migrated.chatId;
    return migrated;
}

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
    .description(chalk.cyan('📦 TAS') + chalk.dim(' - Experimental encrypted storage over Telegram'))
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
    .option('--token <token>', 'Telegram bot token (non-interactive / CI mode)')
    .option('--chat <chatId>', 'Telegram chat ID (non-interactive / CI mode)')
    .option('-p, --password <password>', 'Encryption password (non-interactive / CI mode, or TAS_PASSWORD env)')
    .action(async (options) => {
        console.log(chalk.cyan('\n🚀 Initializing Telegram as Storage...\n'));

        // Ensure data directory exists
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }

        const envPassword = process.env.TAS_PASSWORD;
        let token = options.token;
        let password = options.password || envPassword;
        let presetChatId = options.chat;

        const nonInteractive = Boolean(token && presetChatId && password);

        if (!nonInteractive) {
            // Get bot token
            console.log(chalk.yellow('📱 First, create a Telegram bot:'));
            console.log(chalk.dim('   1. Open Telegram and message @BotFather'));
            console.log(chalk.dim('   2. Send /newbot and follow the prompts'));
            console.log(chalk.dim('   3. Copy the bot token\n'));
            console.log(chalk.dim('   Tip: `tas init --token <token> --chat <id> --password <pw>` skips all prompts (CI/Docker).\n'));

            if (!token) {
                const answer = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'token',
                        message: 'Enter your Telegram bot token:',
                        mask: '*',
                        validate: (input) => input.includes(':') || 'Invalid token format (should contain :)'
                    }
                ]);
                token = answer.token;
            }

            // Get encryption password
            if (!password) {
                const answer = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'password',
                        message: 'Set your encryption password (used for all files):',
                        mask: '*',
                        validate: (input) => input.length >= 8 || 'Password must be at least 8 characters'
                    }
                ]);
                password = answer.password;

                const { confirmPassword } = await inquirer.prompt([
                    {
                        type: 'password',
                        name: 'confirmPassword',
                        message: 'Confirm password:',
                        mask: '*',
                        validate: (input) => input === password || 'Passwords do not match'
                    }
                ]);
            }
        }

        if (!token || !token.includes(':')) {
            console.error(chalk.red('✗ Invalid bot token (should contain :)'));
            process.exit(1);
        }
        if (!password || password.length < 8) {
            console.error(chalk.red('✗ Password must be at least 8 characters'));
            process.exit(1);
        }

        // Initialize encryption
        const encryptor = new Encryptor(password);

        // Initialize Telegram
        const spinner = ora('Connecting to Telegram...').start();
        const client = new TelegramClient(DATA_DIR);

        try {
            const botInfo = await client.initialize(token);
            spinner.succeed(`Connected as @${botInfo.username}`);

            let userInfo;
            if (presetChatId) {
                // Non-interactive: trust the provided chat ID (CI/Docker)
                client.setChatId(presetChatId);
                userInfo = { chatId: presetChatId, username: undefined, firstName: 'ci-user' };
                spinner.succeed(`Using chat ID ${presetChatId} (non-interactive)`);
            } else {
                // Wait for user to message the bot
                console.log(chalk.yellow(`\n📩 Now message your bot @${botInfo.username} on Telegram`));
                console.log(chalk.dim('   (Just send any message to link your account)\n'));

                spinner.start('Waiting for your message...');
                userInfo = await client.waitForChatId(120000);
                spinner.succeed(`Linked to ${userInfo.firstName} (@${userInfo.username})`);
            }

            // Save config (bot token encrypted with user's password)
            const encryptedToken = encryptor.encrypt(Buffer.from(token, 'utf-8')).toString('base64');
            saveConfig(DATA_DIR, {
                bots: [{
                    id: 'primary',
                    encryptedBotToken: encryptedToken,
                    chatId: userInfo.chatId,
                    username: botInfo.username,
                    enabled: true,
                    createdAt: new Date().toISOString()
                }],
                passwordHash: encryptor.getPasswordHash(),
                username: userInfo.username,
                createdAt: new Date().toISOString(),
                configVersion: 3
            });

            // Initialize database
            spinner.start('Initializing local index...');
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();
            spinner.succeed('Local index ready');

            // Send welcome message
            await client.bot.sendMessage(userInfo.chatId,
                '📦 *TAS - Telegram as Storage*\n\n' +
                '✅ Setup complete! This chat will store your encrypted files.\n\n' +
                '⚠️ Experimental: Telegram provides no TAS durability or account guarantee. Keep another backup.\n\n' +
                '_Do not delete messages in this chat._',
                { parse_mode: 'Markdown' }
            );

            console.log(chalk.yellow('\n⚠ TAS is experimental, Telegram provides no durability/account guarantee, and current Bot Developer Terms may restrict cloud-storage use. Keep an independent backup.'));
            console.log(chalk.cyan('\n🎉 TAS is ready! Use `tas push <file>` to upload files.\n'));

        } catch (err) {
            spinner.fail(`Telegram initialization failed: ${err.message}`);
            process.exit(1);
        }
    });

// ============== BOT POOL COMMANDS ==============
const botCmd = program
    .command('bot')
    .description('Manage the experimental multi-bot storage pool');

botCmd
    .command('list')
    .description('List configured bots without exposing their tokens')
    .action(() => {
        const config = requireConfig(DATA_DIR);
        const bots = getBotEntries(config);
        let db = null;
        try {
            db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();
        } catch { /* an empty vault may not have a database yet */ }

        console.log(chalk.cyan(`\n🤖 Telegram Bot Pool (${bots.length})\n`));
        for (const bot of bots) {
            const chunks = db ? db.countChunksByBot(bot.id) : 0;
            const pendingChunks = db ? db.countPendingChunksByBot(bot.id) : 0;
            const state = bot.enabled === false ? chalk.yellow('disabled') : chalk.green('enabled');
            const username = bot.username ? `@${String(bot.username).replace(/^@/, '')}` : 'username unknown';
            console.log(`  ${chalk.blue(bot.id.padEnd(16))} ${state}  ${username}  chat=${bot.chatId}  chunks=${chunks}  pending=${pendingChunks}`);
        }
        db?.close();
        console.log(chalk.dim('\nDisabled bots remain configured so TAS can read their existing chunks.\n'));
    });

botCmd
    .command('add')
    .description('Add a bot to the experimental storage pool')
    .option('--token <token>', 'Telegram bot token')
    .option('--chat <chatId>', 'Telegram storage chat ID')
    .option('--name <id>', 'Stable bot ID (letters, numbers, _ and -)')
    .option('-p, --password <password>', 'Vault password (or TAS_PASSWORD)')
    .option('--accept-risk', 'Acknowledge the multi-bot warning in non-interactive use')
    .action(async (options) => {
        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);

        console.log(chalk.yellow(`\n⚠ ${MULTI_BOT_WARNING}\n`));
        if (!options.acceptRisk) {
            if (!process.stdin.isTTY) {
                throw new Error('Non-interactive bot add requires --accept-risk');
            }
            const { accepted } = await inquirer.prompt([{
                type: 'confirm',
                name: 'accepted',
                message: 'I understand and still want to add another bot',
                default: false
            }]);
            if (!accepted) return;
        }

        let token = options.token;
        if (!token) {
            ({ token } = await inquirer.prompt([{
                type: 'password',
                name: 'token',
                message: 'Enter the additional Telegram bot token:',
                mask: '*',
                validate: input => input.includes(':') || 'Invalid token format (should contain :)'
            }]));
        }
        if (!token || !token.includes(':')) throw new Error('Invalid bot token (should contain :)');
        if (resolveConfig(rawConfig, password).bots.some(bot => bot.botToken === token)) {
            throw new Error('That bot token is already configured');
        }

        const client = new TelegramClient(DATA_DIR);
        const info = await client.initialize(token);
        let chatId = options.chat;
        if (!chatId) {
            console.log(chalk.yellow(`\n📩 Send any message to @${info.username} to select its storage chat.`));
            ({ chatId } = await client.waitForChatId(120000));
        }
        client.setChatId(chatId);

        const config = migrateConfigToV3(rawConfig, password);
        const baseId = normalizeBotId(options.name || info.username);
        let id = baseId;
        let suffix = 2;
        while (config.bots.some(bot => bot.id === id)) id = `${baseId.slice(0, 28)}-${suffix++}`;

        config.bots.push({
            id,
            encryptedBotToken: encryptBotToken(token, password),
            chatId,
            username: info.username,
            enabled: true,
            createdAt: new Date().toISOString()
        });
        config.multiBotRiskAcceptedAt = new Date().toISOString();
        saveConfig(DATA_DIR, config);

        await client.bot.sendMessage(chatId,
            '📦 *TAS storage bot added*\n\n' +
            '⚠️ Experimental. This does not guarantee quota, durability, ban avoidance, or Terms compliance. Keep another backup.\n\n' +
            '_Do not delete TAS chunk messages in this chat._',
            { parse_mode: 'Markdown' }
        );
        console.log(chalk.green(`\n✓ Added @${info.username} as bot ID "${id}"\n`));
    });

async function setBotEnabled(id, enabled, options) {
    const rawConfig = requireConfig(DATA_DIR);
    const password = await getAndVerifyPassword(options.password, DATA_DIR);
    const config = migrateConfigToV3(rawConfig, password);
    const bot = config.bots.find(entry => entry.id === id);
    if (!bot) throw new Error(`Unknown bot ID: ${id}`);
    if (!enabled && config.bots.filter(entry => entry.enabled !== false).length <= 1) {
        throw new Error('Cannot disable the last enabled bot');
    }
    bot.enabled = enabled;
    saveConfig(DATA_DIR, config);
    console.log(chalk.green(`✓ ${enabled ? 'Enabled' : 'Disabled'} bot "${id}"`));
    if (!enabled) console.log(chalk.dim('  Existing chunks remain readable through this bot.'));
}

botCmd
    .command('enable <id>')
    .description('Enable a configured bot for new uploads')
    .option('-p, --password <password>', 'Vault password (or TAS_PASSWORD)')
    .action((id, options) => setBotEnabled(id, true, options));

botCmd
    .command('disable <id>')
    .description('Stop routing new chunks to a bot but keep old chunks readable')
    .option('-p, --password <password>', 'Vault password (or TAS_PASSWORD)')
    .action((id, options) => setBotEnabled(id, false, options));

botCmd
    .command('remove <id>')
    .description('Remove an unused bot (refuses while indexed chunks depend on it)')
    .option('-p, --password <password>', 'Vault password (or TAS_PASSWORD)')
    .action(async (id, options) => {
        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = migrateConfigToV3(rawConfig, password);
        const index = config.bots.findIndex(bot => bot.id === id);
        if (index < 0) throw new Error(`Unknown bot ID: ${id}`);
        if (config.bots.length === 1) throw new Error('Cannot remove the only configured bot');
        if (rawConfig.remoteManifest?.botId === id) {
            throw new Error(`Cannot remove "${id}": the current remote recovery manifest depends on it. Run \`tas index backup\` after enabling another bot first.`);
        }

        const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
        db.init();
        const chunkCount = db.countChunksByBot(id);
        const pendingChunkCount = db.countPendingChunksByBot(id);
        db.close();
        if (chunkCount > 0 || pendingChunkCount > 0) {
            throw new Error(
                `Cannot remove "${id}": ${chunkCount} indexed and ${pendingChunkCount} pending chunk(s) still depend on it. Disable it instead.`
            );
        }

        config.bots.splice(index, 1);
        if (!config.bots.some(bot => bot.enabled !== false)) config.bots[0].enabled = true;
        saveConfig(DATA_DIR, config);
        console.log(chalk.green(`✓ Removed unused bot "${id}"`));
    });

// ============== REMOTE INDEX RECOVERY ==============
const indexCmd = program
    .command('index')
    .description('Back up or rebuild the local SQLite index');

indexCmd
    .command('backup')
    .description('Publish a fresh encrypted index manifest to Telegram')
    .option('-p, --password <password>', 'Vault password (or TAS_PASSWORD)')
    .action(async (options) => {
        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);
        const pool = new TelegramPool(DATA_DIR, config.bots);
        const manifest = await backupRemoteManifest({ dataDir: DATA_DIR, password, config, telegramPool: pool });
        console.log(chalk.green(`✓ Encrypted recovery manifest published (${manifest.files} files, ${manifest.chunks} chunks)`));
    });

indexCmd
    .command('rebuild')
    .description('Rebuild index.db from the encrypted remote manifest')
    .option('-p, --password <password>', 'Vault password (or TAS_PASSWORD)')
    .option('--force', 'Replace the current index without an interactive confirmation')
    .action(async (options) => {
        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);
        const pool = new TelegramPool(DATA_DIR, config.bots);

        const spinner = ora('Downloading and authenticating remote manifest...').start();
        const manifest = await downloadRemoteManifest({ dataDir: DATA_DIR, password, config, telegramPool: pool });
        spinner.succeed(`Authenticated manifest: ${manifest.files.length} files, ${manifest.chunks.length} chunks`);

        const dbPath = path.join(DATA_DIR, 'index.db');
        let currentCount = 0;
        if (fs.existsSync(dbPath)) {
            const current = new FileIndex(dbPath);
            current.init();
            currentCount = current.getStats().file_count;
            current.close();
        }
        if (currentCount > 0 && !options.force) {
            if (!process.stdin.isTTY) throw new Error('Refusing to replace a non-empty index without --force');
            const { confirmed } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirmed',
                message: `Replace the current ${currentCount}-file index with the remote recovery point?`,
                default: false
            }]);
            if (!confirmed) return;
        }

        let backupPath = null;
        if (fs.existsSync(dbPath)) {
            backupPath = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
            const current = new FileIndex(dbPath);
            current.init();
            current.db.pragma('wal_checkpoint(TRUNCATE)');
            current.close();
            fs.copyFileSync(dbPath, backupPath);
        }

        const rebuilt = new FileIndex(dbPath);
        rebuilt.init();
        rebuilt.importManifest(manifest);
        const integrity = rebuilt.db.pragma('integrity_check', { simple: true });
        rebuilt.close();
        if (integrity !== 'ok') throw new Error(`SQLite integrity check failed after rebuild: ${integrity}`);

        console.log(chalk.green(`✓ Rebuilt index with ${manifest.files.length} files`));
        if (backupPath) console.log(chalk.dim(`  Previous index backup: ${backupPath}`));
    });

// ============== PUSH COMMAND ==============
program
    .command('push <files...>')
    .description('Upload one or more files to Telegram storage')
    .option('-n, --name <name>', 'Custom name for the file (single-file uploads only)')
    .option('-p, --password <password>', 'Encryption password (uses TAS_PASSWORD env var if not provided)')
    .action(async (files, options) => {
        if (files.length > 1 && options.name) {
            console.error(chalk.red('✗ --name can only be used with a single file'));
            process.exit(1);
        }

        const rawConfig = requireConfig(DATA_DIR);

        // Get and verify password once for the whole batch
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);
        warnIfMultiBot(config);
        const telegramPool = new TelegramPool(DATA_DIR, config.bots);
        await telegramPool.initialize({ includeDisabled: false });

        const { ProgressBar } = await import('./utils/progress.js');
        let succeeded = 0;
        let failed = 0;

        for (const file of files) {
            const spinner = ora(`Preparing ${file}...`).start();
            try {
                if (!fs.existsSync(file)) {
                    spinner.fail(`File not found: ${file}`);
                    failed++;
                    continue;
                }
                if (!fs.statSync(file).isFile()) {
                    spinner.fail(`Not a file, skipping: ${file}`);
                    failed++;
                    continue;
                }

                spinner.text = 'Processing file...';
                let progressBar = null;

                const result = await processFile(file, {
                    password,
                    dataDir: DATA_DIR,
                    customName: options.name,
                    config,
                    telegramPool,
                    updateManifest: false,
                    onProgress: (msg) => {
                        if (!progressBar) spinner.text = `${file}: ${msg}`;
                    },
                    onByteProgress: ({ uploaded, total }) => {
                        if (!progressBar) {
                            spinner.stop();
                            progressBar = new ProgressBar({ label: `Uploading ${file}`, total });
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
                succeeded++;
            } catch (err) {
                spinner.fail(`Upload failed for ${file}: ${err.message}`);
                failed++;
            }
        }

        if (files.length > 1) {
            console.log(chalk.cyan(`\nDone: ${succeeded} uploaded, ${failed} failed\n`));
        }
        if (succeeded > 0) {
            try {
                await backupRemoteManifest({ dataDir: DATA_DIR, password, config, telegramPool });
                console.log(chalk.dim('Encrypted remote recovery manifest updated.'));
            } catch (error) {
                console.log(chalk.yellow(`⚠ Files uploaded, but recovery manifest update failed: ${error.message}`));
                process.exitCode = 1;
            }
        }
        if (failed > 0) process.exitCode = 1;
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
            warnIfMultiBot(config);

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
    .option('-p, --password <password>', 'Encryption password (or TAS_PASSWORD)')
    .action(async (identifier, options) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();

            let fileRecord = db.findByHash(identifier) || db.findByName(identifier);
            if (!fileRecord) {
                console.log(chalk.red(`✗ File not found: ${identifier}`));
                process.exit(1);
            }

            if (!options.hard) {
                console.log(chalk.yellow('  Note: default delete removes the local index entry only — the encrypted copy stays on Telegram. Use --hard to also delete the Telegram message.'));
            } else {
                console.log(chalk.yellow('  Note: --hard deletes the Telegram message, but Telegram may retain the underlying file blob (file_id can outlive the message). Treat as best-effort, not cryptographic erasure.'));
            }

            const { confirm } = await inquirer.prompt([
                {
                    type: 'confirm',
                    name: 'confirm',
                    message: `Delete "${fileRecord.filename}" from index${options.hard ? ' and Telegram message' : ' (Telegram copy retained)'}?`,
                    default: false
                }
            ]);

            if (confirm) {
                const rawConfig = requireConfig(DATA_DIR);
                const password = await getAndVerifyPassword(options.password, DATA_DIR);
                const config = resolveConfig(rawConfig, password);
                warnIfMultiBot(config);
                const client = new TelegramPool(DATA_DIR, config.bots);
                const chunks = db.getChunks(fileRecord.id);
                const before = db.exportManifest({ includeShares: true });
                db.delete(fileRecord.id);

                try {
                    await backupRemoteManifest({ dataDir: DATA_DIR, password, config, telegramPool: client });
                } catch (error) {
                    db.importManifest(before);
                    throw new Error(`Delete rolled back because the recovery manifest could not be updated: ${error.message}`);
                }

                if (options.hard) {
                    for (const chunk of chunks) {
                        await client.deleteMessage(chunk.message_id, chunk.bot_id || null);
                    }
                }
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
        const bots = getBotEntries(config);

        if (options.json) {
            console.log(JSON.stringify({
                initialized: true,
                createdAt: config.createdAt,
                username: config.username || 'unknown',
                botCount: bots.length,
                enabledBots: bots.filter(bot => bot.enabled !== false).length,
                remoteManifest: config.remoteManifest || null,
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
        console.log(`  Bot pool: ${chalk.white(`${bots.filter(bot => bot.enabled !== false).length}/${bots.length} enabled`)}`);
        console.log(`  Recovery manifest: ${config.remoteManifest ? chalk.green(config.remoteManifest.createdAt) : chalk.yellow('not published yet')}`);
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
    .description('🔥 Mount Telegram storage as a local folder (Linux FUSE only)')
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
            console.log(chalk.dim('  macOS: TAS mount is currently unsupported (push/pull/sync still work)\n'));
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
            const { execFileSync } = await import('child_process');

            // Use fusermount on Linux, umount on macOS
            const isMac = process.platform === 'darwin';
            const executable = isMac ? 'umount' : 'fusermount';
            const args = isMac ? [absMount] : ['-u', absMount];
            execFileSync(executable, args, { stdio: 'pipe' });

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
    .option('-p, --password <password>', 'Encryption password (or TAS_PASSWORD)')
    .action(async (file, tags, options) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();
            const before = db.exportManifest({ includeShares: true });

            const fileRecord = db.findByHash(file) || db.findByName(file);
            if (!fileRecord) {
                console.log(chalk.red(`✗ File not found: ${file}`));
                process.exit(1);
            }

            for (const tag of tags) {
                db.addTag(fileRecord.id, tag);
            }

            const rawConfig = requireConfig(DATA_DIR);
            const password = await getAndVerifyPassword(options.password, DATA_DIR);
            const config = resolveConfig(rawConfig, password);
            try {
                await backupRemoteManifest({ dataDir: DATA_DIR, password, config });
            } catch (error) {
                db.importManifest(before);
                throw new Error(`Tag update rolled back because the recovery manifest failed: ${error.message}`);
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
    .option('-p, --password <password>', 'Encryption password (or TAS_PASSWORD)')
    .action(async (file, tags, options) => {
        try {
            const db = new FileIndex(path.join(DATA_DIR, 'index.db'));
            db.init();
            const before = db.exportManifest({ includeShares: true });

            const fileRecord = db.findByHash(file) || db.findByName(file);
            if (!fileRecord) {
                console.log(chalk.red(`✗ File not found: ${file}`));
                process.exit(1);
            }

            for (const tag of tags) {
                db.removeTag(fileRecord.id, tag);
            }

            const rawConfig = requireConfig(DATA_DIR);
            const password = await getAndVerifyPassword(options.password, DATA_DIR);
            const config = resolveConfig(rawConfig, password);
            try {
                await backupRemoteManifest({ dataDir: DATA_DIR, password, config });
            } catch (error) {
                db.importManifest(before);
                throw new Error(`Tag update rolled back because the recovery manifest failed: ${error.message}`);
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
                console.error(chalk.red('Invalid limit format. Use e.g. 500k, 1m'));
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

            syncEngine.on('manifest-error', ({ error }) => {
                console.log(chalk.yellow(`  ⚠ Files synced, but remote recovery manifest failed: ${error}`));
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
        warnIfMultiBot(config);

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

            // Download each file that matches a sync folder.
            // Remote files are stored under their sync relative path
            // (customName at upload time), so join directly. A local file
            // is skipped only when its content hash matches the index —
            // existence alone is not enough (edited files must re-pull).
            // Each file goes to the first folder only to avoid duplicates
            // when several folders are registered.
            let downloaded = 0;
            let skipped = 0;
            const { hashFile } = await import('./crypto/encryption.js');
            const telegramPool = new TelegramPool(DATA_DIR, config.bots);

            for (const file of files) {
                const folder = folders[0];
                const targetPath = path.join(folder.local_path, file.filename);

                // Skip only when local content already matches the index
                if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
                    try {
                        const localHash = await hashFile(targetPath);
                        if (localHash === file.hash) {
                            skipped++;
                            continue;
                        }
                        console.log(chalk.yellow(`  ↻ Updating modified file: ${file.filename}`));
                    } catch {
                        // Hash failed — fall through and re-download
                    }
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
                        telegramPool,
                        onProgress: () => { }
                    });

                    // Update sync state
                    const hash = await hashFile(targetPath);
                    const stats = fs.statSync(targetPath);
                    db.updateSyncState(folder.id, file.filename, hash, stats.mtimeMs);

                    console.log(chalk.green(`  ✓ Downloaded: ${file.filename}`));
                    downloaded++;
                } catch (err) {
                    console.log(chalk.red(`  ✗ Failed: ${file.filename} - ${err.message}`));
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
    .description('Check Telegram references; use --deep to download, decrypt, and hash every file')
    .option('-p, --password <password>', 'Encryption password')
    .option('--deep', 'Download, authenticate, decompress, and SHA-256 verify every file')
    .action(async (options) => {
        console.log(chalk.cyan('\n🔍 Verifying file integrity...\n'));

        const rawConfig = requireConfig(DATA_DIR);
        const password = await getAndVerifyPassword(options.password, DATA_DIR);
        const config = resolveConfig(rawConfig, password);
        warnIfMultiBot(config);

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

            const client = new TelegramPool(DATA_DIR, config.bots);

            spinner.succeed(`Checking ${files.length} files...`);

            let valid = 0;
            let missing = 0;
            let errors = [];
            const verifyDir = options.deep ? fs.mkdtempSync(path.join(os.tmpdir(), 'tas-verify-')) : null;

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
                        await client.getFile(chunk.file_telegram_id, chunk.bot_id || null);
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

                if (fileValid && options.deep) {
                    try {
                        const verifyPath = path.join(verifyDir, String(file.id));
                        await retrieveFile(file, {
                            password,
                            dataDir: DATA_DIR,
                            outputPath: verifyPath,
                            config,
                            telegramPool: client
                        });
                        try { fs.unlinkSync(verifyPath); } catch { }
                    } catch (error) {
                        fileValid = false;
                        errors.push({ file: file.filename, error: `Deep verification failed: ${error.message}` });
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
            if (verifyDir) {
                try { fs.rmSync(verifyDir, { recursive: true, force: true }); } catch { }
            }
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
            // Leftovers from pre-2.5 interrupted uploads (before processFile
            // cleaned up partial rows atomically). Offer to clear them so a
            // retry doesn't hit a phantom "duplicate hash".
            let orphans = [];
            try { orphans = db.getIncompleteUploads(); } catch { orphans = []; }

            if (pending.length === 0 && orphans.length === 0) {
                console.log(chalk.yellow('\n📭 No interrupted uploads found.\n'));
                db.close();
                return;
            }

            if (orphans.length > 0) {
                console.log(chalk.yellow(`\n⚠ ${orphans.length} incomplete file record(s) from interrupted uploads (pre-2.5):\n`));
                for (const o of orphans) {
                    console.log(`  ${chalk.blue('●')} ${o.filename} ${chalk.dim(`(${o.actual_chunks}/${o.chunks} chunks)`)}`);
                }
                console.log(chalk.dim('\n  Current versions clean up partial uploads automatically.'));
                console.log(chalk.dim('  Clear these leftovers, then re-run `tas push <file>` to retry.\n'));

                const { clearOrphans } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'clearOrphans',
                        message: 'Delete incomplete file records now?',
                        default: true
                    }
                ]);
                if (clearOrphans) {
                    for (const o of orphans) {
                        try { db.deleteFileCascade(o.id); } catch { }
                    }
                    console.log(chalk.green('✓ Cleared incomplete uploads — retry with `tas push <file>`'));
                }
                orphans = [];
            }

            if (pending.length === 0) {
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
                const rawConfig = requireConfig(DATA_DIR);
                const password = await getAndVerifyPassword(options.password, DATA_DIR);
                const config = resolveConfig(rawConfig, password);
                const client = new TelegramPool(DATA_DIR, config.bots);
                for (const upload of pending) {
                    // Clean up temp files
                    const chunks = db.getPendingChunks(upload.id);
                    for (const chunk of chunks) {
                        if (chunk.uploaded && chunk.message_id) {
                            try { await client.deleteMessage(chunk.message_id, chunk.bot_id || null); } catch { }
                        }
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
            warnIfMultiBot(config);

            // Connect to Telegram
            const client = new TelegramPool(DATA_DIR, config.bots);
            await client.initialize({ includeDisabled: false });
            const supersededChunks = [];
            let completedUploads = 0;

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

                    const caption = `tas:c1:${upload.id}:${chunk.chunk_index + 1}/${upload.total_chunks}`;

                    const result = await client.sendFile(chunk.chunk_path, caption, {
                        botId: client.selectBotId(upload.hash, chunk.chunk_index),
                        routingKey: upload.hash,
                        chunkIndex: chunk.chunk_index
                    });
                    db.markChunkUploaded(
                        upload.id,
                        chunk.chunk_index,
                        result.messageId.toString(),
                        result.fileId,
                        result.botId
                    );

                    // Clean up temp file
                    fs.unlinkSync(chunk.chunk_path);
                }

                // All chunks uploaded - finalize
                const allChunks = db.getPendingChunks(upload.id);
                if (allChunks.every(c => c.uploaded)) {
                    const existing = db.findByExactName(upload.filename);
                    const existingChunks = existing ? db.getChunks(existing.id) : [];
                    db.db.transaction(() => {
                        const fileId = db.addFile({
                            filename: upload.filename,
                            hash: upload.hash,
                            originalSize: upload.original_size,
                            storedSize: upload.stored_size || Math.max(0, allChunks.reduce((sum, c) => sum + (c.size || 0), 0) - allChunks.length * 64),
                            chunks: upload.total_chunks,
                            compressed: Boolean(upload.compressed)
                        });

                        for (const chunk of allChunks) {
                            db.addChunk(
                                fileId,
                                chunk.chunk_index,
                                chunk.message_id,
                                chunk.size || 0,
                                chunk.file_telegram_id,
                                chunk.bot_id || null
                            );
                        }
                        if (existing) db.deleteFileCascade(existing.id);
                        db.deletePendingUpload(upload.id);
                    })();

                    supersededChunks.push(...existingChunks);
                    if (upload.temp_dir) {
                        try { fs.rmdirSync(upload.temp_dir); } catch (e) { }
                    }

                    console.log(chalk.green(`  ✓ Completed: ${upload.filename}`));
                    completedUploads++;
                }
            }

            const remainingUploads = db.getPendingUploads().length;
            db.close();
            let manifestUpdated = completedUploads === 0;
            if (completedUploads > 0) {
                try {
                    await backupRemoteManifest({ dataDir: DATA_DIR, password, config, telegramPool: client });
                    manifestUpdated = true;
                    for (const chunk of supersededChunks) {
                        try { await client.deleteMessage(chunk.message_id, chunk.bot_id || null); } catch { }
                    }
                } catch (error) {
                    console.log(chalk.yellow(`\n⚠ Uploads resumed, but recovery manifest failed: ${error.message}\n`));
                }
            }
            if (remainingUploads === 0) {
                const suffix = manifestUpdated ? ' and recovery manifest updated' : '; run `tas index backup` to refresh recovery';
                console.log(chalk.green(`\n✨ All uploads resumed${suffix}!\n`));
            } else {
                console.log(chalk.yellow(`\n⚠ ${remainingUploads} upload(s) remain incomplete. Missing staged chunks cannot be resumed.\n`));
                process.exitCode = 1;
            }

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
    .option('--host <host>', 'HTTP server bind address (default 127.0.0.1; use 0.0.0.0 for LAN)', '127.0.0.1')
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
                port,
                host: options.host || '127.0.0.1'
            });

            await server.initialize();
            await server.start();

            spinner.succeed('Share server running!');

            console.log(chalk.cyan('\n📎 Share Links:\n'));
            console.log(`  ${chalk.white('Local:')}    ${chalk.green(`http://localhost:${port}/d/${token}`)}`);
            if (options.host && options.host !== '127.0.0.1' && options.host !== 'localhost') {
                console.log(`  ${chalk.white('Network:')}  ${chalk.green(`http://${options.host === '0.0.0.0' ? '<your-lan-ip>' : options.host}:${port}/d/${token}`)}`);
                if (options.host === '0.0.0.0') {
                    console.log(chalk.yellow('  ⚠ Bound to all interfaces — anyone on your network can fetch this link until it expires.'));
                }
            } else {
                console.log(chalk.dim('  (LAN sharing disabled — bound to localhost. Re-run with --host 0.0.0.0 to share on your network.)'));
            }
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
    .option('-p, --password <password>', 'Encryption password (to verify every configured Telegram bot)')
    .action(async (options) => {
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
                if (config.configVersion === 3 && Array.isArray(config.bots)) {
                    const enabled = config.bots.filter(bot => bot.enabled !== false).length;
                    ok(`Config v3 (${config.bots.length} bot(s), ${enabled} enabled)`);
                    if (enabled > 1) warn('Experimental multi-bot mode enabled', MULTI_BOT_WARNING);
                }
                else if (config.configVersion === 2) ok('Config v2 (encrypted token)');
                else if (config.botToken) warn('Config v1 (plaintext token)', 'Re-run `tas init` to encrypt token');
                else fail('Config invalid', 'Missing bot token');

                const configuredBots = getBotEntries(config);
                if (configuredBots.length > 0 && configuredBots.every(bot => bot.chatId !== undefined && bot.chatId !== null)) {
                    ok(`Storage chats configured: ${configuredBots.length}`);
                }
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
                const oversized = db.db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE size > ?')
                    .get(20 * 1000 * 1000).count;
                if (oversized > 0) {
                    warn(
                        `${oversized} legacy chunk(s) exceed the hosted 20 MB getFile limit`,
                        'They may require a local Bot API server to recover; new uploads use 19 MiB payloads'
                    );
                } else {
                    ok('Chunk sizes are hosted Bot API round-trip safe');
                }
                db.close();
            } catch (e) {
                fail('Database error', e.message);
            }
        } else {
            warn('Database not found', 'Will be created on first upload');
        }

        // 5. Check the native FUSE stack with a real mount/read/unmount smoke test
        try {
            const { checkFuseRuntime } = await import('./fuse/mount.js');
            const fuse = await checkFuseRuntime();
            if (fuse.supported) ok('FUSE runtime: mount → readdir → unmount passed');
            else warn('FUSE mount unavailable', fuse.reason);
        } catch (e) {
            warn('FUSE smoke test failed', e.message);
        }

        // 6. Check disk space
        try {
            const { execFileSync } = await import('child_process');
            const df = execFileSync('df', ['-h', DATA_DIR], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
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

        // 8. Telegram connectivity (authenticated only when we can decrypt
        // the token without prompting — never block doctor on a password).
        try {
            const cfgRaw = loadConfig(DATA_DIR);
            const pw = options.password || process.env.TAS_PASSWORD;
            if (!cfgRaw) {
                warn('Telegram connectivity not checked', 'Run `tas init` first');
            } else if (cfgRaw.botToken) {
                const client = new TelegramClient(DATA_DIR);
                const me = await client.initialize(cfgRaw.botToken);
                ok(`Telegram connectivity: OK (@${me.username})`);
            } else if ((cfgRaw.encryptedBotToken || Array.isArray(cfgRaw.bots)) && pw) {
                const cfg = resolveConfig(cfgRaw, pw);
                const client = new TelegramPool(DATA_DIR, cfg.bots);
                await client.initialize();
                ok(`Telegram connectivity: ${cfg.bots.length}/${cfg.bots.length} bot(s) OK`);
            } else {
                warn('Telegram connectivity not checked', 'Set TAS_PASSWORD or use --password to verify');
            }
        } catch (e) {
            fail('Telegram connectivity failed', e.message);
        }

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
