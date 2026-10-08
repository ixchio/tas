/**
 * Single-process ownership for the long-running sync engine.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const LOCK_NAME = 'sync.lock';

function lockPath(dataDir) {
    return path.join(dataDir, LOCK_NAME);
}

export function isProcessRunning(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

export function readSyncLock(dataDir) {
    const file = lockPath(dataDir);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const pid = Number(parsed.pid);
        if (!Number.isSafeInteger(pid) || pid <= 0 || typeof parsed.nonce !== 'string') {
            return { file, valid: false, running: false, pid: null };
        }
        return {
            file,
            valid: true,
            running: isProcessRunning(pid),
            pid,
            startedAt: parsed.startedAt || null,
            nonce: parsed.nonce
        };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        return { file, valid: false, running: false, pid: null };
    }
}

export function acquireSyncLock(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = lockPath(dataDir);

    for (let attempt = 0; attempt < 2; attempt++) {
        const info = {
            pid: process.pid,
            startedAt: new Date().toISOString(),
            nonce: crypto.randomUUID()
        };
        let descriptor;
        try {
            descriptor = fs.openSync(file, 'wx', 0o600);
            fs.writeFileSync(descriptor, `${JSON.stringify(info)}\n`);
            fs.closeSync(descriptor);
            descriptor = null;

            let released = false;
            return {
                ...info,
                file,
                release() {
                    if (released) return;
                    released = true;
                    const current = readSyncLock(dataDir);
                    if (current?.valid && current.nonce === info.nonce) {
                        try { fs.unlinkSync(file); } catch { }
                    }
                }
            };
        } catch (error) {
            if (descriptor !== undefined) {
                try { fs.closeSync(descriptor); } catch { }
            }
            if (error.code !== 'EEXIST') throw error;

            const existing = readSyncLock(dataDir);
            if (existing?.running) {
                throw new Error(`Sync is already running (PID ${existing.pid})`);
            }

            if (existing && !existing.valid) {
                let ageMs = 0;
                try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { }
                if (ageMs < 5000) {
                    throw new Error('Another sync process is acquiring the startup lock; retry in a few seconds');
                }
            }

            // Invalid or dead-owner locks are safe to recover. Creation still
            // uses O_EXCL on the next attempt so concurrent starters race safely.
            try { fs.unlinkSync(file); } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') throw unlinkError;
            }
        }
    }

    throw new Error('Could not acquire the sync process lock');
}
