import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramFS } from '../src/fuse/mount.js';
import { listLogicalChildren, normalizeLogicalPath } from '../src/utils/logical-path.js';

function callbackResult(invoke) {
    return new Promise((resolve, reject) => {
        invoke((status, value) => status === 0 ? resolve(value) : reject(new Error(`FUSE status ${status}`)));
    });
}

describe('FUSE nested logical paths', () => {
    let tempDir;
    let filesystem;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-fuse-paths-'));
        filesystem = new TelegramFS({
            dataDir: tempDir,
            password: 'test-password',
            config: { bots: [{ id: 'primary', botToken: '1:test', chatId: 1, enabled: true }] },
            mountPoint: path.join(tempDir, 'mount'),
            backupManifest: async () => ({ version: 1 })
        });

        const add = (filename, hash) => filesystem.db.addFile({
            filename,
            hash,
            originalSize: 1,
            storedSize: 1,
            chunks: 1,
            compressed: false
        });
        add('a.txt', 'a'.repeat(64));
        add('subdir/file.txt', 'b'.repeat(64));
        add('subdir/nested/deep.txt', 'c'.repeat(64));
        add('other/file.txt', 'd'.repeat(64));
        filesystem._refreshPathIndex();
    });

    afterEach(() => {
        filesystem.db.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('lists only immediate root and nested children, never names containing slash', async () => {
        const root = await callbackResult(cb => filesystem.readdir('/', cb));
        const subdir = await callbackResult(cb => filesystem.readdir('/subdir', cb));

        assert.deepEqual(root, ['a.txt', 'other', 'subdir']);
        assert.deepEqual(subdir, ['file.txt', 'nested']);
        assert.ok(root.every(name => !name.includes('/')));
        assert.ok(subdir.every(name => !name.includes('/')));
    });

    it('returns directory attributes for implicit parent paths', async () => {
        const attributes = await callbackResult(cb => filesystem.getattr('/subdir/nested', cb));
        assert.equal(attributes.mode & 0o170000, 0o040000);
        assert.ok(attributes.ino > 0);
        assert.equal(attributes.blksize, 4096);
    });

    it('provides GUI-compatible filesystem and directory operations', async () => {
        const stats = await callbackResult(cb => filesystem.statfs('/', cb));
        assert.ok(stats.bsize > 0);
        assert.ok(stats.blocks > 0);
        assert.equal(stats.namemax, 255);

        await callbackResult(cb => filesystem.access('/subdir', 4, cb));
        const descriptor = await callbackResult(cb => filesystem.opendir('/subdir', 0, cb));
        assert.ok(descriptor > 0);
        await callbackResult(cb => filesystem.releasedir('/subdir', descriptor, cb));
    });

    it('supports session xattrs used by desktop and SMB clients', async () => {
        const value = Buffer.from('archive');
        await callbackResult(cb => filesystem.setxattr('/a.txt', 'user.DOSATTRIB', value, 0, 0, cb));

        const names = await callbackResult(cb => filesystem.listxattr('/a.txt', cb));
        const stored = await callbackResult(cb => filesystem.getxattr('/a.txt', 'user.DOSATTRIB', 0, cb));
        assert.deepEqual(names, ['user.DOSATTRIB']);
        assert.deepEqual(stored, value);

        await callbackResult(cb => filesystem.removexattr('/a.txt', 'user.DOSATTRIB', cb));
        await assert.rejects(
            callbackResult(cb => filesystem.getxattr('/a.txt', 'user.DOSATTRIB', 0, cb)),
            /FUSE status -61/
        );
    });

    it('keeps shared access explicit and enables kernel permission checks', () => {
        filesystem.allowOther = true;
        assert.deepEqual(filesystem._mountOptions(), {
            debug: false,
            force: true,
            mkdir: true,
            allowOther: true,
            defaultPermissions: true,
            fsname: 'tas',
            subtype: 'tas'
        });
    });

    it('opens the exact logical path instead of a basename or fuzzy match', async () => {
        const expected = filesystem.db.findByExactName('other/file.txt');
        const descriptor = await callbackResult(cb => filesystem.open('/other/file.txt', 0, cb));
        assert.equal(descriptor, expected.id);
    });

    it('renames the exact nested record', async () => {
        await callbackResult(cb => filesystem.rename('/subdir/file.txt', '/subdir/renamed.txt', cb));
        assert.equal(filesystem.db.findByExactName('subdir/file.txt'), undefined);
        assert.ok(filesystem.db.findByExactName('subdir/renamed.txt'));
        assert.ok(filesystem.db.findByExactName('other/file.txt'));
    });

    it('uses portable normalized logical paths for sync-style input', () => {
        assert.equal(normalizeLogicalPath('folder\\child\\file.txt'), 'folder/child/file.txt');
        assert.deepEqual(listLogicalChildren(['folder/a', 'folder/nested/b'], 'folder'), ['a', 'nested']);
    });

    it('keeps 60,000 flat entries valid when one nested sync path is present', () => {
        const paths = Array.from({ length: 60_000 }, (_, index) => `file-${String(index).padStart(5, '0')}.bin`);
        paths.push('subdir/file.txt');
        const root = listLogicalChildren(paths, '');
        assert.equal(root.length, 60_001);
        assert.ok(root.includes('subdir'));
        assert.ok(root.every(name => !name.includes('/')));
        assert.deepEqual(listLogicalChildren(paths, 'subdir'), ['file.txt']);
    });
});
