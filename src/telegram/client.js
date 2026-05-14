/**
 * Telegram Bot client wrapper
 * Uses official Telegram Bot API - 2GB file limit, FREE, no ban risk!
 * Includes exponential backoff retry and rate limiting for production reliability.
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;

/**
 * Retry an async function with exponential backoff + jitter.
 * Handles Telegram 429 (rate limit) errors by respecting retry_after.
 */
async function withRetry(fn, label = 'operation', retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isRateLimit = err?.response?.statusCode === 429 || err?.message?.includes('429');
            const isTransient = err?.code === 'ETIMEOUT' || err?.code === 'ECONNRESET' ||
                err?.code === 'ENOTFOUND' || err?.message?.includes('ETIMEDOUT');

            if (attempt >= retries) throw err;
            if (!isRateLimit && !isTransient) throw err;

            let delay;
            if (isRateLimit && err?.response?.body?.parameters?.retry_after) {
                delay = err.response.body.parameters.retry_after * 1000 + 500;
            } else {
                delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000, MAX_DELAY_MS);
            }

            const sec = (delay / 1000).toFixed(1);
            console.log(`⏳ ${label} failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${sec}s...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

export class TelegramClient {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.bot = null;
        this.chatId = null;
        this._lastSendTime = 0;
    }

    /**
     * Initialize with bot token
     * Get token from @BotFather on Telegram
     */
    async initialize(token, customApiUrl = null) {
        const options = { polling: false };
        if (customApiUrl) {
            options.baseApiUrl = customApiUrl;
        }
        this.bot = new TelegramBot(token, options);

        // Verify the token works
        try {
            const me = await this.bot.getMe();
            console.log(`✓ Connected as @${me.username}`);
            return me;
        } catch (err) {
            throw new Error(`Invalid bot token: ${err.message}`);
        }
    }

    /**
     * Set the chat ID for storage (your personal chat with the bot)
     */
    setChatId(chatId) {
        this.chatId = chatId;
    }

    /**
     * Wait for user to send a message to get their chat ID
     * This is needed for first-time setup
     */
    async waitForChatId(timeout = 120000) {
        return new Promise((resolve, reject) => {
            const pollingBot = new TelegramBot(this.bot.token, { polling: true });

            const timer = setTimeout(() => {
                pollingBot.stopPolling();
                reject(new Error('Timeout waiting for message. Please message your bot on Telegram.'));
            }, timeout);

            pollingBot.on('message', (msg) => {
                clearTimeout(timer);
                pollingBot.stopPolling();
                this.chatId = msg.chat.id;
                resolve({
                    chatId: msg.chat.id,
                    username: msg.from.username,
                    firstName: msg.from.first_name
                });
            });

            pollingBot.on('polling_error', (err) => {
                // Ignore polling errors during shutdown
                if (!err.message.includes('ETELEGRAM')) {
                    console.error('Polling error:', err.message);
                }
            });
        });
    }

    /**
     * Rate-limit: ensure at least 1s between sends to same chat (Telegram limit)
     */
    async _rateLimit() {
        const now = Date.now();
        const elapsed = now - this._lastSendTime;
        if (elapsed < 1000) {
            await new Promise(r => setTimeout(r, 1000 - elapsed));
        }
        this._lastSendTime = Date.now();
    }

    /**
     * Send a file to the storage chat
     * Telegram supports up to 2GB for documents!
     * Includes automatic retry with exponential backoff.
     */
    async sendFile(filePath, caption = '', options = {}) {
        if (!this.chatId) {
            throw new Error('Chat ID not set. Run init first.');
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const filename = path.basename(filePath);

        return withRetry(async () => {
            await this._rateLimit();

            let fileStream = fs.createReadStream(filePath);

            if (options.limitRate) {
                const { Throttle } = await import('../utils/throttle.js');
                fileStream = fileStream.pipe(new Throttle(options.limitRate));
            }

            const message = await this.bot.sendDocument(this.chatId, fileStream, {
                caption: caption
            }, {
                filename: filename,
                contentType: 'application/octet-stream'
            });

            return {
                messageId: message.message_id,
                fileId: message.document.file_id,
                timestamp: message.date
            };
        }, `Upload ${filename}`);
    }

    /**
     * Download a file from Telegram (In-Memory buffer)
     * Includes automatic retry with exponential backoff.
     */
    async downloadFile(fileId) {
        return withRetry(async () => {
            const fileStream = await this.bot.getFileStream(fileId);

            const chunks = [];
            for await (const chunk of fileStream) {
                chunks.push(chunk);
            }

            return Buffer.concat(chunks);
        }, `Download ${fileId.substring(0, 12)}...`);
    }

    /**
     * Efficiently download a file from Telegram straight to disk
     */
    async downloadFileToPath(fileId, destPath) {
        const fileStream = await this.bot.getFileStream(fileId);
        const writeStream = fs.createWriteStream(destPath);
        await pipeline(fileStream, writeStream);
        return destPath;
    }

    /**
     * Delete a message (optional cleanup)
     */
    async deleteMessage(messageId) {
        try {
            await this.bot.deleteMessage(this.chatId, messageId);
            return true;
        } catch (err) {
            // Message might already be deleted
            return false;
        }
    }
}
