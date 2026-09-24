/**
 * CLI Helper utilities
 * Shared logic for commands
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { Encryptor } from '../crypto/encryption.js';

/**
 * Get password from command-line option, environment variable, or interactive prompt
 * @param {string} passwordOption - Password from --password flag (if provided)
 * @param {boolean} allowCache - Allow caching via TAS_PASSWORD env var
 * @returns {Promise<string>}
 */
export async function getPassword(passwordOption, allowCache = true) {
    // Priority: CLI flag > Environment variable > Interactive prompt
    
    if (passwordOption) {
        return passwordOption;
    }

    if (allowCache && process.env.TAS_PASSWORD) {
        return process.env.TAS_PASSWORD;
    }

    const { password } = await inquirer.prompt([
        {
            type: 'password',
            name: 'password',
            message: 'Enter your encryption password:',
            mask: '*'
        }
    ]);

    return password;
}

/**
 * Verify password against config (supports both legacy and new hash formats)
 * @param {string} password - Password to verify
 * @param {Object} config - Config object with passwordHash
 * @returns {boolean}
 */
export function verifyPassword(password, config) {
    return Encryptor.verifyPasswordHash(password, config.passwordHash);
}

/**
 * Validate config structure and content
 * @param {Object} config - Config to validate
 * @returns {Object} - { valid: boolean, errors: string[] }
 */
export function validateConfig(config) {
    const errors = [];

    if (!config) {
        errors.push('Config is null or undefined');
        return { valid: false, errors };
    }

    const bots = getBotEntries(config);
    if (bots.length === 0) errors.push('Missing bot configuration');

    const seenIds = new Set();
    for (const bot of bots) {
        if (!bot.id || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(bot.id)) {
            errors.push(`Invalid bot id: ${bot.id || '(missing)'}`);
        } else if (seenIds.has(bot.id)) {
            errors.push(`Duplicate bot id: ${bot.id}`);
        }
        seenIds.add(bot.id);

        if (!bot.encryptedBotToken && !bot.botToken) {
            errors.push(`Missing token for bot ${bot.id || '(unknown)'}`);
        }
        if (bot.botToken && !bot.botToken.includes(':')) {
            errors.push(`Invalid token format for bot ${bot.id || '(unknown)'}`);
        }
        if (bot.chatId === undefined || bot.chatId === null ||
            (typeof bot.chatId !== 'number' && typeof bot.chatId !== 'string')) {
            errors.push(`Missing or invalid chatId for bot ${bot.id || '(unknown)'}`);
        }
    }

    if (bots.length > 0 && !bots.some(bot => bot.enabled !== false)) {
        errors.push('At least one bot must be enabled');
    }

    if (!config.passwordHash || typeof config.passwordHash !== 'string') {
        errors.push('Missing or invalid passwordHash');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Return normalized raw bot entries. v1/v2 configs are represented as one
 * stable `primary` bot so existing vaults require no migration to keep working.
 */
export function getBotEntries(config) {
    if (!config) return [];
    if (Array.isArray(config.bots)) {
        return config.bots.map((bot, index) => ({
            ...bot,
            id: bot.id || (index === 0 ? 'primary' : `bot-${index + 1}`),
            enabled: bot.enabled !== false
        }));
    }

    if (config.encryptedBotToken || config.botToken) {
        return [{
            id: 'primary',
            encryptedBotToken: config.encryptedBotToken,
            botToken: config.botToken,
            chatId: config.chatId,
            username: config.username,
            enabled: true,
            createdAt: config.createdAt
        }];
    }

    return [];
}

/**
 * Decrypt bot token from config using password
 * Supports both v1 (plaintext) and v2 (encrypted) configs
 * @param {Object} config - Config object
 * @param {string} password - User's password
 * @returns {string} - Decrypted bot token
 */
export function decryptBotToken(config, password) {
    // v1: plaintext token (backward compatibility)
    if (config.botToken) {
        return config.botToken;
    }

    // v2: encrypted token
    if (config.encryptedBotToken) {
        const encryptor = new Encryptor(password);
        const encryptedBuffer = Buffer.from(config.encryptedBotToken, 'base64');
        return encryptor.decrypt(encryptedBuffer).toString('utf-8');
    }

    throw new Error('No bot token found in config');
}

/** Decrypt one normalized bot entry. */
export function decryptBotEntry(bot, password) {
    return {
        ...bot,
        botToken: decryptBotToken(bot, password)
    };
}

/** Encrypt a bot token with the vault password. */
export function encryptBotToken(token, password) {
    const encryptor = new Encryptor(password);
    return encryptor.encrypt(Buffer.from(token, 'utf-8')).toString('base64');
}

/**
 * Load and validate config
 * @param {string} dataDir - Data directory path
 * @returns {Object|null} - Config object or null if not found
 */
export function loadConfig(dataDir) {
    const configPath = path.join(dataDir, 'config.json');
    
    if (!fs.existsSync(configPath)) {
        return null;
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const validation = validateConfig(config);

        if (!validation.valid) {
            throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
        }

        return config;
    } catch (err) {
        throw new Error(`Config error: ${err.message}`);
    }
}

/**
 * Ensure TAS is initialized
 * @param {string} dataDir - Data directory path
 * @returns {Object} - Config object
 */
export function requireConfig(dataDir) {
    const config = loadConfig(dataDir);
    
    if (!config) {
        console.log(chalk.red('✗ TAS not initialized. Run `tas init` first.'));
        process.exit(1);
    }

    return config;
}

/**
 * Get and verify password with proper error handling
 * @param {string} passwordOption - Password from CLI flag
 * @param {string} dataDir - Data directory path
 * @returns {Promise<string>} - Verified password
 */
export async function getAndVerifyPassword(passwordOption, dataDir) {
    const config = requireConfig(dataDir);
    const password = await getPassword(passwordOption);

    if (!verifyPassword(password, config)) {
        console.log(chalk.red('✗ Incorrect password'));
        process.exit(1);
    }

    return password;
}

/**
 * Resolve config by decrypting bot token if needed.
 * Returns a config object with a guaranteed plaintext `botToken` field.
 * @param {Object} config - Raw config from disk
 * @param {string} password - Verified password
 * @returns {Object} - Config with decrypted botToken
 */
export function resolveConfig(config, password) {
    // Reuse one derived key across the pool; deriving PBKDF2 separately for
    // every bot made startup scale linearly with the number of configured bots.
    const encryptor = new Encryptor(password);
    const bots = getBotEntries(config).map(bot => ({
        ...bot,
        botToken: bot.botToken || encryptor.decrypt(Buffer.from(bot.encryptedBotToken, 'base64')).toString('utf-8')
    }));
    const primary = bots.find(bot => bot.id === 'primary') || bots[0];

    return {
        ...config,
        bots,
        // Keep these aliases for third-party callers that still consume the
        // v1/v2 shape. New code routes through `bots` and persists bot IDs.
        botToken: primary.botToken,
        chatId: primary.chatId,
        username: primary.username
    };
}

/** Write config atomically enough for this local CLI and restore mode 0600. */
export function saveConfig(dataDir, config) {
    const configPath = path.join(dataDir, 'config.json');
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, configPath);
    try { fs.chmodSync(configPath, 0o600); } catch { /* ignore on Windows */ }
}
