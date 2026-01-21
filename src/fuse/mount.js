/**
 * FUSE Filesystem Mount
 * Mount Telegram storage as a local folder
 * 
 * This is the killer feature - use Telegram like a regular folder!
 */

import Fuse from 'fuse-native';
import path from 'path';
import fs from 'fs';
import { TelegramClient } from '../telegram/client.js';
import { Encryptor } from '../crypto/encryption.js';
import { Compressor } from '../utils/compression.js';
import { FileIndex } from '../db/index.js';
import { createHeader, parseHeader, HEADER_SIZE } from '../utils/chunker.js';

// File cache for performance (avoid re-downloading)
const fileCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class TelegramFS {
    constructor(options) {
        this.dataDir = options.dataDir;
        this.password = options.password;
        this.config = options.config;
        this.mountPoint = options.mountPoint;

        this.db = new FileIndex(path.join(this.dataDir, 'index.db'));
        this.db.init();

        this.encryptor = new Encryptor(this.password);
        this.compressor = new Compressor();
        this.client = null;
        this.fuse = null;

        // Pending writes buffer
        this.writeBuffers = new Map();
    }

    async initialize() {
        // Connect to Telegram
        this.client = new TelegramClient(this.dataDir);
        await this.client.initialize(this.config.botToken);
        this.client.setChatId(this.config.chatId);
    }

    /**
     * Get file attributes
     */
    getattr(filepath, cb) {
        const filename = path.basename(filepath);

        // Root directory
        if (filepath === '/') {
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
        const wb = this.writeBuffers.get(filename);
        if (wb) {
            return cb(0, {
                mtime: new Date(),
                atime: new Date(),
                ctime: new Date(),
                size: wb.data.length,
                mode: 0o100644, // regular file
                uid: process.getuid?.() || 0,
                gid: process.getgid?.() || 0
            });
        }

        // Look up file in index
        const file = this.db.findByName(filename);

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
        if (filepath !== '/') {
            return cb(Fuse.ENOENT);
        }

        const files = this.db.listAll();
        const names = files.map(f => f.filename);

        return cb(0, names);
    }

    /**
     * Open a file (just validates it exists)
     */
    open(filepath, flags, cb) {
        const filename = path.basename(filepath);

        // Check if it's a new file being written
        if (this.writeBuffers.has(filename)) {
            return cb(0, 42); // Return a dummy fd
        }

        const file = this.db.findByName(filename);

        if (!file) {
            return cb(Fuse.ENOENT);
        }

        return cb(0, file.id); // Use file ID as file descriptor
    }

    /**
     * Read file contents
     */
    async read(filepath, fd, buffer, length, position, cb) {
        const filename = path.basename(filepath);

        try {
            // Check cache first
            let data = this.getCached(filename);

            if (!data) {
                // Download and decrypt
                data = await this.downloadFile(filename);
                this.setCache(filename, data);
            }

            // Copy requested portion to buffer
            const slice = data.subarray(position, position + length);
            slice.copy(buffer);

            return cb(slice.length);
        } catch (err) {
            console.error('Read error:', err.message);
            return cb(Fuse.EIO);
        }
    }

    /**
     * Write to a file (buffers until release)
     */
    write(filepath, fd, buffer, length, position, cb) {
        const filename = path.basename(filepath);

        // Get or create write buffer
        if (!this.writeBuffers.has(filename)) {
            this.writeBuffers.set(filename, {
                data: Buffer.alloc(0),
                modified: true
            });
        }

        const wb = this.writeBuffers.get(filename);

        // Expand buffer if needed
        const newSize = Math.max(wb.data.length, position + length);
        if (newSize > wb.data.length) {
            const newBuf = Buffer.alloc(newSize);
            wb.data.copy(newBuf);
            wb.data = newBuf;
        }

        // Copy incoming data
        buffer.copy(wb.data, position, 0, length);
        wb.modified = true;

        return cb(length);
    }

    /**
     * Create a new file
     */
    create(filepath, mode, cb) {
        const filename = path.basename(filepath);

        console.log(`[FUSE] Creating file: ${filename}`);

        // Initialize empty write buffer
        this.writeBuffers.set(filename, {
            data: Buffer.alloc(0),
            modified: true,
            isNew: true
        });

        return cb(0, 42); // Return a valid fd
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
        const filename = path.basename(filepath);

        const wb = this.writeBuffers.get(filename);
        if (!wb || !wb.modified) {
            return cb(0);
        }

        try {
            // Upload to Telegram
            await this.uploadFile(filename, wb.data);

            // Clear write buffer
            this.writeBuffers.delete(filename);

            // Invalidate cache
            this.invalidateCache(filename);

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
        const filename = path.basename(filepath);
        const file = this.db.findByName(filename);

        if (!file) {
            return cb(Fuse.ENOENT);
        }

        try {
            // Delete from Telegram (optional - could just remove from index)
            const chunks = this.db.getChunks(file.id);
            for (const chunk of chunks) {
                await this.client.deleteMessage(chunk.message_id);
            }

            // Remove from index
            this.db.delete(file.id);

            // Invalidate cache
            this.invalidateCache(filename);

            return cb(0);
        } catch (err) {
            console.error('Unlink error:', err.message);
            return cb(Fuse.EIO);
        }
    }

    /**
     * Rename/move a file (just update index, data stays in Telegram)
     */
    rename(src, dest, cb) {
        const oldName = path.basename(src);
        const newName = path.basename(dest);

        const file = this.db.findByName(oldName);
        if (!file) {
            return cb(Fuse.ENOENT);
        }

        // Update filename in database
        this.db.db.prepare('UPDATE files SET filename = ? WHERE id = ?')
            .run(newName, file.id);

        // Update cache key
        const cached = fileCache.get(oldName);
        if (cached) {
            fileCache.delete(oldName);
            fileCache.set(newName, cached);
        }

        return cb(0);
    }

    /**
     * Truncate a file
     */
    truncate(filepath, size, cb) {
        const filename = path.basename(filepath);

        // Get or load into write buffer
        if (!this.writeBuffers.has(filename)) {
            const cached = this.getCached(filename);
            if (cached) {
                this.writeBuffers.set(filename, {
                    data: Buffer.from(cached),
                    modified: true
                });
            } else {
                this.writeBuffers.set(filename, {
                    data: Buffer.alloc(0),
                    modified: true
                });
            }
        }

        const wb = this.writeBuffers.get(filename);

        if (size < wb.data.length) {
            wb.data = wb.data.subarray(0, size);
        } else if (size > wb.data.length) {
            const newBuf = Buffer.alloc(size);
            wb.data.copy(newBuf);
            wb.data = newBuf;
        }

        wb.modified = true;
        return cb(0);
    }

    // ============== Helper Methods ==============

    async downloadFile(filename) {
        const file = this.db.findByName(filename);
        if (!file) throw new Error('File not found');

        const chunks = this.db.getChunks(file.id);
        if (chunks.length === 0) throw new Error('No chunks found');

        // Download all chunks
        const downloadedChunks = [];

        for (const chunk of chunks) {
            const data = await this.client.downloadFile(chunk.file_telegram_id);
            const header = parseHeader(data);
            const payload = data.subarray(HEADER_SIZE);

            downloadedChunks.push({
                index: header.chunkIndex,
                data: payload,
                compressed: header.compressed
            });
        }

        // Reassemble
        downloadedChunks.sort((a, b) => a.index - b.index);
        const encryptedData = Buffer.concat(downloadedChunks.map(c => c.data));

        // Decrypt
        const compressedData = this.encryptor.decrypt(encryptedData);

        // Decompress
        const wasCompressed = downloadedChunks[0].compressed;
        return await this.compressor.decompress(compressedData, wasCompressed);
    }

    async uploadFile(filename, data) {
        const { hashData } = await import('../crypto/encryption.js');
        const hash = hashData(data);

        // Check if already exists by name
        const existingByName = this.db.findByName(filename);
        if (existingByName) {
            // Delete old version
            const chunks = this.db.getChunks(existingByName.id);
            for (const chunk of chunks) {
                try { await this.client.deleteMessage(chunk.message_id); } catch (e) { }
            }
            this.db.delete(existingByName.id);
        }

        // Check if already exists by hash (same content, different name)
        const existingByHash = this.db.findByHash(hash);
        if (existingByHash) {
            // Same content already exists, just skip
            console.log(`[FUSE] File with same content already exists as ${existingByHash.filename}`);
            return;
        }

        // Compress
        const { data: compressedData, compressed } = await this.compressor.compress(data, filename);

        // Encrypt
        const encryptedData = this.encryptor.encrypt(compressedData);

        // Create temp file with header
        const tempDir = path.join(this.dataDir, 'tmp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        const flags = compressed ? 1 : 0;
        const header = createHeader(filename, data.length, 0, 1, flags);
        const fileData = Buffer.concat([header, encryptedData]);

        const tempPath = path.join(tempDir, `${hash.substring(0, 12)}.tas`);
        fs.writeFileSync(tempPath, fileData);

        // Upload to Telegram
        const result = await this.client.sendFile(tempPath, `📦 ${filename}`);

        // Add to index
        const fileId = this.db.addFile({
            filename,
            hash,
            originalSize: data.length,
            storedSize: encryptedData.length,
            chunks: 1,
            compressed
        });

        this.db.addChunk(fileId, 0, result.messageId.toString(), fileData.length);
        this.db.db.prepare('UPDATE chunks SET file_telegram_id = ? WHERE file_id = ? AND chunk_index = ?')
            .run(result.fileId, fileId, 0);

        // Cleanup
        fs.unlinkSync(tempPath);
        try { fs.rmdirSync(tempDir); } catch (e) { }
    }

    getCached(filename) {
        const entry = fileCache.get(filename);
        if (!entry) return null;

        if (Date.now() - entry.timestamp > CACHE_TTL) {
            fileCache.delete(filename);
            return null;
        }

        return entry.data;
    }

    setCache(filename, data) {
        fileCache.set(filename, {
            data,
            timestamp: Date.now()
        });
    }

    invalidateCache(filename) {
        fileCache.delete(filename);
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
