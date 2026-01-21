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

// Debounce time in ms to batch rapid file changes
const DEBOUNCE_MS = 1000;

// Ignore patterns
const IGNORE_PATTERNS = [
    /^\./, // Hidden files
    /~$/, // Backup files
    /\.swp$/, // Vim swap files
    /\.tmp$/, // Temp files
    /node_modules/,
    /\.git/
];

export class SyncEngine extends EventEmitter {
    constructor(options) {
        super();
        this.dataDir = options.dataDir;
        this.password = options.password;
        this.config = options.config;
        this.watchers = new Map(); // path -> FSWatcher
        this.pendingChanges = new Map(); // path -> timeout
        this.db = null;
        this.running = false;
    }

    /**
     * Initialize the sync engine
     */
    async initialize() {
        this.db = new FileIndex(path.join(this.dataDir, 'index.db'));
        this.db.init();
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

        for (const file of files) {
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

                await processFile(file.path, {
                    password: this.password,
                    dataDir: this.dataDir,
                    customName: file.relativePath, // Use relative path as name
                    config: this.config,
                    onProgress: (msg) => this.emit('progress', { file: file.relativePath, message: msg })
                });

                // Update sync state
                this.db.updateSyncState(folder.id, file.relativePath, hash, file.mtime);
                uploaded++;

                this.emit('file-upload-complete', { file: file.relativePath });
            } catch (err) {
                // File might already exist, skip
                if (err.message.includes('duplicate')) {
                    this.db.updateSyncState(folder.id, file.relativePath, hash, file.mtime);
                    skipped++;
                } else {
                    this.emit('file-upload-error', { file: file.relativePath, error: err.message });
                }
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
                onProgress: (msg) => this.emit('progress', { file: filename, message: msg })
            });

            this.db.updateSyncState(folder.id, filename, hash, stats.mtimeMs);

            this.emit('file-upload-complete', { file: filename });
        } catch (err) {
            if (!err.message.includes('duplicate')) {
                this.emit('file-upload-error', { file: filename, error: err.message });
            }
        }
    }

    /**
     * Start watching a folder
     */
    watchFolder(folderPath) {
        if (this.watchers.has(folderPath)) {
            return; // Already watching
        }

        const watcher = fs.watch(folderPath, { recursive: true }, (event, filename) => {
            if (filename) {
                this.handleFileChange(folderPath, filename);
            }
        });

        watcher.on('error', (err) => {
            this.emit('watch-error', { folder: folderPath, error: err.message });
        });

        this.watchers.set(folderPath, watcher);
        this.emit('watch-start', { folder: folderPath });
    }

    /**
     * Stop watching a folder
     */
    unwatchFolder(folderPath) {
        const watcher = this.watchers.get(folderPath);
        if (watcher) {
            watcher.close();
            this.watchers.delete(folderPath);
            this.emit('watch-stop', { folder: folderPath });
        }
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
