import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { processFile } from '../src/index.js';
import { FileIndex } from '../src/db/index.js';
import { parseHeader } from '../src/utils/chunker.js';

class FakeUploadPool {
    constructor() {
        this.uploads = [];
    }
    selectBotId(_key, index) { return index % 2 === 0 ? 'one' : 'two'; }
    async sendFile(filePath, caption, options) {
        const data = fs.readFileSync(filePath);
        const id = this.uploads.length + 1;
        this.uploads.push({ data, caption, options });
        return { messageId: id, fileId: `file-${id}`, botId: options.botId };
    }
    async deleteMessage() { return true; }
}

describe('Production upload pipeline', () => {
    it('stages resumable chunks, persists bot ownership, hides metadata, and permits duplicate content paths', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-upload-pipeline-'));
        const source = path.join(tempDir, 'secret-name.txt');
        fs.writeFileSync(source, 'production upload pipeline data');
        const pool = new FakeUploadPool();
        const options = {
            password: 'upload-test-password',
            dataDir: tempDir,
            config: { bots: [{ id: 'one', enabled: true }, { id: 'two', enabled: true }] },
            telegramPool: pool,
            updateManifest: false
        };

        await processFile(source, { ...options, customName: 'nested/secret-name.txt' });
        await processFile(source, { ...options, customName: 'copy/secret-name.txt' });

        const db = new FileIndex(path.join(tempDir, 'index.db'));
        db.init();
        assert.equal(db.listAll().length, 2);
        assert.equal(db.getPendingUploads().length, 0);
        const first = db.findByExactName('nested/secret-name.txt');
        assert.equal(db.getChunks(first.id)[0].bot_id, 'one');
        db.addTag(first.id, 'important');
        const shareToken = 'a'.repeat(32);
        db.addShare(first.id, shareToken, new Date(Date.now() + 60_000).toISOString(), 2);
        db.close();

        fs.writeFileSync(source, 'updated production upload pipeline data');
        await processFile(source, {
            ...options,
            customName: 'nested/secret-name.txt',
            replaceExisting: true
        });

        const updatedDb = new FileIndex(path.join(tempDir, 'index.db'));
        updatedDb.init();
        const updated = updatedDb.findByExactName('nested/secret-name.txt');
        assert.notEqual(updated.id, first.id);
        assert.deepEqual(updatedDb.getFileTags(updated.id), ['important']);
        assert.equal(updatedDb.getShare(shareToken).file_id, updated.id);
        updatedDb.close();

        for (const upload of pool.uploads) {
            const header = parseHeader(upload.data);
            assert.equal(header.filename, '');
            assert.equal(header.originalSize, 0);
            assert.ok(!upload.caption.includes('secret-name'));
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
