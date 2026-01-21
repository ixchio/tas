/**
 * Sync tests
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { FileIndex } from '../src/db/index.js';

const TEST_DB_PATH = '/tmp/tas-test-sync.db';

describe('Sync Folders', () => {
    let db;

    beforeEach(() => {
        // Clean up any existing test database
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
        if (fs.existsSync(TEST_DB_PATH + '-wal')) {
            fs.unlinkSync(TEST_DB_PATH + '-wal');
        }
        if (fs.existsSync(TEST_DB_PATH + '-shm')) {
            fs.unlinkSync(TEST_DB_PATH + '-shm');
        }

        db = new FileIndex(TEST_DB_PATH);
        db.init();
    });

    afterEach(() => {
        if (db) {
            db.close();
        }
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
        if (fs.existsSync(TEST_DB_PATH + '-wal')) {
            fs.unlinkSync(TEST_DB_PATH + '-wal');
        }
        if (fs.existsSync(TEST_DB_PATH + '-shm')) {
            fs.unlinkSync(TEST_DB_PATH + '-shm');
        }
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
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
        if (fs.existsSync(TEST_DB_PATH + '-wal')) {
            fs.unlinkSync(TEST_DB_PATH + '-wal');
        }
        if (fs.existsSync(TEST_DB_PATH + '-shm')) {
            fs.unlinkSync(TEST_DB_PATH + '-shm');
        }

        db = new FileIndex(TEST_DB_PATH);
        db.init();
        folderId = db.addSyncFolder('/home/user/documents');
    });

    afterEach(() => {
        if (db) {
            db.close();
        }
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
        if (fs.existsSync(TEST_DB_PATH + '-wal')) {
            fs.unlinkSync(TEST_DB_PATH + '-wal');
        }
        if (fs.existsSync(TEST_DB_PATH + '-shm')) {
            fs.unlinkSync(TEST_DB_PATH + '-shm');
        }
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
