import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { processFile, retrieveFile } from '../src/index.js';
import { FileIndex } from '../src/db/index.js';
import { pruneOrphanedStaging, resumePendingUploads } from '../src/uploads/resume.js';
import { SyncEngine } from '../src/sync/sync.js';
import { saveConfig } from '../src/utils/cli-helpers.js';

class FakePool {
    constructor({ failSends = 0, corruptDownloads = false } = {}) {
        this.failSends = failSends;
        this.corruptDownloads = corruptDownloads;
        this.uploads = [];
        this.deleted = [];
    }

    selectBotId() { return 'primary'; }

    async sendFile(filePath, caption, options) {
        if (this.failSends > 0) {
            this.failSends--;
            throw new Error('simulated network failure');
        }
        const data = fs.readFileSync(filePath);
        const id = this.uploads.length + 1;
        const upload = { data, caption, options, messageId: id, fileId: `file-${id}`, botId: 'primary' };
        this.uploads.push(upload);
        return upload;
    }

    async downloadFile(fileId) {
        const upload = this.uploads.find(item => item.fileId === fileId);
        if (!upload) throw new Error(`missing fake upload ${fileId}`);
        const data = Buffer.from(upload.data);
        if (this.corruptDownloads && data.length > 64) data[data.length - 1] ^= 0xff;
        return data;
    }

    async deleteMessage(messageId) {
        this.deleted.push(String(messageId));
        return true;
    }
}

function makeWorkspace(prefix = 'tas-resume-') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    return { root, dataDir };
}

function uploadOptions(dataDir, pool) {
    return {
        password: 'resume-test-password',
        dataDir,
        config: { bots: [{ id: 'primary', enabled: true }] },
        telegramPool: pool,
        updateManifest: false
    };
}

describe('Automatic upload recovery', () => {
    it('resumes a staged upload, finalizes the index, and removes staging files', async () => {
        const { root, dataDir } = makeWorkspace();
        try {
            const source = path.join(root, 'report.txt');
            fs.writeFileSync(source, 'recover this upload');
            await assert.rejects(
                processFile(source, uploadOptions(dataDir, new FakePool({ failSends: 1 }))),
                /upload paused/
            );

            const db = new FileIndex(path.join(dataDir, 'index.db'));
            db.init();
            const pending = db.getPendingUploads()[0];
            assert.ok(pending);
            assert.ok(fs.existsSync(pending.temp_dir));

            const pool = new FakePool();
            const result = await resumePendingUploads({
                ...uploadOptions(dataDir, pool),
                db,
                updateManifest: false
            });

            assert.equal(result.completed, 1);
            assert.equal(result.remaining, 0);
            assert.equal(db.getPendingUploads().length, 0);
            assert.equal(db.findByExactName('report.txt').hash, pending.hash);
            assert.equal(fs.existsSync(pending.temp_dir), false);
            db.close();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('preflights missing staged chunks without creating more Telegram orphans', async () => {
        const { root, dataDir } = makeWorkspace();
        try {
            const db = new FileIndex(path.join(dataDir, 'index.db'));
            db.init();
            const pendingId = db.addPendingUpload({
                filename: 'missing.bin',
                filePath: path.join(root, 'missing.bin'),
                hash: 'a'.repeat(64),
                originalSize: 10,
                storedSize: 10,
                compressed: false,
                totalChunks: 1,
                uploadedChunks: 0,
                tempDir: path.join(dataDir, 'tmp', 'aaaaaaaaaaaa-missing')
            });
            db.addPendingChunk(pendingId, 0, path.join(root, 'does-not-exist.tas'), 74);

            const pool = new FakePool();
            const result = await resumePendingUploads({
                ...uploadOptions(dataDir, pool),
                db,
                updateManifest: false
            });

            assert.equal(result.completed, 0);
            assert.equal(result.remaining, 1);
            assert.equal(result.failed.length, 1);
            assert.match(result.failed[0].error.message, /Staged chunk is missing/);
            assert.equal(pool.uploads.length, 0);
            db.close();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('blocks duplicate staging for a logical path that is already pending', async () => {
        const { root, dataDir } = makeWorkspace();
        try {
            const source = path.join(root, 'duplicate.txt');
            fs.writeFileSync(source, 'one pending upload only');
            await assert.rejects(
                processFile(source, uploadOptions(dataDir, new FakePool({ failSends: 1 }))),
                /upload paused/
            );
            await assert.rejects(
                processFile(source, uploadOptions(dataDir, new FakePool())),
                /interrupted upload already owns/
            );

            const db = new FileIndex(path.join(dataDir, 'index.db'));
            db.init();
            assert.equal(db.getPendingUploads().length, 1);
            db.close();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('prunes only stale unreferenced TAS staging directories', () => {
        const { root, dataDir } = makeWorkspace();
        try {
            const staging = path.join(dataDir, 'tmp');
            const referenced = path.join(staging, 'bbbbbbbbbbbb-live');
            const orphan = path.join(staging, 'cccccccccccc-orphan');
            const unrelated = path.join(staging, 'not-owned-by-tas');
            for (const directory of [referenced, orphan, unrelated]) fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(orphan, 'chunk.tas'), 'reclaim me');
            const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
            fs.utimesSync(orphan, old, old);
            fs.utimesSync(unrelated, old, old);

            const db = new FileIndex(path.join(dataDir, 'index.db'));
            db.init();
            db.addPendingUpload({
                filename: 'live.bin',
                filePath: '/tmp/live.bin',
                hash: 'b'.repeat(64),
                originalSize: 1,
                storedSize: 1,
                compressed: false,
                totalChunks: 1,
                uploadedChunks: 0,
                tempDir: referenced
            });

            const result = pruneOrphanedStaging({ dataDir, db, olderThanMs: 1000 });
            assert.equal(result.removed, 1);
            assert.equal(result.reclaimedBytes, 10);
            assert.equal(fs.existsSync(orphan), false);
            assert.equal(fs.existsSync(referenced), true);
            assert.equal(fs.existsSync(unrelated), true);
            db.close();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('auto-resumes before a sync scan and rebuilds missing sync state', async () => {
        const { root, dataDir } = makeWorkspace();
        try {
            const watched = path.join(root, 'watched');
            fs.mkdirSync(watched);
            const source = path.join(watched, 'note.txt');
            fs.writeFileSync(source, 'sync recovery');
            const config = { configVersion: 3, bots: [{ id: 'primary', enabled: true }] };
            saveConfig(dataDir, config);

            await assert.rejects(
                processFile(source, {
                    ...uploadOptions(dataDir, new FakePool({ failSends: 1 })),
                    customName: 'note.txt'
                }),
                /upload paused/
            );

            const db = new FileIndex(path.join(dataDir, 'index.db'));
            db.init();
            const folderId = db.addSyncFolder(watched);
            const engine = new SyncEngine({
                dataDir,
                password: 'resume-test-password',
                config,
                autoResume: true
            });
            engine.db = db;
            engine.telegramPool = new FakePool();
            engine.watchFolder = () => { };

            await engine.start();

            assert.equal(db.getPendingUploads().length, 0);
            assert.ok(db.findByExactName('note.txt'));
            assert.ok(db.getSyncState(folderId, 'note.txt'));
            engine.stop();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('Atomic downloads', () => {
    it('keeps an existing destination intact when verification fails', async () => {
        const { root, dataDir } = makeWorkspace('tas-download-');
        try {
            const source = path.join(root, 'source.txt');
            const output = path.join(root, 'output.txt');
            fs.writeFileSync(source, 'authentic remote content');
            fs.writeFileSync(output, 'known good local copy');

            const pool = new FakePool();
            await processFile(source, uploadOptions(dataDir, pool));
            const db = new FileIndex(path.join(dataDir, 'index.db'));
            db.init();
            const record = db.findByExactName('source.txt');
            db.close();
            pool.corruptDownloads = true;

            await assert.rejects(
                retrieveFile(record, {
                    password: 'resume-test-password',
                    dataDir,
                    outputPath: output,
                    config: uploadOptions(dataDir, pool).config,
                    telegramPool: pool
                })
            );

            assert.equal(fs.readFileSync(output, 'utf8'), 'known good local copy');
            assert.equal(fs.readdirSync(root).some(name => name.includes('.tas-part-')), false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
