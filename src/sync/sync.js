/**
 * SyncEngine - Watches folders and syncs to Telegram
 * Dropbox-like auto-sync functionality
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { FileIndex } from '../db/index.js';
import { hashFile } from '../crypto/encryption.js';
import { processFile } from '../index.js';
import { TelegramPool } from '../telegram/pool.js';
import { backupRemoteManifest } from '../manifest.js';

// Debounce time in ms to batch rapid file changes
const DEBOUNCE_MS = 1000;

// Ignore patterns.
// NOTE: dotfiles are intentionally NOT ignored — TAS is advertised as a
// vault for `.env` files, SSH keys, etc. Only well-known junk is skipped.
const IGNORE_PATTERNS = [
    /^\.DS_Store$/, // macOS metadata
    /^\.git$/, // git dir name
    /\.git[\/\\]/, // anything inside .git
    /~$/, // Backup files
    /\.swp$/, // Vim swap files
    /\.tmp$/, // Temp files
    /(^|[\/\\])node_modules([\/\\]|$)/,
    /(^|[\/\\])\.tas([\/\\]|$)/ // our own data dir if nested
];

export class SyncEngine extends EventEmitter {
    constructor(options) {
        super();
        this.dataDir = options.dataDir;
        this.password = options.password;
        this.config = options.config;
        this.limitRate = options.limitRate || null;
        this.watchers = new Map(); // path -> FSWatcher
        this.pendingChanges = new Map(); // path -> timeout
        this.db = null;
        this.telegramPool = null;
        this.running = false;
    }

    /**
     * Initialize the sync engine
     */
    async initialize() {
        this.db = new FileIndex(path.join(this.dataDir, 'index.db'));
        this.db.init();
        this.telegramPool = new TelegramPool(this.dataDir, this.config.bots);
        await this.telegramPool.initialize({ includeDisabled: false });
    }

    /**
     * Check if a file should be ignored
     */
    shouldIgnore(filename) {
        return IGNORE_PATTERNS.some(pattern => pattern.test(filename));
    }

    /**
     * Get all files in a directory recursively
     */
    async scanDirectory(dirPath, relativeTo = dirPath) {
        const files = [];
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (this.shouldIgnore(entry.name)) continue;

            const fullPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(relativeTo, fullPath);

            if (entry.isDirectory()) {
                const subFiles = await this.scanDirectory(fullPath, relativeTo);
                files.push(...subFiles);
            } else if (entry.isFile()) {
                const stats = fs.statSync(fullPath);
                files.push({
                    path: fullPath,
                    relativePath,
                    mtime: stats.mtimeMs,
                    size: stats.size
                });
            }
        }

        return files;
    }

    /**
     * Sync a single folder - initial scan
     */
    async syncFolder(folderPath) {
        const folder = this.db.getSyncFolderByPath(folderPath);
        if (!folder) {
            throw new Error(`Folder not registered: ${folderPath}`);
        }

        this.emit('sync-start', { folder: folderPath });

        const files = await this.scanDirectory(folderPath);
        const existingStates = this.db.getFolderSyncStates(folder.id);
        const stateMap = new Map(existingStates.map(s => [s.relative_path, s]));

        let uploaded = 0;
        let skipped = 0;
        const supersededChunks = [];

        // Process files with concurrency limit
        const CONCURRENCY = 4;
        const queue = [...files];
        const promises = [];

        const worker = async () => {
            while (queue.length > 0) {
                const file = queue.shift();
                const existing = stateMap.get(file.relativePath);

                // Check if file has changed (by mtime)
                if (existing && existing.mtime >= file.mtime) {
                    skipped++;
                    continue;
                }

                // Calculate hash to detect actual changes
                const hash = await hashFile(file.path);

                if (existing && existing.file_hash === hash) {
                    // File unchanged, just update mtime
                    this.db.updateSyncState(folder.id, file.relativePath, hash, file.mtime);
                    skipped++;
                    continue;
                }

                // File is new or changed - upload it
                try {
                    this.emit('file-upload-start', { file: file.relativePath });

                    const result = await processFile(file.path, {
                        password: this.password,
                        dataDir: this.dataDir,
                        customName: file.relativePath, // Use relative path as name
                        config: this.config,
                        telegramPool: this.telegramPool,
                        updateManifest: false,
                        replaceExisting: true,
                        limitRate: this.limitRate ? Math.floor(this.limitRate / CONCURRENCY) : null,
                        onProgress: (msg) => this.emit('progress', { file: file.relativePath, message: msg })
                    });
                    supersededChunks.push(...(result.supersededChunks || []));

                    // Update sync state
                    this.db.updateSyncState(folder.id, file.relativePath, hash, file.mtime);
                    uploaded++;

                    this.emit('file-upload-complete', { file: file.relativePath });
                } catch (err) {
                    // Sleep briefly on a network/provider error before this
                    // worker advances; the staged upload remains resumable.
                    await new Promise(r => setTimeout(r, 2000));
                    this.emit('file-upload-error', { file: file.relativePath, error: err.message });
                }
            }
        };

        for (let i = 0; i < CONCURRENCY; i++) {
            promises.push(worker());
        }

        await Promise.all(promises);

        if (uploaded > 0) {
            try {
                await backupRemoteManifest({
                    dataDir: this.dataDir,
                    password: this.password,
                    config: this.config,
                    telegramPool: this.telegramPool
                });
                for (const chunk of supersededChunks) {
                    try { await this.telegramPool.deleteMessage(chunk.message_id, chunk.bot_id || null); } catch { }
                }
            } catch (error) {
                this.emit('manifest-error', { error: error.message });
            }
        }

        this.emit('sync-complete', { folder: folderPath, uploaded, skipped });

        return { uploaded, skipped };
    }

    /**
     * Handle a file change event (debounced)
     */
    handleFileChange(folderPath, filename) {
        if (this.shouldIgnore(filename)) return;

        const fullPath = path.join(folderPath, filename);
        const key = fullPath;

        // Clear existing timeout
        if (this.pendingChanges.has(key)) {
            clearTimeout(this.pendingChanges.get(key));
        }

        // Set new debounced handler
        const timeout = setTimeout(async () => {
            this.pendingChanges.delete(key);
            await this.processFileChange(folderPath, filename);
        }, DEBOUNCE_MS);

        this.pendingChanges.set(key, timeout);
    }

    /**
     * Process a file change after debounce
     */
    async processFileChange(folderPath, filename) {
        const fullPath = path.join(folderPath, filename);

        // Check if file still exists
        if (!fs.existsSync(fullPath)) {
            this.emit('file-deleted', { file: filename });
            return;
        }

        const stats = fs.statSync(fullPath);
        if (!stats.isFile()) return;

        const folder = this.db.getSyncFolderByPath(folderPath);
        if (!folder) return;

        try {
            const hash = await hashFile(fullPath);
            const existing = this.db.getSyncState(folder.id, filename);

            if (existing && existing.file_hash === hash) {
                return; // No actual change
            }

            this.emit('file-upload-start', { file: filename });

            await processFile(fullPath, {
                password: this.password,
                dataDir: this.dataDir,
                customName: filename,
                config: this.config,
                telegramPool: this.telegramPool,
                replaceExisting: true,
                limitRate: this.limitRate,
                onProgress: (msg) => this.emit('progress', { file: filename, message: msg })
            });

            this.db.updateSyncState(folder.id, filename, hash, stats.mtimeMs);

            this.emit('file-upload-complete', { file: filename });
        } catch (err) {
            this.emit('file-upload-error', { file: filename, error: err.message });
        }
    }

    /**
     * Collect all subdirectories under dirPath (including itself).
     * Used because fs.watch({ recursive: true }) only works on macOS/Windows.
     */
    _collectDirs(dirPath) {
        const dirs = [dirPath];
        let entries;
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
            return dirs;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (this.shouldIgnore(entry.name)) continue;
            dirs.push(...this._collectDirs(path.join(dirPath, entry.name)));
        }
        return dirs;
    }

    _watchSingleDir(watchedDir, rootPath) {
        if (this.watchers.has(watchedDir)) return;
        let watcher;
        try {
            watcher = fs.watch(watchedDir, (event, filename) => {
                if (!filename) return;
                const fullPath = path.join(watchedDir, filename);
                const rel = path.relative(rootPath, fullPath);
                if (!rel || rel.startsWith('..')) return;
                // A new subdirectory appeared — start watching it too
                try {
                    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                        if (!this.shouldIgnore(filename)) {
                            for (const d of this._collectDirs(fullPath)) {
                                this._watchSingleDir(d, rootPath);
                            }
                        }
                        return;
                    }
                } catch { /* fall through to file handling */ }
                this.handleFileChange(rootPath, rel);
            });
        } catch (err) {
            this.emit('watch-error', { folder: watchedDir, error: err.message });
            return;
        }

        watcher.on('error', (err) => {
            this.emit('watch-error', { folder: watchedDir, error: err.message });
        });

        this.watchers.set(watchedDir, watcher);
    }

    /**
     * Start watching a folder (recursive on all platforms)
     */
    watchFolder(folderPath) {
        if (!fs.existsSync(folderPath)) return;
        for (const dir of this._collectDirs(folderPath)) {
            this._watchSingleDir(dir, folderPath);
        }
        this.emit('watch-start', { folder: folderPath });
    }

    /**
     * Stop watching a folder (closes the root watcher and any subdir watchers)
     */
    unwatchFolder(folderPath) {
        let stopped = false;
        for (const [watchedDir, watcher] of [...this.watchers]) {
            if (watchedDir === folderPath || watchedDir.startsWith(folderPath + path.sep)) {
                try { watcher.close(); } catch { }
                this.watchers.delete(watchedDir);
                stopped = true;
            }
        }
        if (stopped) this.emit('watch-stop', { folder: folderPath });
    }

    /**
     * Start syncing all registered folders
     */
    async start() {
        this.running = true;
        const folders = this.db.getSyncFolders();

        for (const folder of folders) {
            if (folder.enabled) {
                // Initial sync
                await this.syncFolder(folder.local_path);
                // Start watching
                this.watchFolder(folder.local_path);
            }
        }
    }

    /**
     * Stop all watchers
     */
    stop() {
        this.running = false;

        // Clear pending changes
        for (const timeout of this.pendingChanges.values()) {
            clearTimeout(timeout);
        }
        this.pendingChanges.clear();

        // Close all watchers
        for (const [folderPath, watcher] of this.watchers) {
            watcher.close();
            this.emit('watch-stop', { folder: folderPath });
        }
        this.watchers.clear();

        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
