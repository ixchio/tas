/**
 * Telegram Bot client wrapper
 * Uses official Telegram Bot API - 2GB file limit, FREE, no ban risk!
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

export class TelegramClient {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.bot = null;
        this.chatId = null;
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
     * Send a file to the storage chat
     * Telegram supports up to 2GB for documents!
     */
    async sendFile(filePath, caption = '', options = {}) {
        if (!this.chatId) {
            throw new Error('Chat ID not set. Run init first.');
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        try {
            let fileStream = fs.createReadStream(filePath);
            const filename = path.basename(filePath);

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
        } catch (err) {
            throw new Error(`Failed to upload to Telegram: ${err.message}`);
        }
    }

    /**
     * Download a file from Telegram (In-Memory buffer)
     */
    async downloadFile(fileId) {
        // Get file path from Telegram servers
        const file = await this.bot.getFile(fileId);

        // Download the file
        const fileStream = await this.bot.getFileStream(fileId);

        // Collect chunks into buffer
        const chunks = [];
        for await (const chunk of fileStream) {
            chunks.push(chunk);
        }

        return Buffer.concat(chunks);
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
