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
import { pruneOrphanedStaging, resumePendingUploads } from '../uploads/resume.js';

// Debounce time in ms to batch rapid file changes
const DEBOUNCE_MS = 1000;
const PROGRESS_INTERVAL_MS = 2000;
const PROGRESS_FILE_INTERVAL = 250;

function abortError() {
    const error = new Error('Sync stopped');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function isAbortError(error) {
    return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

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
        this.autoResume = options.autoResume !== false;
        this.watchers = new Map(); // path -> FSWatcher
        this.pendingChanges = new Map(); // path -> timeout
        this.db = null;
        this.telegramPool = null;
        this.running = false;
        this.starting = false;
        this.closeWhenIdle = false;
        this.abortController = null;
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

    /** A matching durable record can rebuild missing local sync state. */
    hasStoredVersion(logicalPath, hash) {
        const stored = this.db.findByExactName(logicalPath);
        if (!stored || stored.hash !== hash) return false;
        const chunks = this.db.getChunks(stored.id);
        return chunks.length === stored.chunks && chunks.every((chunk, index) => chunk.chunk_index === index);
    }

    /**
     * Get all files in a directory recursively
     */
    async scanDirectory(dirPath, relativeTo = dirPath, scanState = null) {
        const state = scanState || {
            signal: this.abortController?.signal,
            files: 0,
            directories: 0,
            directoryPaths: [],
            lastReportAt: Date.now(),
            lastReportFiles: 0
        };
        const files = [];
        throwIfAborted(state.signal);
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        state.directories++;
        state.directoryPaths?.push(dirPath);

        for (const entry of entries) {
            throwIfAborted(state.signal);
            if (this.shouldIgnore(entry.name)) continue;

            const fullPath = path.join(dirPath, entry.name);
            const relativePath = path.relative(relativeTo, fullPath);

            if (entry.isDirectory()) {
                const subFiles = await this.scanDirectory(fullPath, relativeTo, state);
                files.push(...subFiles);
            } else if (entry.isFile()) {
                let stats;
                try {
                    stats = await fs.promises.stat(fullPath);
                } catch (error) {
                    // Files may disappear while a live folder is being scanned.
                    if (error.code === 'ENOENT') continue;
                    throw error;
                }
                files.push({
                    path: fullPath,
                    relativePath,
                    mtime: stats.mtimeMs,
                    size: stats.size
                });
                state.files++;

                const now = Date.now();
                if (
                    state.files - state.lastReportFiles >= PROGRESS_FILE_INTERVAL ||
                    now - state.lastReportAt >= PROGRESS_INTERVAL_MS
                ) {
                    state.lastReportAt = now;
                    state.lastReportFiles = state.files;
                    this.emit('scan-progress', {
                        phase: 'discover',
                        files: state.files,
                        directories: state.directories
                    });
                }
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

        const signal = this.abortController?.signal;
        const scanState = {
            signal,
            files: 0,
            directories: 0,
            directoryPaths: [],
            lastReportAt: Date.now(),
            lastReportFiles: 0
        };
        const files = await this.scanDirectory(folderPath, folderPath, scanState);
        throwIfAborted(signal);
        this.emit('scan-progress', {
            phase: 'discovered',
            files: files.length,
            directories: scanState.directories
        });
        const existingStates = this.db.getFolderSyncStates(folder.id);
        const stateMap = new Map(existingStates.map(s => [s.relative_path, s]));

        let uploaded = 0;
        let skipped = 0;
        let checked = 0;
        let lastCheckReportAt = Date.now();
        let lastCheckReportCount = 0;
        const supersededChunks = [];

        const reportChecked = (file) => {
            checked++;
            const now = Date.now();
            if (
                checked === files.length ||
                checked - lastCheckReportCount >= PROGRESS_FILE_INTERVAL ||
                now - lastCheckReportAt >= PROGRESS_INTERVAL_MS
            ) {
                lastCheckReportAt = now;
                lastCheckReportCount = checked;
                this.emit('scan-progress', {
                    phase: 'check',
                    checked,
                    total: files.length,
                    file: file.relativePath
                });
            }
        };

        // Process files with concurrency limit
        const CONCURRENCY = 4;
        const queue = [...files];
        const promises = [];

        const worker = async () => {
            while (queue.length > 0) {
                throwIfAborted(signal);
                const file = queue.shift();
                try {
                    const existing = stateMap.get(file.relativePath);

                    // Check if file has changed (by mtime)
                    if (existing && existing.mtime >= file.mtime) {
                        skipped++;
                        continue;
                    }

                    // Calculate hash to detect actual changes. The abort signal
                    // keeps Ctrl+C responsive even while reading a large file.
                    let hash;
                    try {
                        hash = await hashFile(file.path, { signal });
                    } catch (error) {
                        if (isAbortError(error)) throw error;
                        if (error.code === 'ENOENT') {
                            skipped++;
                            continue;
                        }
                        throw error;
                    }

                    if (existing && existing.file_hash === hash) {
                        // File unchanged, just update mtime
                        this.db.updateSyncState(folder.id, file.relativePath, hash, file.mtime);
                        skipped++;
                        continue;
                    }

                    if (this.hasStoredVersion(file.relativePath, hash)) {
                        // This commonly happens after an interrupted sync upload is
                        // completed by automatic resume before the initial scan.
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
                            signal,
                            limitRate: this.limitRate ? Math.floor(this.limitRate / CONCURRENCY) : null,
                            onProgress: (msg) => this.emit('progress', { file: file.relativePath, message: msg })
                        });
                        supersededChunks.push(...(result.supersededChunks || []));

                        // Update sync state
                        this.db.updateSyncState(folder.id, file.relativePath, hash, file.mtime);
                        uploaded++;

                        this.emit('file-upload-complete', { file: file.relativePath });
                    } catch (err) {
                        if (isAbortError(err) || signal?.aborted) throw abortError();
                        // Sleep briefly on a network/provider error before this
                        // worker advances; the staged upload remains resumable.
                        await new Promise(r => setTimeout(r, 2000));
                        this.emit('file-upload-error', { file: file.relativePath, error: err.message });
                    }
                } finally {
                    reportChecked(file);
                }
            }
        };

        for (let i = 0; i < CONCURRENCY; i++) {
            promises.push(worker());
        }

        await Promise.all(promises);
        throwIfAborted(signal);

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

        return { uploaded, skipped, directories: scanState.directoryPaths };
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

            if (this.hasStoredVersion(filename, hash)) {
                this.db.updateSyncState(folder.id, filename, hash, stats.mtimeMs);
                return;
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
        if (this.watchers.has(watchedDir)) return true;
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
            return false;
        }

        watcher.on('error', (err) => {
            this.emit('watch-error', { folder: watchedDir, error: err.message });
        });

        this.watchers.set(watchedDir, watcher);
        return true;
    }

    /**
     * Start watching a folder (recursive on all platforms)
     */
    async watchFolder(folderPath, directories = null) {
        if (!fs.existsSync(folderPath)) return;
        const dirs = directories || this._collectDirs(folderPath);
        let failed = 0;
        for (let index = 0; index < dirs.length; index++) {
            throwIfAborted(this.abortController?.signal);
            if (!this._watchSingleDir(dirs[index], folderPath)) failed++;
            // Yield while installing a large watcher set so signals are handled.
            if ((index + 1) % PROGRESS_FILE_INTERVAL === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        if (failed > 0) {
            throw new Error(
                `Could not watch ${failed}/${dirs.length} directories under ${folderPath}; ` +
                'check filesystem support and the Linux inotify watch limit'
            );
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
        if (this.running || this.starting) throw new Error('Sync is already running');
        this.running = true;
        this.starting = true;
        this.closeWhenIdle = false;
        this.abortController = new AbortController();
        try {
            if (this.autoResume) {
                const pruned = pruneOrphanedStaging({ dataDir: this.dataDir, db: this.db });
                if (pruned.removed > 0) this.emit('staging-pruned', pruned);

                const resume = await resumePendingUploads({
                    dataDir: this.dataDir,
                    password: this.password,
                    config: this.config,
                    db: this.db,
                    telegramPool: this.telegramPool,
                    limitRate: this.limitRate,
                    onUploadStart: upload => this.emit('resume-upload-start', { file: upload.filename }),
                    onUploadComplete: upload => this.emit('resume-upload-complete', { file: upload.filename }),
                    onUploadError: (upload, error) => this.emit('resume-upload-error', {
                        file: upload.filename,
                        error: error.message
                    }),
                    onManifestError: error => this.emit('manifest-error', { error: error.message })
                });
                if (resume.found > 0) this.emit('resume-complete', resume);
            }

            throwIfAborted(this.abortController.signal);
            const folders = this.db.getSyncFolders();

            for (const folder of folders) {
                throwIfAborted(this.abortController.signal);
                if (folder.enabled) {
                    // Initial sync
                    const result = await this.syncFolder(folder.local_path);
                    throwIfAborted(this.abortController.signal);
                    // Start watching
                    await this.watchFolder(folder.local_path, result.directories);
                }
            }
        } catch (error) {
            if (!isAbortError(error)) throw error;
        } finally {
            this.starting = false;
            if (this.closeWhenIdle) this.closeDatabase();
        }
    }

    closeDatabase() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    /**
     * Stop all watchers
     */
    stop() {
        this.running = false;
        this.abortController?.abort();

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

        if (this.starting) this.closeWhenIdle = true;
        else this.closeDatabase();
    }
}
