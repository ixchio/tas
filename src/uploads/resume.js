/**
 * Resumable upload service shared by `tas resume` and folder sync startup.
 */

import fs from 'fs';
import path from 'path';
import { FileIndex } from '../db/index.js';
import { TelegramPool } from '../telegram/pool.js';
import { backupRemoteManifest } from '../manifest.js';
import { createChunkCaption } from '../index.js';

function stagingRoot(dataDir) {
    return path.resolve(process.env.TAS_TMP_DIR || path.join(dataDir, 'tmp'));
}

function removeStagedFiles(upload, chunks) {
    for (const chunk of chunks) {
        try { fs.unlinkSync(chunk.chunk_path); } catch { }
    }
    if (upload.temp_dir) {
        try { fs.rmdirSync(upload.temp_dir); } catch { }
    }
}

function removeEmptyStagingRoot(dataDir) {
    const root = stagingRoot(dataDir);
    try {
        if (fs.readdirSync(root).length === 0) fs.rmdirSync(root);
    } catch { }
}

function validatePendingChunks(upload, chunks) {
    if (chunks.length !== upload.total_chunks) {
        throw new Error(
            `Staging metadata is incomplete: found ${chunks.length}/${upload.total_chunks} chunk records`
        );
    }

    for (let index = 0; index < upload.total_chunks; index++) {
        const chunk = chunks[index];
        if (!chunk || chunk.chunk_index !== index) {
            throw new Error(`Staging metadata is missing chunk ${index + 1}/${upload.total_chunks}`);
        }
        if (chunk.uploaded && (!chunk.message_id || !chunk.file_telegram_id)) {
            throw new Error(`Uploaded chunk ${index + 1}/${upload.total_chunks} is missing Telegram metadata`);
        }
        if (!chunk.uploaded && !fs.existsSync(chunk.chunk_path)) {
            throw new Error(`Staged chunk is missing: ${chunk.chunk_path}`);
        }
    }
}

/**
 * Continue every recoverable pending upload without prompting.
 *
 * Failures are isolated per upload so one damaged staging directory does not
 * prevent other uploads from completing.
 */
export async function resumePendingUploads(options) {
    const {
        dataDir,
        password,
        config,
        db: suppliedDb,
        telegramPool: suppliedPool,
        limitRate = null,
        updateManifest = true,
        onUploadStart,
        onChunkStart,
        onUploadComplete,
        onUploadError,
        onManifestError
    } = options;

    const ownsDb = !suppliedDb;
    const db = suppliedDb || new FileIndex(path.join(dataDir, 'index.db'));
    if (ownsDb) db.init();

    const pending = db.getPendingUploads();
    if (pending.length === 0) {
        if (ownsDb) db.close();
        return {
            found: 0,
            completed: 0,
            remaining: 0,
            failed: [],
            manifestUpdated: false,
            manifestWarning: null
        };
    }

    const pool = suppliedPool || new TelegramPool(dataDir, config.bots);
    const failed = [];
    const supersededChunks = [];
    let completed = 0;

    try {
        if (!suppliedPool) await pool.initialize({ includeDisabled: false });
        for (const upload of pending) {
            onUploadStart?.(upload);
            try {
                let chunks = db.getPendingChunks(upload.id);
                validatePendingChunks(upload, chunks);

                for (const chunk of chunks) {
                    if (chunk.uploaded) continue;

                    onChunkStart?.(upload, chunk);
                    const result = await pool.sendFile(
                        chunk.chunk_path,
                        createChunkCaption(upload.id, chunk.chunk_index, upload.total_chunks),
                        {
                            ...(limitRate ? { limitRate } : {}),
                            botId: pool.selectBotId(upload.hash, chunk.chunk_index),
                            routingKey: upload.hash,
                            chunkIndex: chunk.chunk_index
                        }
                    );
                    db.markChunkUploaded(
                        upload.id,
                        chunk.chunk_index,
                        String(result.messageId),
                        result.fileId,
                        result.botId
                    );
                    try { fs.unlinkSync(chunk.chunk_path); } catch { }
                }

                chunks = db.getPendingChunks(upload.id);
                validatePendingChunks(upload, chunks);
                if (!chunks.every(chunk => chunk.uploaded)) {
                    throw new Error('Upload still has incomplete chunks');
                }

                const existing = db.findByExactName(upload.filename);
                const oldChunks = existing ? db.getChunks(existing.id) : [];
                db.db.transaction(() => {
                    const fileId = db.addFile({
                        filename: upload.filename,
                        hash: upload.hash,
                        originalSize: upload.original_size,
                        storedSize: upload.stored_size || Math.max(
                            0,
                            chunks.reduce((sum, chunk) => sum + (chunk.size || 0), 0) - chunks.length * 64
                        ),
                        chunks: upload.total_chunks,
                        compressed: Boolean(upload.compressed)
                    });

                    for (const chunk of chunks) {
                        db.addChunk(
                            fileId,
                            chunk.chunk_index,
                            chunk.message_id,
                            chunk.size || 0,
                            chunk.file_telegram_id,
                            chunk.bot_id || null
                        );
                    }
                    if (existing) {
                        db.repointFileRelations(existing.id, fileId);
                        db.deleteFileCascade(existing.id);
                    }
                    db.deletePendingUpload(upload.id);
                })();

                supersededChunks.push(...oldChunks);
                removeStagedFiles(upload, chunks);
                completed++;
                onUploadComplete?.(upload);
            } catch (error) {
                failed.push({ upload, error });
                onUploadError?.(upload, error);
            }
        }

        let manifestUpdated = false;
        let manifestWarning = null;
        if (completed > 0 && updateManifest) {
            try {
                await backupRemoteManifest({ dataDir, password, config, telegramPool: pool });
                manifestUpdated = true;
                for (const chunk of supersededChunks) {
                    try { await pool.deleteMessage(chunk.message_id, chunk.bot_id || null); } catch { }
                }
            } catch (error) {
                manifestWarning = error.message;
                onManifestError?.(error);
            }
        }

        const remaining = db.getPendingUploads().length;
        removeEmptyStagingRoot(dataDir);
        return {
            found: pending.length,
            completed,
            remaining,
            failed,
            manifestUpdated,
            manifestWarning
        };
    } finally {
        if (ownsDb) db.close();
    }
}

/** Remove pending state and best-effort delete already uploaded Telegram messages. */
export async function clearPendingUploads(options) {
    const { dataDir, config, db: suppliedDb, telegramPool: suppliedPool } = options;
    const ownsDb = !suppliedDb;
    const db = suppliedDb || new FileIndex(path.join(dataDir, 'index.db'));
    if (ownsDb) db.init();
    const pending = db.getPendingUploads();
    if (pending.length === 0) {
        if (ownsDb) db.close();
        return { cleared: 0 };
    }

    const pool = suppliedPool || new TelegramPool(dataDir, config.bots);
    try {
        for (const upload of pending) {
            const chunks = db.getPendingChunks(upload.id);
            for (const chunk of chunks) {
                if (chunk.uploaded && chunk.message_id) {
                    try { await pool.deleteMessage(chunk.message_id, chunk.bot_id || null); } catch { }
                }
            }
            removeStagedFiles(upload, chunks);
            db.deletePendingUpload(upload.id);
        }
        removeEmptyStagingRoot(dataDir);
        return { cleared: pending.length };
    } finally {
        if (ownsDb) db.close();
    }
}

/**
 * Delete only old, unreferenced TAS staging directories. A minimum age avoids
 * touching another live TAS process that is still preparing chunks.
 */
export function pruneOrphanedStaging(options) {
    const {
        dataDir,
        db: suppliedDb,
        olderThanMs = 24 * 60 * 60 * 1000,
        now = Date.now()
    } = options;
    const ownsDb = !suppliedDb;
    const db = suppliedDb || new FileIndex(path.join(dataDir, 'index.db'));
    if (ownsDb) db.init();

    try {
        const root = stagingRoot(dataDir);
        const referenced = new Set(
            db.getPendingUploads()
                .map(upload => upload.temp_dir && path.resolve(upload.temp_dir))
                .filter(Boolean)
        );
        let removed = 0;
        let reclaimedBytes = 0;
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { removed, reclaimedBytes }; }

        for (const entry of entries) {
            if (!entry.isDirectory() || !/^[a-f0-9]{12}-/.test(entry.name)) continue;
            const directory = path.resolve(root, entry.name);
            if (path.dirname(directory) !== root || referenced.has(directory)) continue;

            let stats;
            try { stats = fs.statSync(directory); } catch { continue; }
            if (now - stats.mtimeMs < olderThanMs) continue;

            const stack = [directory];
            while (stack.length > 0) {
                const current = stack.pop();
                let children = [];
                try { children = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
                for (const child of children) {
                    const childPath = path.join(current, child.name);
                    if (child.isDirectory()) stack.push(childPath);
                    else {
                        try { reclaimedBytes += fs.statSync(childPath).size; } catch { }
                    }
                }
            }
            fs.rmSync(directory, { recursive: true, force: true });
            removed++;
        }
        removeEmptyStagingRoot(dataDir);
        return { removed, reclaimedBytes };
    } finally {
        if (ownsDb) db.close();
    }
}
