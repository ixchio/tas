/**
 * Share feature tests
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import { FileIndex } from '../src/db/index.js';
import { ShareServer, generateToken, parseDuration } from '../src/share/server.js';

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

    test('preflights a shared file with missing chunk metadata', () => {
        const server = new ShareServer({ dataDir: '/tmp', password: 'test', config: {} });
        server.db = db;
        server.client = { usesCustomApi: () => false };
        const file = db.findByExactName('test-file.pdf');

        assert.match(server.getReadabilityError(file), /no chunk metadata/);
    });

    test('destroys a partial response instead of writing a second HTTP status', async () => {
        const token = generateToken();
        db.addChunk(fileId, 0, 'message-1', 900, 'telegram-file-1', 'primary');
        db.addShare(fileId, token, new Date(Date.now() + 86400000).toISOString(), 1);

        const server = new ShareServer({ dataDir: '/tmp', password: 'test', config: {} });
        server.db = db;
        server.client = { usesCustomApi: () => false };
        server.streamToResponse = async () => { throw new Error('stream failed after headers'); };

        const response = {
            headersSent: false,
            writeCount: 0,
            destroyedWith: null,
            writeHead() { this.headersSent = true; this.writeCount++; },
            end() { },
            destroy(error) { this.destroyedWith = error; }
        };
        const originalError = console.error;
        console.error = () => { };
        try {
            await server.handleRequest({
                url: `/d/${token}?download=1`,
                headers: { host: '127.0.0.1' }
            }, response);
        } finally {
            console.error = originalError;
        }

        assert.strictEqual(response.writeCount, 1);
        assert.match(response.destroyedWith.message, /stream failed/);
        assert.strictEqual(db.getShare(token).download_count, 0);
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

    test('atomically reserves and releases limited download slots', () => {
        const token = generateToken();
        db.addShare(fileId, token, new Date(Date.now() + 86400000).toISOString(), 1);

        assert.strictEqual(db.reserveShareDownload(token), true);
        assert.strictEqual(db.reserveShareDownload(token), false);
        assert.strictEqual(db.getShare(token).download_count, 1);
        assert.strictEqual(db.releaseShareDownload(token), true);
        assert.strictEqual(db.getShare(token).download_count, 0);
        assert.strictEqual(db.reserveShareDownload(token), true);
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
