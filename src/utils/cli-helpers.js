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

    // v2: encrypted token, v1: plaintext token
    const hasToken = config.encryptedBotToken || config.botToken;
    if (!hasToken) {
        errors.push('Missing bot token (botToken or encryptedBotToken)');
    }

    if (config.botToken && !config.botToken.includes(':')) {
        errors.push('Invalid bot token format (should contain :)');
    }

    if (!config.chatId || (typeof config.chatId !== 'number' && typeof config.chatId !== 'string')) {
        errors.push('Missing or invalid chatId');
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
    return {
        ...config,
        botToken: decryptBotToken(config, password)
    };
}
