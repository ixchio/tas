/**
 * Share feature tests
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { FileIndex } from '../src/db/index.js';
import { generateToken, parseDuration } from '../src/share/server.js';

const TEST_DB_PATH = '/tmp/tas-test-share.db';

// Helper to clean up DB files
function cleanDb() {
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB_PATH + suffix); } catch (e) { }
    }
}

describe('Share Token & Duration', () => {
    test('generates unique tokens', () => {
        const tokens = new Set();
        for (let i = 0; i < 100; i++) {
            tokens.add(generateToken());
        }
        assert.strictEqual(tokens.size, 100, 'All tokens should be unique');
    });

    test('token is 32 hex characters', () => {
        const token = generateToken();
        assert.strictEqual(token.length, 32);
        assert.match(token, /^[a-f0-9]+$/);
    });

    test('parses duration — hours', () => {
        assert.strictEqual(parseDuration('1h'), 3600000);
        assert.strictEqual(parseDuration('24h'), 86400000);
    });

    test('parses duration — days', () => {
        assert.strictEqual(parseDuration('7d'), 604800000);
        assert.strictEqual(parseDuration('1d'), 86400000);
    });

    test('parses duration — minutes', () => {
        assert.strictEqual(parseDuration('30m'), 1800000);
    });

    test('rejects invalid duration', () => {
        assert.throws(() => parseDuration('invalid'));
        assert.throws(() => parseDuration('24'));
        assert.throws(() => parseDuration('h'));
    });
});

describe('Share DB Operations', () => {
    let db;
    let fileId;

    beforeEach(() => {
        cleanDb();
        db = new FileIndex(TEST_DB_PATH);
        db.init();

        // Add a test file
        fileId = db.addFile({
            filename: 'test-file.pdf',
            hash: 'abc123def456',
            originalSize: 1024,
            storedSize: 900,
            chunks: 1,
            compressed: true
        });
    });

    afterEach(() => {
        if (db) db.close();
        cleanDb();
    });

    test('can create a share', () => {
        const token = generateToken();
        const expires = new Date(Date.now() + 86400000).toISOString();

        const id = db.addShare(fileId, token, expires, 3);
        assert.ok(id);
    });

    test('can retrieve a share by token', () => {
        const token = generateToken();
        const expires = new Date(Date.now() + 86400000).toISOString();

        db.addShare(fileId, token, expires, 5);

        const share = db.getShare(token);
        assert.ok(share);
        assert.strictEqual(share.token, token);
        assert.strictEqual(share.filename, 'test-file.pdf');
        assert.strictEqual(share.max_downloads, 5);
        assert.strictEqual(share.download_count, 0);
    });

    test('returns null for nonexistent token', () => {
        const share = db.getShare('nonexistent');
        assert.strictEqual(share, null);
    });

    test('can list all shares', () => {
        const expires = new Date(Date.now() + 86400000).toISOString();

        db.addShare(fileId, generateToken(), expires, 1);
        db.addShare(fileId, generateToken(), expires, 1);
        db.addShare(fileId, generateToken(), expires, 1);

        const shares = db.listShares();
        assert.strictEqual(shares.length, 3);
    });

    test('can increment download count', () => {
        const token = generateToken();
        const expires = new Date(Date.now() + 86400000).toISOString();

        db.addShare(fileId, token, expires, 3);

        db.incrementShareDownload(token);
        db.incrementShareDownload(token);

        const share = db.getShare(token);
        assert.strictEqual(share.download_count, 2);
    });

    test('can revoke a share', () => {
        const token = generateToken();
        const expires = new Date(Date.now() + 86400000).toISOString();

        db.addShare(fileId, token, expires, 1);

        const revoked = db.revokeShare(token);
        assert.strictEqual(revoked, true);

        const share = db.getShare(token);
        assert.strictEqual(share, null);
    });

    test('revoke returns false for nonexistent token', () => {
        const revoked = db.revokeShare('nonexistent');
        assert.strictEqual(revoked, false);
    });

    test('can clean expired shares', () => {
        const expiredDate = new Date(Date.now() - 60000).toISOString(); // 1 min ago
        const futureDate = new Date(Date.now() + 86400000).toISOString();

        db.addShare(fileId, generateToken(), expiredDate, 1);
        db.addShare(fileId, generateToken(), expiredDate, 1);
        db.addShare(fileId, generateToken(), futureDate, 1);

        const cleaned = db.cleanExpiredShares();
        assert.strictEqual(cleaned, 2);

        const remaining = db.listShares();
        assert.strictEqual(remaining.length, 1);
    });

    test('shares are deleted when file is deleted', () => {
        const token = generateToken();
        const expires = new Date(Date.now() + 86400000).toISOString();

        db.addShare(fileId, token, expires, 1);
        db.delete(fileId);

        const share = db.getShare(token);
        assert.strictEqual(share, null);
    });
});
