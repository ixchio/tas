/**
 * Main processing module
 * Orchestrates the upload/download pipeline
 */

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Encryptor, hashFile } from './crypto/encryption.js';
import { Compressor } from './utils/compression.js';
import { createHeader, HEADER_SIZE, MAX_CHUNK_SIZE } from './utils/chunker.js';
import { TelegramPool } from './telegram/pool.js';
import { FileIndex } from './db/index.js';
import { normalizeLogicalPath } from './utils/logical-path.js';
import { backupRemoteManifest } from './manifest.js';

// The hosted Bot API can upload 50 MB but getFile downloads only up to 20 MB.
// A 19 MiB encrypted payload plus the 64-byte TAS header is round-trip safe.
export const TELEGRAM_CHUNK_SIZE = MAX_CHUNK_SIZE;

export function createPublicChunkHeader(chunkIndex, totalChunks, flags) {
    return createHeader('', 0, chunkIndex, totalChunks, flags);
}

export function createChunkCaption(uploadId, chunkIndex, totalChunks) {
    return `tas:c1:${uploadId}:${chunkIndex + 1}/${totalChunks}`;
}

/**
 * Process and upload a file to Telegram
 */
export async function processFile(filePath, options) {
    const {
        password,
        dataDir,
        customName,
        config,
        onProgress,
        onByteProgress,
        limitRate,
        telegramPool,
        replaceExisting = false,
        updateManifest = true
    } = options;

    onProgress?.('Reading file...');

    // Read file initially just to get size
    const filename = normalizeLogicalPath(customName || path.basename(filePath));
    const stats = fs.statSync(filePath);
    const originalSize = stats.size;

    // Calculate hash
    onProgress?.('Calculating hash...');
    const hash = await hashFile(filePath);

    // Logical paths are exact. Identical bytes may legitimately exist under
    // different paths, so content hash is indexed but no longer globally unique.
    const db = new FileIndex(path.join(dataDir, 'index.db'));
    db.init();

    const existingFile = db.findByExactName(filename);
    if (existingFile && existingFile.hash === hash) {
        db.close();
        throw new Error('This logical path already contains the same file');
    }
    if (existingFile && !replaceExisting) {
        db.close();
        throw new Error(`A different file already exists at "${filename}"`);
    }
    const existingChunks = existingFile ? db.getChunks(existingFile.id) : [];

    // Prepare processing components
    const compressor = new Compressor();
    const { stream: compressStream, compressed } = compressor.getCompressStream(filename);
    const flags = compressed ? 1 : 0;

    const encryptor = new Encryptor(password);
    const encryptStream = encryptor.getEncryptStream();

    const tempRoot = process.env.TAS_TMP_DIR || path.join(dataDir, 'tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const uploadDir = fs.mkdtempSync(path.join(tempRoot, `${hash.substring(0, 12)}-`));

    // First stream the exact encrypted chunks to disk. This makes upload
    // resumption real: once network transfer starts, every remaining chunk is
    // already durable locally and every completed Telegram ID is in SQLite.
    const { Writable } = await import('stream');
    let currentChunkBuffer = Buffer.alloc(0);
    let totalStoredSize = 0;
    const stagedChunks = [];

    const stageChunk = (payload) => {
        const index = stagedChunks.length;
        const chunkPath = path.join(uploadDir, `chunk-${String(index).padStart(6, '0')}.tas`);
        const header = createPublicChunkHeader(index, 0, flags);
        fs.writeFileSync(chunkPath, Buffer.concat([header, payload]), { mode: 0o600 });
        totalStoredSize += payload.length;
        stagedChunks.push({ index, path: chunkPath, size: header.length + payload.length });
    };

    const chunkingStream = new Writable({
        write(chunk, encoding, callback) {
            try {
                currentChunkBuffer = Buffer.concat([currentChunkBuffer, chunk]);
                while (currentChunkBuffer.length >= TELEGRAM_CHUNK_SIZE) {
                    stageChunk(currentChunkBuffer.subarray(0, TELEGRAM_CHUNK_SIZE));
                    currentChunkBuffer = currentChunkBuffer.subarray(TELEGRAM_CHUNK_SIZE);
                }
                callback();
            } catch (error) {
                callback(error);
            }
        },
        final(callback) {
            try {
                if (currentChunkBuffer.length > 0 || stagedChunks.length === 0) stageChunk(currentChunkBuffer);
                callback();
            } catch (error) {
                callback(error);
            }
        }
    });

    onProgress?.('Compressing and encrypting to resumable chunks...');
    try {
        await pipeline(fs.createReadStream(filePath), compressStream, encryptStream, chunkingStream);
    } catch (error) {
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { }
        db.close();
        throw new Error(`Local processing failed before upload: ${error.message}`);
    }

    const totalChunks = stagedChunks.length;
    if (totalChunks > 0xffff) {
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { }
        db.close();
        throw new Error(`File requires ${totalChunks} chunks, above the WAS1 limit of 65,535`);
    }
    for (const staged of stagedChunks) {
        const fd = fs.openSync(staged.path, 'r+');
        try {
            fs.writeSync(fd, createPublicChunkHeader(staged.index, totalChunks, flags), 0, HEADER_SIZE, 0);
        } finally {
            fs.closeSync(fd);
        }
    }

    let pendingId;
    try {
        pendingId = db.addPendingUpload({
            filename,
            filePath,
            hash,
            originalSize,
            storedSize: totalStoredSize,
            compressed,
            totalChunks,
            uploadedChunks: 0,
            tempDir: uploadDir
        });
        for (const staged of stagedChunks) db.addPendingChunk(pendingId, staged.index, staged.path, staged.size);
    } catch (error) {
        try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch { }
        db.close();
        throw new Error(`Could not persist resumable upload state: ${error.message}`);
    }

    onProgress?.('Connecting to Telegram...');
    const client = telegramPool || new TelegramPool(dataDir, config.bots);
    if (!telegramPool) await client.initialize({ includeDisabled: false });

    let uploadedBytes = 0;
    try {
        for (const staged of stagedChunks) {
            onProgress?.(`Uploading chunk ${staged.index + 1}/${totalChunks}...`);
            const botId = client.selectBotId(hash, staged.index);
            const result = await client.sendFile(
                staged.path,
                createChunkCaption(pendingId, staged.index, totalChunks),
                {
                    ...(limitRate ? { limitRate } : {}),
                    botId,
                    routingKey: hash,
                    chunkIndex: staged.index
                }
            );
            db.markChunkUploaded(
                pendingId,
                staged.index,
                String(result.messageId),
                result.fileId,
                result.botId
            );
            uploadedBytes += staged.size;
            onByteProgress?.({
                uploaded: uploadedBytes,
                total: stagedChunks.reduce((sum, chunk) => sum + chunk.size, 0),
                chunk: staged.index + 1,
                totalChunks
            });
            fs.unlinkSync(staged.path);
        }
    } catch (error) {
        db.close();
        throw new Error(`${error.message} (upload paused — run \`tas resume\` to continue)`);
    }

    const uploadedChunks = db.getPendingChunks(pendingId);
    let fileId;
    db.db.transaction(() => {
        fileId = db.addFile({ filename, hash, originalSize, storedSize: totalStoredSize, chunks: totalChunks, compressed });
        for (const chunk of uploadedChunks) {
            db.addChunk(
                fileId,
                chunk.chunk_index,
                chunk.message_id,
                chunk.size,
                chunk.file_telegram_id,
                chunk.bot_id || null
            );
        }
        if (existingFile) db.deleteFileCascade(existingFile.id);
        db.deletePendingUpload(pendingId);
    })();

    db.close();

    let manifestWarning = null;
    if (updateManifest) {
        onProgress?.('Publishing encrypted recovery manifest...');
        try {
            await backupRemoteManifest({ dataDir, password, config, telegramPool: client });
            for (const chunk of existingChunks) {
                try { await client.deleteMessage(chunk.message_id, chunk.bot_id || null); } catch { }
            }
        } catch (error) {
            manifestWarning = error.message;
        }
    }

    // Clean up this upload's private staging directory.
    try {
        fs.rmdirSync(uploadDir);
        if (fs.readdirSync(tempRoot).length === 0) fs.rmdirSync(tempRoot);
    } catch { }

    return {
        filename,
        hash,
        originalSize,
        storedSize: totalStoredSize,
        chunks: totalChunks,
        compressed,
        manifestWarning,
        supersededChunks: existingChunks
    };
}

/**
 * Retrieve a file from Telegram
 */
export async function retrieveFile(fileRecord, options) {
    const { password, dataDir, outputPath, config, onProgress, onByteProgress, telegramPool } = options;

    onProgress?.('Connecting to Telegram...');

    // Get chunk info
    const db = new FileIndex(path.join(dataDir, 'index.db'));
    db.init();

    const chunks = db.getChunks(fileRecord.id);
    db.close();

    if (chunks.length === 0) {
        throw new Error('No chunk metadata found for this file');
    }

    // Connect to Telegram
    const client = telegramPool || new TelegramPool(dataDir, config.bots);

    const encryptor = new Encryptor(password);
    const compressor = new Compressor();

    const { createDownloadPipeline } = await import('./utils/download-stream.js');

    const { readable } = await createDownloadPipeline({
        client,
        chunks,
        encryptor,
        compressor,
        onChunkDownloaded({ chunkIndex, totalChunks, bytesDownloaded, totalBytes }) {
            onProgress?.(`Downloading chunk ${chunkIndex + 1}/${totalChunks}...`);
            onByteProgress?.({ downloaded: bytesDownloaded, total: totalBytes, chunk: chunkIndex + 1, totalChunks });
        }
    });

    const writeStream = fs.createWriteStream(outputPath);

    onProgress?.('Decrypting, decompressing, and writing file...');

    await pipeline(readable, writeStream);

    const finalStats = fs.statSync(outputPath);

    // Verify file integrity by comparing hash
    onProgress?.('Verifying file integrity...');
    const downloadedHash = await hashFile(outputPath);
    if (fileRecord.hash && downloadedHash !== fileRecord.hash) {
        throw new Error(`Integrity check failed: expected hash ${fileRecord.hash.substring(0, 12)}..., got ${downloadedHash.substring(0, 12)}...`);
    }

    return {
        path: outputPath,
        size: finalStats.size,
        verified: true
    };
}
