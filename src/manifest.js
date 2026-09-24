/**
 * Encrypted remote index manifest.
 *
 * Telegram file IDs are not discoverable from ciphertext alone. TAS therefore
 * keeps a compact encrypted snapshot of files/chunks/tags and stores
 * the latest manifest pointer in config.json. Losing index.db is recoverable as
 * long as config.json, the password, and the manifest message still exist.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { FileIndex } from './db/index.js';
import { Encryptor } from './crypto/encryption.js';
import { TelegramPool } from './telegram/pool.js';
import { loadConfig, saveConfig } from './utils/cli-helpers.js';
import { MAX_CHUNK_SIZE } from './utils/chunker.js';

const queues = new Map();

async function writeRemoteManifest({ dataDir, password, config, telegramPool }) {
    const db = new FileIndex(path.join(dataDir, 'index.db'));
    db.init();
    const snapshot = db.exportManifest();
    db.close();

    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
    const encrypted = new Encryptor(password).encrypt(compressed);
    if (encrypted.length > MAX_CHUNK_SIZE) {
        throw new Error(
            `Encrypted index manifest is ${encrypted.length} bytes, above the single-message recovery limit. ` +
            'Refusing to publish an incomplete recovery point.'
        );
    }

    const pool = telegramPool || new TelegramPool(dataDir, config.bots);
    const routingKey = `manifest:${snapshot.createdAt}`;
    const botId = pool.selectBotId(routingKey, 0);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-manifest-'));
    const manifestPath = path.join(tempDir, 'tas-index.m1');
    fs.writeFileSync(manifestPath, encrypted, { mode: 0o600 });

    let result;
    try {
        result = await pool.sendFile(manifestPath, 'tas:m1', { botId, routingKey, chunkIndex: 0 });
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { }
    }

    const rawConfig = loadConfig(dataDir);
    if (!rawConfig) throw new Error('Config disappeared while publishing remote manifest');
    const previous = rawConfig.remoteManifest;
    rawConfig.remoteManifest = {
        version: 1,
        botId: result.botId,
        messageId: String(result.messageId),
        fileId: result.fileId,
        createdAt: snapshot.createdAt,
        files: snapshot.files.length,
        chunks: snapshot.chunks.length
    };
    saveConfig(dataDir, rawConfig);

    // The new pointer is durable locally before the prior recovery point is
    // removed. Failure to remove merely leaves an encrypted orphan manifest.
    if (previous?.messageId) {
        try { await pool.deleteMessage(previous.messageId, previous.botId || null); } catch { }
    }
    return rawConfig.remoteManifest;
}

/** Serialize manifest writes inside one TAS process (notably sync workers). */
export function backupRemoteManifest(options) {
    const key = path.resolve(options.dataDir);
    const previous = queues.get(key) || Promise.resolve();
    const next = previous.catch(() => { }).then(() => writeRemoteManifest(options));
    queues.set(key, next);
    return next.finally(() => {
        if (queues.get(key) === next) queues.delete(key);
    });
}

export async function downloadRemoteManifest({ dataDir, password, config, telegramPool }) {
    const rawConfig = loadConfig(dataDir);
    const pointer = rawConfig?.remoteManifest;
    if (!pointer?.fileId) {
        throw new Error('No remote manifest pointer exists in config.json');
    }

    const pool = telegramPool || new TelegramPool(dataDir, config.bots);
    const encrypted = await pool.downloadFile(pointer.fileId, pointer.botId || null);
    let manifest;
    try {
        const compressed = new Encryptor(password).decrypt(encrypted);
        manifest = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    } catch (error) {
        throw new Error(`Remote manifest authentication/decode failed: ${error.message}`);
    }
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.chunks)) {
        throw new Error('Remote manifest is malformed or unsupported');
    }
    return manifest;
}
