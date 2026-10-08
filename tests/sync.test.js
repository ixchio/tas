/**
 * Sync tests
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileIndex } from '../src/db/index.js';
import { SyncEngine } from '../src/sync/sync.js';

const TEST_DB_PATH = '/tmp/tas-test-sync.db';

function cleanupDB(dbPath) {
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    files.forEach(f => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    });
}

describe('Sync Folders', () => {
    let db;

    beforeEach(() => {
        // Clean up any existing test database
        cleanupDB(TEST_DB_PATH);

        db = new FileIndex(TEST_DB_PATH);
        db.init();
    });

    afterEach(() => {
        if (db) {
            db.close();
        }
        cleanupDB(TEST_DB_PATH);
    });

    test('can add sync folder', () => {
        const folderId = db.addSyncFolder('/home/user/documents');

        assert.ok(folderId);

        const folder = db.getSyncFolderByPath('/home/user/documents');
        assert.ok(folder);
        assert.strictEqual(folder.local_path, '/home/user/documents');
        assert.strictEqual(folder.enabled, 1);
    });

    test('can list sync folders', () => {
        db.addSyncFolder('/home/user/documents');
        db.addSyncFolder('/home/user/photos');

        const folders = db.getSyncFolders();
        assert.strictEqual(folders.length, 2);
    });

    test('can remove sync folder', () => {
        db.addSyncFolder('/home/user/documents');

        db.removeSyncFolder('/home/user/documents');

        const folder = db.getSyncFolderByPath('/home/user/documents');
        assert.strictEqual(folder, undefined);
    });

    test('duplicate folder path is ignored', () => {
        db.addSyncFolder('/home/user/documents');
        db.addSyncFolder('/home/user/documents');

        const folders = db.getSyncFolders();
        assert.strictEqual(folders.length, 1);
    });
});

describe('Sync State', () => {
    let db;
    let folderId;

    beforeEach(() => {
        cleanupDB(TEST_DB_PATH);

        db = new FileIndex(TEST_DB_PATH);
        db.init();
        folderId = db.addSyncFolder('/home/user/documents');
    });

    afterEach(() => {
        if (db) {
            db.close();
        }
        cleanupDB(TEST_DB_PATH);
    });

    test('can track file sync state', () => {
        db.updateSyncState(folderId, 'file.txt', 'abc123', 1234567890);

        const state = db.getSyncState(folderId, 'file.txt');
        assert.ok(state);
        assert.strictEqual(state.file_hash, 'abc123');
        assert.strictEqual(state.mtime, 1234567890);
    });

    test('can update file sync state', () => {
        db.updateSyncState(folderId, 'file.txt', 'abc123', 1234567890);
        db.updateSyncState(folderId, 'file.txt', 'def456', 1234567999);

        const state = db.getSyncState(folderId, 'file.txt');
        assert.strictEqual(state.file_hash, 'def456');
        assert.strictEqual(state.mtime, 1234567999);
    });

    test('can get all states for a folder', () => {
        db.updateSyncState(folderId, 'file1.txt', 'abc123', 1234567890);
        db.updateSyncState(folderId, 'file2.txt', 'def456', 1234567890);
        db.updateSyncState(folderId, 'subdir/file3.txt', 'ghi789', 1234567890);

        const states = db.getFolderSyncStates(folderId);
        assert.strictEqual(states.length, 3);
    });

    test('can remove sync state', () => {
        db.updateSyncState(folderId, 'file.txt', 'abc123', 1234567890);

        db.removeSyncState(folderId, 'file.txt');

        const state = db.getSyncState(folderId, 'file.txt');
        assert.strictEqual(state, undefined);
    });

    test('sync state is deleted when folder is removed', () => {
        db.updateSyncState(folderId, 'file.txt', 'abc123', 1234567890);

        db.removeSyncFolder('/home/user/documents');

        // Re-add folder to check states are gone
        const newFolderId = db.addSyncFolder('/home/user/documents');
        const states = db.getFolderSyncStates(newFolderId);
        assert.strictEqual(states.length, 0);
    });
});

describe('Sync startup lifecycle', () => {
    test('reports discovery progress for large folders', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-sync-scan-'));
        try {
            for (let index = 0; index < 300; index++) {
                fs.writeFileSync(path.join(root, `file-${index}.txt`), 'x');
            }

            const engine = new SyncEngine({ dataDir: root, password: 'test', config: { bots: [] } });
            const progress = [];
            engine.on('scan-progress', event => progress.push(event));

            const files = await engine.scanDirectory(root);

            assert.strictEqual(files.length, 300);
            assert.ok(progress.some(event => event.phase === 'discover' && event.files >= 250));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('stop interrupts an active initial scan and closes the database when idle', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-sync-stop-'));
        const dataDir = path.join(root, 'data');
        const watched = path.join(root, 'watched');
        fs.mkdirSync(dataDir);
        fs.mkdirSync(watched);
        try {
            for (let index = 0; index < 1000; index++) {
                fs.writeFileSync(path.join(watched, `file-${index}.txt`), 'x');
            }

            const db = new FileIndex(path.join(dataDir, 'index.db'));
            db.init();
            db.addSyncFolder(watched);

            const engine = new SyncEngine({
                dataDir,
                password: 'test',
                config: { bots: [] },
                autoResume: false
            });
            engine.db = db;
            engine.telegramPool = {};

            const start = engine.start();
            setTimeout(() => engine.stop(), 0);
            await start;

            assert.strictEqual(engine.running, false);
            assert.strictEqual(engine.starting, false);
            assert.strictEqual(engine.db, null);
            assert.strictEqual(engine.watchers.size, 0);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    test('fails startup when any directory could not be watched', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-sync-watch-'));
        try {
            const engine = new SyncEngine({ dataDir: root, password: 'test', config: { bots: [] } });
            engine.abortController = new AbortController();
            engine._watchSingleDir = () => false;

            await assert.rejects(
                engine.watchFolder(root, [root, path.join(root, 'nested')]),
                /Could not watch 2\/2 directories/
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
