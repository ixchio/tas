/**
 * Multi-bot routing for TAS.
 *
 * A bot is a storage endpoint, not a durability boundary: Telegram controls
 * every endpoint. Bot IDs are persisted with each chunk so reads and deletes
 * always go back through the bot that created the Telegram file ID.
 */

import crypto from 'crypto';
import { TelegramClient } from './client.js';

export const MULTI_BOT_WARNING =
    'Experimental: multiple bots do not guarantee extra quota, durability, ban avoidance, or Terms compliance. ' +
    'Do not use this feature to evade Telegram limits. Use it at your own risk and keep an independent backup.';

export function getEnabledBots(bots) {
    return (bots || []).filter(bot => bot.enabled !== false);
}

/**
 * Pick a stable enabled bot for a chunk. The file key chooses the starting
 * offset and the chunk index walks the pool, which distributes a multi-chunk
 * file without making a retry choose a different endpoint.
 */
export function selectBotId(bots, routingKey, chunkIndex = 0) {
    const enabled = getEnabledBots(bots);
    if (enabled.length === 0) throw new Error('No enabled Telegram bots configured');

    const digest = crypto.createHash('sha256').update(String(routingKey || '')).digest();
    const offset = digest.readUInt32BE(0) % enabled.length;
    return enabled[(offset + chunkIndex) % enabled.length].id;
}

export class TelegramPool {
    constructor(dataDir, bots) {
        if (!Array.isArray(bots) || bots.length === 0) {
            throw new Error('No Telegram bots configured');
        }

        this.dataDir = dataDir;
        this.bots = bots;
        this.botById = new Map(bots.map(bot => [bot.id, bot]));
        this.clientPromises = new Map();
    }

    async initialize({ includeDisabled = true } = {}) {
        const bots = includeDisabled ? this.bots : getEnabledBots(this.bots);
        await Promise.all(bots.map(bot => this._getClient(bot.id)));
        return this;
    }

    selectBotId(routingKey, chunkIndex = 0) {
        return selectBotId(this.bots, routingKey, chunkIndex);
    }

    _normalizeBotId(botId) {
        if (botId && this.botById.has(botId)) return botId;
        if (!botId && this.botById.has('primary')) return 'primary';
        if (!botId && this.bots.length === 1) return this.bots[0].id;
        throw new Error(`Telegram bot ${botId || '(legacy primary)'} is not configured`);
    }

    async _getClient(botId) {
        const normalizedId = this._normalizeBotId(botId);
        if (!this.clientPromises.has(normalizedId)) {
            const bot = this.botById.get(normalizedId);
            const promise = (async () => {
                const client = new TelegramClient(this.dataDir);
                await client.initialize(bot.botToken, bot.customApiUrl || null);
                client.setChatId(bot.chatId);
                return client;
            })();
            this.clientPromises.set(normalizedId, promise);
        }
        return this.clientPromises.get(normalizedId);
    }

    async sendFile(filePath, caption = '', options = {}) {
        const botId = options.botId || this.selectBotId(options.routingKey, options.chunkIndex || 0);
        const client = await this._getClient(botId);
        const { botId: _botId, routingKey: _routingKey, chunkIndex: _chunkIndex, ...clientOptions } = options;
        const result = await client.sendFile(filePath, caption, clientOptions);
        return { ...result, botId };
    }

    async downloadFile(fileId, botId = null) {
        const client = await this._getClient(botId);
        return client.downloadFile(fileId);
    }

    async downloadFileToPath(fileId, destPath, botId = null) {
        const client = await this._getClient(botId);
        return client.downloadFileToPath(fileId, destPath);
    }

    async getFile(fileId, botId = null) {
        const client = await this._getClient(botId);
        return client.bot.getFile(fileId);
    }

    async deleteMessage(messageId, botId = null) {
        const client = await this._getClient(botId);
        return client.deleteMessage(messageId);
    }
}
