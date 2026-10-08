import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireSyncLock, readSyncLock } from '../src/sync/process-lock.js';

describe('Sync process lock', () => {
    it('allows one owner and reports its PID', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-sync-lock-'));
        try {
            const lock = acquireSyncLock(dataDir);
            const status = readSyncLock(dataDir);
            assert.equal(status.running, true);
            assert.equal(status.pid, process.pid);
            assert.equal(fs.statSync(status.file).mode & 0o777, 0o600);
            assert.throws(() => acquireSyncLock(dataDir), /already running/);

            lock.release();
            assert.equal(readSyncLock(dataDir), null);
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it('recovers an invalid stale lock', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-sync-lock-'));
        try {
            fs.writeFileSync(path.join(dataDir, 'sync.lock'), 'not json', { mode: 0o600 });
            const old = new Date(Date.now() - 10_000);
            fs.utimesSync(path.join(dataDir, 'sync.lock'), old, old);
            const lock = acquireSyncLock(dataDir);
            assert.equal(readSyncLock(dataDir).pid, process.pid);
            lock.release();
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
