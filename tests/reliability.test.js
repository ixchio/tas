/**
 * Reliability regression tests (v2.5.0)
 * Covers user-facing fixes: sync ignore rules, exact-match lookup,
 * and incomplete-upload detection for `tas resume`.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { FileIndex } from '../src/db/index.js';
import { SyncEngine } from '../src/sync/sync.js';

const TEST_DB_PATH = '/tmp/tas-test-reliability.db';

function cleanupDB(dbPath) {
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }
}

describe('Sync ignore rules (dotfiles are user data)', () => {
    test('.env and dotfiles are NOT ignored', () => {
        const engine = new SyncEngine({ dataDir: '/tmp', password: 'x', config: {} });
        assert.strictEqual(engine.shouldIgnore('.env'), false);
        assert.strictEqual(engine.shouldIgnore('.ssh'), false);
        assert.strictEqual(engine.shouldIgnore('keys.env'), false);
        assert.strictEqual(engine.shouldIgnore('report.pdf'), false);
    });

    test('junk files are still ignored', () => {
        const engine = new SyncEngine({ dataDir: '/tmp', password: 'x', config: {} });
        assert.strictEqual(engine.shouldIgnore('.DS_Store'), true);
        assert.strictEqual(engine.shouldIgnore('backup~'), true);
        assert.strictEqual(engine.shouldIgnore('file.swp'), true);
        assert.strictEqual(engine.shouldIgnore('file.tmp'), true);
        assert.strictEqual(engine.shouldIgnore('node_modules'), true);
    });
});

describe('File lookup prefers exact matches', () => {
    let db;

    beforeEach(() => {
        cleanupDB(TEST_DB_PATH);
        db = new FileIndex(TEST_DB_PATH);
        db.init();
    });

    afterEach(() => {
        if (db) db.close();
        cleanupDB(TEST_DB_PATH);
    });

    test('findByName returns the exact match, not a substring hit', () => {
        db.addFile({ filename: 'report-final.pdf', hash: 'a'.repeat(64), originalSize: 10, storedSize: 10, chunks: 1, compressed: false });
        db.addFile({ filename: 'report.pdf', hash: 'b'.repeat(64), originalSize: 10, storedSize: 10, chunks: 1, compressed: false });

        const found = db.findByName('report.pdf');
        assert.ok(found);
        assert.strictEqual(found.filename, 'report.pdf');
    });

    test('findByHash returns the exact match, not a prefix hit', () => {
        const full1 = 'a'.repeat(64);
        const full2 = 'a'.repeat(63) + 'b';
        db.addFile({ filename: 'one.bin', hash: full1, originalSize: 1, storedSize: 1, chunks: 1, compressed: false });
        db.addFile({ filename: 'two.bin', hash: full2, originalSize: 1, storedSize: 1, chunks: 1, compressed: false });

        const found = db.findByHash(full2);
        assert.ok(found);
        assert.strictEqual(found.filename, 'two.bin');
    });
});

describe('Incomplete upload detection (tas resume)', () => {
    let db;

    beforeEach(() => {
        cleanupDB(TEST_DB_PATH);
        db = new FileIndex(TEST_DB_PATH);
        db.init();
    });

    afterEach(() => {
        if (db) db.close();
        cleanupDB(TEST_DB_PATH);
    });

    test('detects a file row with fewer chunk rows than expected', () => {
        const fileId = db.addFile({
            filename: 'partial.bin',
            hash: 'c'.repeat(64),
            originalSize: 100,
            storedSize: 50,
            chunks: 3, // claims 3 chunks...
            compressed: false
        });
        db.addChunk(fileId, 0, 'msg-0', 50); // ...but only 1 uploaded

        const orphans = db.getIncompleteUploads();
        assert.strictEqual(orphans.length, 1);
        assert.strictEqual(orphans[0].filename, 'partial.bin');
    });

    test('complete files are not flagged', () => {
        const fileId = db.addFile({
            filename: 'whole.bin',
            hash: 'd'.repeat(64),
            originalSize: 100,
            storedSize: 100,
            chunks: 1,
            compressed: false
        });
        db.addChunk(fileId, 0, 'msg-0', 100);

        assert.strictEqual(db.getIncompleteUploads().length, 0);
    });

    test('deleteFileCascade removes file and its chunks', () => {
        const fileId = db.addFile({
            filename: 'gone.bin',
            hash: 'e'.repeat(64),
            originalSize: 10,
            storedSize: 10,
            chunks: 1,
            compressed: false
        });
        db.addChunk(fileId, 0, 'msg-0', 10);

        db.deleteFileCascade(fileId);

        assert.strictEqual(db.findByHash('e'.repeat(64)), undefined);
        assert.strictEqual(db.getChunks(fileId).length, 0);
    });
});
