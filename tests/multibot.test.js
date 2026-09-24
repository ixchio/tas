import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { FileIndex } from '../src/db/index.js';
import { getBotEntries, resolveConfig } from '../src/utils/cli-helpers.js';
import { getEnabledBots, selectBotId } from '../src/telegram/pool.js';
import { TelegramClient } from '../src/telegram/client.js';
import { MAX_CHUNK_SIZE } from '../src/utils/chunker.js';

describe('Multi-bot configuration', () => {
    it('normalizes a legacy v2 config to a stable primary bot', () => {
        const bots = getBotEntries({
            encryptedBotToken: 'ciphertext',
            chatId: 123,
            username: 'legacy_bot'
        });

        assert.equal(bots.length, 1);
        assert.equal(bots[0].id, 'primary');
        assert.equal(bots[0].chatId, 123);
        assert.equal(bots[0].enabled, true);
    });

    it('resolves all configured bot tokens and keeps legacy aliases', () => {
        const config = resolveConfig({
            bots: [
                { id: 'primary', botToken: '1:first', chatId: 10, enabled: true },
                { id: 'archive', botToken: '2:second', chatId: 20, enabled: false }
            ]
        }, 'unused-for-plaintext-tokens');

        assert.equal(config.bots.length, 2);
        assert.equal(config.bots[1].botToken, '2:second');
        assert.equal(config.botToken, '1:first');
        assert.equal(config.chatId, 10);
    });

    it('routes deterministically across enabled bots only', () => {
        const bots = [
            { id: 'one', enabled: true },
            { id: 'disabled', enabled: false },
            { id: 'two', enabled: true }
        ];

        assert.deepEqual(getEnabledBots(bots).map(bot => bot.id), ['one', 'two']);
        const route = Array.from({ length: 4 }, (_, index) => selectBotId(bots, 'file-hash', index));
        assert.equal(route[0], route[2]);
        assert.equal(route[1], route[3]);
        assert.notEqual(route[0], route[1]);
        assert.ok(!route.includes('disabled'));
    });

    it('keeps every new stored document below the hosted getFile limit', () => {
        assert.ok(MAX_CHUNK_SIZE + 64 < 20_000_000);
    });
});

describe('Multi-bot database migration', () => {
    let tempDir;
    let dbPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-multibot-'));
        dbPath = path.join(tempDir, 'index.db');
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('adds bot_id to a pre-multi-bot chunks table', () => {
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                message_id TEXT NOT NULL,
                file_telegram_id TEXT,
                size INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(file_id, chunk_index)
            );
        `);
        legacy.close();

        const index = new FileIndex(dbPath);
        index.init();
        const columns = index.db.pragma('table_info(chunks)').map(column => column.name);
        assert.ok(columns.includes('bot_id'));
        index.close();
    });

    it('migrates the legacy UNIQUE hash constraint so two paths can hold identical bytes', () => {
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                hash TEXT UNIQUE NOT NULL,
                original_size INTEGER NOT NULL,
                stored_size INTEGER NOT NULL,
                chunks INTEGER NOT NULL DEFAULT 1,
                compressed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
        legacy.close();

        const index = new FileIndex(dbPath);
        index.init();
        const data = { hash: 'd'.repeat(64), originalSize: 1, storedSize: 1, chunks: 1, compressed: false };
        index.addFile({ ...data, filename: 'one/file.txt' });
        index.addFile({ ...data, filename: 'two/file.txt' });
        assert.equal(index.db.prepare('SELECT COUNT(*) AS count FROM files WHERE hash = ?').get(data.hash).count, 2);
        index.close();
    });

    it('preserves legacy chunk foreign keys while rebuilding the files table', () => {
        const legacy = new Database(dbPath);
        legacy.pragma('foreign_keys = ON');
        legacy.exec(`
            CREATE TABLE files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                hash TEXT UNIQUE NOT NULL,
                original_size INTEGER NOT NULL,
                stored_size INTEGER NOT NULL,
                chunks INTEGER NOT NULL DEFAULT 1,
                compressed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                message_id TEXT NOT NULL,
                file_telegram_id TEXT,
                size INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
                UNIQUE(file_id, chunk_index)
            );
            INSERT INTO files (filename, hash, original_size, stored_size, chunks, compressed)
            VALUES ('legacy.bin', '${'c'.repeat(64)}', 1, 1, 1, 0);
            INSERT INTO chunks (file_id, chunk_index, message_id, file_telegram_id, size)
            VALUES (1, 0, '7', 'legacy-file-id', 65);
        `);
        legacy.close();

        const index = new FileIndex(dbPath);
        index.init();
        assert.equal(index.getChunks(1).length, 1);
        assert.deepEqual(index.db.pragma('foreign_key_check'), []);
        index.deleteFileCascade(1);
        assert.equal(index.getChunks(1).length, 0);
        index.close();
    });

    it('persists chunk ownership and counts legacy NULL rows as primary', () => {
        const index = new FileIndex(dbPath);
        index.init();
        const fileId = index.addFile({
            filename: 'example.bin',
            hash: 'a'.repeat(64),
            originalSize: 2,
            storedSize: 2,
            chunks: 2,
            compressed: false
        });

        index.addChunk(fileId, 0, '100', 1, 'file-a', null);
        index.addChunk(fileId, 1, '101', 1, 'file-b', 'secondary');

        const chunks = index.getChunks(fileId);
        assert.equal(chunks[1].bot_id, 'secondary');
        assert.equal(index.countChunksByBot('primary'), 1);
        assert.equal(index.countChunksByBot('secondary'), 1);
        index.close();
    });

    it('persists resumable chunk state without double-counting retries', () => {
        const index = new FileIndex(dbPath);
        index.init();
        const pendingId = index.addPendingUpload({
            filename: 'nested/file.bin',
            filePath: '/source/file.bin',
            hash: 'e'.repeat(64),
            originalSize: 100,
            storedSize: 80,
            compressed: true,
            totalChunks: 1,
            tempDir
        });
        index.addPendingChunk(pendingId, 0, path.join(tempDir, 'chunk.tas'), 144);
        index.markChunkUploaded(pendingId, 0, '10', 'file-id', 'secondary');
        index.markChunkUploaded(pendingId, 0, '10', 'file-id', 'secondary');

        const pending = index.getPendingUploads()[0];
        const chunk = index.getPendingChunks(pendingId)[0];
        assert.equal(pending.uploaded_chunks, 1);
        assert.equal(pending.stored_size, 80);
        assert.equal(pending.compressed, 1);
        assert.equal(chunk.size, 144);
        assert.equal(chunk.bot_id, 'secondary');
        index.close();
    });
});

describe('Per-bot global send queue', () => {
    it('serializes concurrent sync-worker sends through one client', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-send-queue-'));
        const filePath = path.join(tempDir, 'chunk.tas');
        fs.writeFileSync(filePath, 'chunk');
        const client = new TelegramClient(tempDir);
        client.chatId = 1;
        let active = 0;
        let maxActive = 0;
        let messageId = 0;
        client._rateLimit = async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
        };
        client.bot = {
            async sendDocument(chatId, stream) {
                for await (const _chunk of stream) { /* consume like Telegram client */ }
                return { message_id: ++messageId, document: { file_id: `file-${messageId}` }, date: 0 };
            }
        };

        await Promise.all([
            client.sendFile(filePath),
            client.sendFile(filePath),
            client.sendFile(filePath)
        ]);
        assert.equal(maxActive, 1);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
