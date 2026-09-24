/**
 * FUSE Filesystem Mount
 * Mount Telegram storage as a local folder
 * 
 * This is the killer feature - use Telegram like a regular folder!
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { pipeline } from 'stream/promises';

let Fuse;
try {
    Fuse = (await import('fuse-native')).default;
} catch {
    // fuse-native is optional — unavailable on ARM64 or systems without libfuse
}
import { TelegramPool } from '../telegram/pool.js';
import { Encryptor } from '../crypto/encryption.js';
import { Compressor } from '../utils/compression.js';
import { FileIndex } from '../db/index.js';
import { createDownloadPipeline } from '../utils/download-stream.js';
import { processFile } from '../index.js';
import { hashFile } from '../crypto/encryption.js';
import { backupRemoteManifest } from '../manifest.js';
import {
    normalizeLogicalPath,
    listLogicalChildren,
    isImplicitDirectory,
    parentLogicalPath
} from '../utils/logical-path.js';

// File cache for performance (avoid re-downloading)
const fileCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 100; // Prevent unbounded memory growth

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Verify the native FUSE stack, not merely that the JS module imports. */
export async function checkFuseRuntime() {
    if (process.platform === 'darwin') {
        return {
            supported: false,
            reason: 'macOS mount is unsupported: fuse-native 2.x targets obsolete OSXFUSE APIs and current macFUSE/Apple Silicon is not validated'
        };
    }
    if (!Fuse) return { supported: false, reason: 'fuse-native is not installed or failed to load' };

    const configured = await new Promise((resolve, reject) => {
        Fuse.isConfigured((error, ready) => error ? reject(error) : resolve(ready));
    });
    if (!configured) return { supported: false, reason: 'FUSE kernel/userspace support is not configured' };

    const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-fuse-doctor-'));
    const now = new Date();
    const probe = new Fuse(mountPoint, {
        getattr(filepath, cb) {
            if (filepath === '/') return cb(0, { mode: 0o40755, size: 4096, mtime: now, atime: now, ctime: now });
            if (filepath === '/probe') return cb(0, { mode: 0o100444, size: 0, mtime: now, atime: now, ctime: now });
            return cb(Fuse.ENOENT);
        },
        readdir(filepath, cb) {
            return filepath === '/' ? cb(0, ['probe']) : cb(Fuse.ENOENT);
        },
        open(filepath, flags, cb) { return cb(0, 1); },
        read(filepath, fd, buffer, length, position, cb) { return cb(0); }
    }, { force: true, mkdir: true });

    let mounted = false;
    try {
        await withTimeout(new Promise((resolve, reject) => probe.mount(error => error ? reject(error) : resolve())), 10000, 'FUSE mount');
        mounted = true;
        const entries = await withTimeout(fs.promises.readdir(mountPoint), 10000, 'FUSE readdir');
        if (!entries.includes('probe')) throw new Error('FUSE readdir smoke test returned unexpected entries');
        await withTimeout(new Promise((resolve, reject) => probe.unmount(error => error ? reject(error) : resolve())), 10000, 'FUSE unmount');
        mounted = false;
        return { supported: true };
    } finally {
        if (mounted) {
            try { await new Promise(resolve => probe.unmount(() => resolve())); } catch { }
        }
        try { fs.rmdirSync(mountPoint); } catch { }
    }
}

export class TelegramFS {
    constructor(options) {
        if (process.platform === 'darwin') {
            throw new Error(
                'TAS mount is currently unsupported on macOS. fuse-native 2.x targets obsolete OSXFUSE APIs ' +
                'and is not compatible with current macFUSE on Apple Silicon. Use push/pull/sync/share instead.'
            );
        }
        if (!Fuse) {
            throw new Error(
                'fuse-native is not available on this system.\n' +
                '  On Linux x86_64: npm install fuse-native && sudo apt install fuse libfuse-dev\n' +
                '  All other TAS commands (push, pull, sync, share) work without FUSE.'
            );
        }

        this.dataDir = options.dataDir;
        this.password = options.password;
        this.config = options.config;
        this.mountPoint = options.mountPoint;
        this.backupManifest = options.backupManifest || backupRemoteManifest;

        this.db = new FileIndex(path.join(this.dataDir, 'index.db'));
        this.db.init();

        this.encryptor = new Encryptor(this.password);
        this.compressor = new Compressor();
        this.client = null;
        this.fuse = null;

        // Pending writes are disk-backed so a large FUSE write does not grow
        // the Node process by the full file size.
        this.writeBuffers = new Map();
        this.virtualDirs = new Set(['']);
        this.filePaths = new Set();
        this.fileByLogicalPath = new Map();
        this.implicitDirs = new Set(['']);
        this.childrenByDir = new Map();
        this._refreshPathIndex();
    }

    async initialize() {
        // Connect to Telegram
        this.client = new TelegramPool(this.dataDir, this.config.bots);
    }

    _logical(filepath, allowRoot = false) {
        return normalizeLogicalPath(filepath, { allowRoot });
    }

    _allLogicalPaths() {
        return [
            ...this.filePaths,
            ...this.writeBuffers.keys()
        ];
    }

    _isDirectory(logicalPath) {
        return this.virtualDirs.has(logicalPath) || this.implicitDirs.has(logicalPath) ||
            isImplicitDirectory([...this.writeBuffers.keys()], logicalPath);
    }

    _refreshPathIndex() {
        this.filePaths = new Set();
        this.fileByLogicalPath = new Map();
        this.implicitDirs = new Set(['']);
        this.childrenByDir = new Map();
        const addChild = (dir, child) => {
            if (!this.childrenByDir.has(dir)) this.childrenByDir.set(dir, new Set());
            this.childrenByDir.get(dir).add(child);
        };

        for (const file of this.db.listAll()) {
            const logical = normalizeLogicalPath(file.filename);
            this.filePaths.add(logical);
            if (!this.fileByLogicalPath.has(logical)) this.fileByLogicalPath.set(logical, file);
            const parts = logical.split('/');
            let dir = '';
            for (let index = 0; index < parts.length; index++) {
                addChild(dir, parts[index]);
                if (index < parts.length - 1) {
                    dir = dir ? `${dir}/${parts[index]}` : parts[index];
                    this.implicitDirs.add(dir);
                }
            }
        }
    }

    _file(logicalPath) {
        return this.fileByLogicalPath.get(logicalPath);
    }

    _newWritePath(logicalPath) {
        const dir = path.join(this.dataDir, 'fuse-writes');
        fs.mkdirSync(dir, { recursive: true });
        const safe = Buffer.from(logicalPath).toString('hex').slice(0, 48) || 'root';
        return path.join(dir, `${safe}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    }

    async _ensureWriteFile(logicalPath, { empty = false } = {}) {
        if (this.writeBuffers.has(logicalPath)) return this.writeBuffers.get(logicalPath);
        const tempPath = this._newWritePath(logicalPath);
        if (empty) {
            fs.closeSync(fs.openSync(tempPath, 'w', 0o600));
        } else {
            const existing = this._file(logicalPath);
            if (existing) {
                const cachedPath = await this.downloadFileToCache(logicalPath);
                fs.copyFileSync(cachedPath, tempPath);
            } else {
                fs.closeSync(fs.openSync(tempPath, 'w', 0o600));
            }
        }
        const entry = { path: tempPath, modified: true, isNew: !this._file(logicalPath) };
        this.writeBuffers.set(logicalPath, entry);
        return entry;
    }

    /**
     * Get file attributes
     */
    getattr(filepath, cb) {
        let logical;
        try { logical = this._logical(filepath, true); } catch { return cb(Fuse.ENOENT); }

        if (this._isDirectory(logical)) {
            return cb(0, {
                mtime: new Date(),
                atime: new Date(),
                ctime: new Date(),
                size: 4096,
                mode: 0o40755, // directory
                uid: process.getuid?.() || 0,
                gid: process.getgid?.() || 0
            });
        }

        // Check write buffers first (new/pending files)
        const wb = this.writeBuffers.get(logical);
        if (wb) {
            const stats = fs.statSync(wb.path);
            return cb(0, {
                mtime: new Date(),
                atime: new Date(),
                ctime: new Date(),
                size: stats.size,
                mode: 0o100644, // regular file
                uid: process.getuid?.() || 0,
                gid: process.getgid?.() || 0
            });
        }

        // Look up file in index
        const file = this._file(logical);

        if (!file) {
            return cb(Fuse.ENOENT);
        }

        return cb(0, {
            mtime: new Date(file.created_at),
            atime: new Date(file.created_at),
            ctime: new Date(file.created_at),
            size: file.original_size,
            mode: 0o100644, // regular file
            uid: process.getuid?.() || 0,
            gid: process.getgid?.() || 0
        });
    }

    /**
     * List directory contents
     */
    readdir(filepath, cb) {
        let logical;
        try { logical = this._logical(filepath, true); } catch { return cb(Fuse.ENOENT); }
        if (!this._isDirectory(logical)) return cb(Fuse.ENOENT);

        const names = new Set(this.childrenByDir.get(logical) || []);
        for (const name of listLogicalChildren([...this.writeBuffers.keys(), ...this.virtualDirs].filter(Boolean), logical)) {
            names.add(name);
        }
        return cb(0, [...names].sort((a, b) => a.localeCompare(b)));
    }

    /**
     * Open a file (just validates it exists)
     */
    open(filepath, flags, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.ENOENT); }
        if (this._isDirectory(logical)) return cb(Fuse.EISDIR || Fuse.EINVAL);

        // Check if it's a new file being written
        if (this.writeBuffers.has(logical)) {
            return cb(0, 42); // Return a dummy fd
        }

        const file = this._file(logical);

        if (!file) {
            return cb(Fuse.ENOENT);
        }

        return cb(0, file.id); // Use file ID as file descriptor
    }

    /**
     * Read file contents from disk cache
     */
    async read(filepath, fd, buffer, length, position, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.ENOENT); }

        try {
            // Check write buffers first
            const wb = this.writeBuffers.get(logical);
            if (wb) {
                const writeFd = fs.openSync(wb.path, 'r');
                const bytesRead = fs.readSync(writeFd, buffer, 0, length, position);
                fs.closeSync(writeFd);
                return cb(bytesRead);
            }

            // Check cache first
            let cachedPath = this.getCached(logical);

            if (!cachedPath) {
                // Download, decrypt, and save to disk cache
                cachedPath = await this.downloadFileToCache(logical);
                this.setCache(logical, cachedPath);
            }

            // Copy requested portion to buffer from disk
            const fdDisk = fs.openSync(cachedPath, 'r');
            const bytesRead = fs.readSync(fdDisk, buffer, 0, length, position);
            fs.closeSync(fdDisk);

            return cb(bytesRead);
        } catch (err) {
            console.error('Read error:', err.message);
            return cb(Fuse.EIO);
        }
    }

    /**
     * Write to a file (buffers until release)
     */
    async write(filepath, fd, buffer, length, position, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.ENOENT); }
        try {
            const wb = await this._ensureWriteFile(logical);
            const writeFd = fs.openSync(wb.path, 'r+');
            fs.writeSync(writeFd, buffer, 0, length, position);
            fs.closeSync(writeFd);
            wb.modified = true;
            return cb(length);
        } catch (error) {
            console.error('Write error:', error.message);
            return cb(Fuse.EIO);
        }
    }

    /**
     * Create a new file
     */
    create(filepath, mode, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.EINVAL); }
        console.log(`[FUSE] Creating file: ${logical}`);
        this._ensureWriteFile(logical, { empty: true })
            .then(() => cb(0, 42))
            .catch(() => cb(Fuse.EIO));
    }

    /**
     * Truncate open file
     */
    ftruncate(filepath, fd, size, cb) {
        return this.truncate(filepath, size, cb);
    }

    /**
     * Flush/sync file to Telegram
     */
    async release(filepath, fd, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.ENOENT); }

        const wb = this.writeBuffers.get(logical);
        if (!wb || !wb.modified) {
            return cb(0);
        }

        try {
            // Upload to Telegram
            await this.uploadFile(logical, wb.path);

            // Clear write buffer
            this.writeBuffers.delete(logical);
            try { fs.unlinkSync(wb.path); } catch { }

            // Invalidate cache
            this.invalidateCache(logical);

            return cb(0);
        } catch (err) {
            console.error('Release error:', err.message);
            return cb(Fuse.EIO);
        }
    }

    /**
     * Delete a file
     */
    async unlink(filepath, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.ENOENT); }
        const file = this._file(logical);

        if (!file) {
            return cb(Fuse.ENOENT);
        }

        try {
            const chunks = this.db.getChunks(file.id);
            const before = this.db.exportManifest({ includeShares: true });
            this.db.delete(file.id);
            this._refreshPathIndex();

            try {
                await this.backupManifest({
                    dataDir: this.dataDir,
                    password: this.password,
                    config: this.config,
                    telegramPool: this.client
                });
            } catch (error) {
                this.db.importManifest(before);
                this._refreshPathIndex();
                throw error;
            }

            // Delete remote messages only after the new recovery point is durable.
            for (const chunk of chunks) {
                await this.client.deleteMessage(chunk.message_id, chunk.bot_id || null);
            }

            // Invalidate cache
            this.invalidateCache(logical);

            return cb(0);
        } catch (err) {
            console.error('Unlink error:', err.message);
            return cb(Fuse.EIO);
        }
    }

    /**
     * Rename/move a file (just update index, data stays in Telegram)
     */
    async rename(src, dest, cb) {
        let oldName;
        let newName;
        try {
            oldName = this._logical(src);
            newName = this._logical(dest);
        } catch {
            return cb(Fuse.EINVAL);
        }

        if (oldName === newName) return cb(0);

        const pendingWrite = this.writeBuffers.get(oldName);
        if (pendingWrite) {
            this.writeBuffers.delete(oldName);
            this.writeBuffers.set(newName, pendingWrite);
            return cb(0);
        }

        const file = this._file(oldName);
        if (!file) {
            return cb(Fuse.ENOENT);
        }

        // Avoid duplicate filenames: remove the destination first
        try {
            const destFile = this._file(newName);
            if (destFile && destFile.id !== file.id) {
                const destChunks = this.db.getChunks(destFile.id);
                for (const chunk of destChunks) {
                    try { await this.client.deleteMessage(chunk.message_id, chunk.bot_id || null); } catch (e) { }
                }
                this.db.deleteFileCascade(destFile.id);
                this.invalidateCache(newName);
            }
        } catch (e) { /* best effort */ }

        // Update filename in database
        this.db.db.prepare('UPDATE files SET filename = ? WHERE id = ?')
            .run(newName, file.id);
        this._refreshPathIndex();

        try {
            await this.backupManifest({
                dataDir: this.dataDir,
                password: this.password,
                config: this.config,
                telegramPool: this.client
            });
        } catch (error) {
            console.error('Remote manifest update failed after rename:', error.message);
            this.db.db.prepare('UPDATE files SET filename = ? WHERE id = ?').run(oldName, file.id);
            this._refreshPathIndex();
            return cb(Fuse.EIO);
        }

        // Update cache key
        const cached = fileCache.get(oldName);
        if (cached) {
            fileCache.delete(oldName);
            fileCache.set(newName, cached);
        }

        return cb(0);
    }

    mkdir(filepath, mode, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.EINVAL); }
        if (this._file(logical) || this._isDirectory(logical)) return cb(Fuse.EEXIST || Fuse.EINVAL);
        const parent = parentLogicalPath(logical);
        if (!this._isDirectory(parent)) return cb(Fuse.ENOENT);
        this.virtualDirs.add(logical);
        return cb(0);
    }

    rmdir(filepath, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.EINVAL); }
        if (!this._isDirectory(logical)) return cb(Fuse.ENOENT);
        if (listLogicalChildren([...this._allLogicalPaths(), ...this.virtualDirs].filter(Boolean), logical).length > 0) {
            return cb(Fuse.ENOTEMPTY || Fuse.EINVAL);
        }
        this.virtualDirs.delete(logical);
        return cb(0);
    }

    /**
     * Truncate a file
     */
    async truncate(filepath, size, cb) {
        let logical;
        try { logical = this._logical(filepath); } catch { return cb(Fuse.ENOENT); }
        try {
            // Always hydrate a remote file before truncating it. Falling back
            // to an empty buffer silently destroyed uncached content.
            const wb = await this._ensureWriteFile(logical);
            fs.truncateSync(wb.path, size);
            wb.modified = true;
            return cb(0);
        } catch (error) {
            console.error('Truncate error:', error.message);
            return cb(Fuse.EIO);
        }
    }

    // ============== Helper Methods ==============

    async downloadFileToCache(filename) {
        const file = this._file(filename);
        if (!file) throw new Error('File not found');

        const cacheDir = path.join(this.dataDir, 'cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const outputPath = path.join(cacheDir, file.hash);

        // If it's already fully downloaded and cached on disk, return path
        if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            if (stats.size === file.original_size) {
                return outputPath;
            }
        }

        const chunks = this.db.getChunks(file.id);

        const { readable } = await createDownloadPipeline({
            client: this.client,
            chunks,
            encryptor: this.encryptor,
            compressor: this.compressor
        });

        const tmpOutputPath = outputPath + '.tmp';
        const writeStream = fs.createWriteStream(tmpOutputPath);

        await pipeline(readable, writeStream);

        // Rename to final atomic path
        fs.renameSync(tmpOutputPath, outputPath);

        return outputPath;
    }

    async uploadFile(filename, sourcePath) {
        const existing = this._file(filename);
        const hash = await hashFile(sourcePath);
        if (existing?.hash === hash) {
            await this.backupManifest({
                dataDir: this.dataDir,
                password: this.password,
                config: this.config,
                telegramPool: this.client
            });
            return;
        }

        const result = await processFile(sourcePath, {
            password: this.password,
            dataDir: this.dataDir,
            customName: filename,
            config: this.config,
            telegramPool: this.client,
            replaceExisting: true
        });
        this._refreshPathIndex();
        if (result.manifestWarning) throw new Error(`Remote recovery manifest failed: ${result.manifestWarning}`);
    }

    getCached(filename) {
        const entry = fileCache.get(filename);
        if (!entry) return null;

        if (Date.now() - entry.timestamp > CACHE_TTL) {
            // Expired, delete the file if possible
            try {
                if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path);
            } catch (e) { }
            fileCache.delete(filename);
            return null;
        }

        // Extend cache TTL on read
        entry.timestamp = Date.now();
        return entry.path;
    }

    setCache(filename, cachePath) {
        // Evict oldest entry if cache is full
        if (fileCache.size >= CACHE_MAX_ENTRIES) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [key, entry] of fileCache) {
                if (entry.timestamp < oldestTime) {
                    oldestTime = entry.timestamp;
                    oldestKey = key;
                }
            }
            if (oldestKey) {
                const evicted = fileCache.get(oldestKey);
                try { if (fs.existsSync(evicted.path)) fs.unlinkSync(evicted.path); } catch (e) { }
                fileCache.delete(oldestKey);
            }
        }

        fileCache.set(filename, {
            path: cachePath,
            timestamp: Date.now()
        });
    }

    invalidateCache(filename) {
        const entry = fileCache.get(filename);
        if (entry) {
            try {
                if (fs.existsSync(entry.path)) fs.unlinkSync(entry.path);
            } catch (e) { }
            fileCache.delete(filename);
        }
    }

    /**
     * Mount the filesystem
     */
    mount() {
        // Ensure mount point exists
        if (!fs.existsSync(this.mountPoint)) {
            fs.mkdirSync(this.mountPoint, { recursive: true });
        }

        const ops = {
            getattr: this.getattr.bind(this),
            readdir: this.readdir.bind(this),
            open: this.open.bind(this),
            read: this.read.bind(this),
            write: this.write.bind(this),
            create: this.create.bind(this),
            release: this.release.bind(this),
            unlink: this.unlink.bind(this),
            rename: this.rename.bind(this),
            mkdir: this.mkdir.bind(this),
            rmdir: this.rmdir.bind(this),
            truncate: this.truncate.bind(this),
            ftruncate: this.ftruncate.bind(this)
        };

        this.fuse = new Fuse(this.mountPoint, ops, {
            debug: false,
            force: true,
            mkdir: true
        });

        return new Promise((resolve, reject) => {
            this.fuse.mount((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Unmount the filesystem
     */
    unmount() {
        return new Promise((resolve, reject) => {
            if (!this.fuse) return resolve();

            this.fuse.unmount((err) => {
                if (err) {
                    reject(err);
                } else {
                    this.db.close();
                    resolve();
                }
            });
        });
    }
}
