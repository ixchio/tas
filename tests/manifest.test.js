import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileIndex } from '../src/db/index.js';
import { backupRemoteManifest, downloadRemoteManifest } from '../src/manifest.js';
import { saveConfig } from '../src/utils/cli-helpers.js';
import { createChunkCaption, createPublicChunkHeader } from '../src/index.js';
import { parseHeader } from '../src/utils/chunker.js';

class FakeTelegramPool {
    selectBotId() { return 'primary'; }
    async sendFile(filePath) {
        this.payload = fs.readFileSync(filePath);
        return { botId: 'primary', messageId: 700, fileId: 'manifest-file-id' };
    }
    async downloadFile() { return this.payload; }
    async deleteMessage() { return true; }
}

describe('Encrypted remote manifest recovery', () => {
    let tempDir;
    let config;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-manifest-test-'));
        config = {
            configVersion: 3,
            passwordHash: 'test-only',
            bots: [{ id: 'primary', botToken: '1:test', chatId: 1, enabled: true }],
            createdAt: new Date().toISOString()
        };
        saveConfig(tempDir, config);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('round-trips files, chunk ownership, and tags through authenticated encryption', async () => {
        const db = new FileIndex(path.join(tempDir, 'index.db'));
        db.init();
        const fileId = db.addFile({
            filename: 'nested/report.txt',
            hash: 'f'.repeat(64),
            originalSize: 10,
            storedSize: 12,
            chunks: 1,
            compressed: true
        });
        db.addChunk(fileId, 0, '99', 76, 'telegram-file-id', 'primary');
        db.addTag(fileId, 'work');
        db.addShare(fileId, 'a'.repeat(32), new Date(Date.now() + 60_000).toISOString(), 1);
        db.close();

        const pool = new FakeTelegramPool();
        const pointer = await backupRemoteManifest({
            dataDir: tempDir,
            password: 'manifest-password',
            config,
            telegramPool: pool
        });
        assert.equal(pointer.files, 1);
        assert.ok(!pool.payload.includes(Buffer.from('nested/report.txt')));

        const manifest = await downloadRemoteManifest({
            dataDir: tempDir,
            password: 'manifest-password',
            config,
            telegramPool: pool
        });
        assert.equal(manifest.shares, undefined);

        const rebuilt = new FileIndex(path.join(tempDir, 'rebuilt.db'));
        rebuilt.init();
        rebuilt.importManifest(manifest);
        assert.equal(rebuilt.findByExactName('nested/report.txt').hash, 'f'.repeat(64));
        assert.equal(rebuilt.getChunks(1)[0].bot_id, 'primary');
        assert.deepEqual(rebuilt.getFileTags(1), ['work']);
        assert.equal(rebuilt.listShares().length, 0);
        rebuilt.close();
    });
});

describe('Telegram-visible chunk metadata', () => {
    it('keeps filename and original size out of the public header and caption', () => {
        const header = parseHeader(createPublicChunkHeader(0, 2, 1));
        const caption = createChunkCaption(42, 0, 2);
        assert.equal(header.filename, '');
        assert.equal(header.originalSize, 0);
        assert.equal(caption, 'tas:c1:42:1/2');
        assert.ok(!caption.includes('secret'));
    });
});
