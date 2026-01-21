/**
 * Tags tests
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { FileIndex } from '../src/db/index.js';

const TEST_DB_PATH = '/tmp/tas-test-tags.db';

describe('Tags', () => {
    let db;

    beforeEach(() => {
        // Clean up any existing test database
        if (fs.existsSync(TEST_DB_PATH)) {
            fs.unlinkSync(TEST_DB_PATH);
        }
        // Also clean up WAL files
        if (fs.existsSync(TEST_DB_PATH + '-wal')) {
            fs.unlinkSync(TEST_DB_PATH + '-wal');
        }
        if (fs.existsSync(TEST_DB_PATH + '-shm')) {
            fs.unlinkSync(TEST_DB_PATH + '-shm');
        }

        db = new FileIndex(TEST_DB_PATH);
        db.init();

        // Add a test file
        db.addFile({
            filename: 'test.txt',
            hash: 'abc123',
            originalSize: 100,
            storedSize: 80,
            chunks: 1,
            compressed: true
        });
    });

    afterEach(() => {
        if (db) {
            db.close();
        }
        // Clean up test database
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

    test('can add tags to a file', () => {
        const file = db.findByName('test.txt');

        db.addTag(file.id, 'work');
        db.addTag(file.id, 'important');

        const tags = db.getFileTags(file.id);
        assert.deepStrictEqual(tags, ['important', 'work']);
    });

    test('tags are case-insensitive and trimmed', () => {
        const file = db.findByName('test.txt');

        db.addTag(file.id, ' Work ');
        db.addTag(file.id, 'WORK');

        const tags = db.getFileTags(file.id);
        assert.strictEqual(tags.length, 1);
        assert.strictEqual(tags[0], 'work');
    });

    test('can remove tags from a file', () => {
        const file = db.findByName('test.txt');

        db.addTag(file.id, 'work');
        db.addTag(file.id, 'important');
        db.removeTag(file.id, 'work');

        const tags = db.getFileTags(file.id);
        assert.deepStrictEqual(tags, ['important']);
    });

    test('can find files by tag', () => {
        const file = db.findByName('test.txt');

        // Add another file
        db.addFile({
            filename: 'other.txt',
            hash: 'def456',
            originalSize: 200,
            storedSize: 150,
            chunks: 1,
            compressed: false
        });

        const otherFile = db.findByName('other.txt');

        db.addTag(file.id, 'work');
        db.addTag(otherFile.id, 'work');
        db.addTag(file.id, 'secret');

        const workFiles = db.findByTag('work');
        assert.strictEqual(workFiles.length, 2);

        const secretFiles = db.findByTag('secret');
        assert.strictEqual(secretFiles.length, 1);
        assert.strictEqual(secretFiles[0].filename, 'test.txt');
    });

    test('can get all tags', () => {
        const file = db.findByName('test.txt');

        db.addTag(file.id, 'work');
        db.addTag(file.id, 'important');

        const allTags = db.getAllTags();
        assert.strictEqual(allTags.length, 2);
        assert.strictEqual(allTags[0].tag, 'important');
        assert.strictEqual(allTags[0].count, 1);
    });

    test('tags are deleted when file is deleted', () => {
        const file = db.findByName('test.txt');

        db.addTag(file.id, 'work');
        db.addTag(file.id, 'important');

        db.delete(file.id);

        const allTags = db.getAllTags();
        assert.strictEqual(allTags.length, 0);
    });
});
