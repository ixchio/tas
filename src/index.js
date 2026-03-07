/**
 * Main processing module
 * Orchestrates the upload/download pipeline
 */

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Encryptor, hashFile } from './crypto/encryption.js';
import { Compressor } from './utils/compression.js';
import { Chunker, createHeader, parseHeader, HEADER_SIZE } from './utils/chunker.js';
import { TelegramClient } from './telegram/client.js';
import { FileIndex } from './db/index.js';

// Telegram has 50MB limit for bots, 2GB for user uploads
// We'll use 49MB chunks to be safe
const TELEGRAM_CHUNK_SIZE = 49 * 1024 * 1024;

/**
 * Process and upload a file to Telegram
 */
export async function processFile(filePath, options) {
    const { password, dataDir, customName, config, onProgress, onByteProgress } = options;

    onProgress?.('Reading file...');

    // Read file initially just to get size
    const filename = customName || path.basename(filePath);
    const stats = fs.statSync(filePath);
    const originalSize = stats.size;

    // Calculate hash
    onProgress?.('Calculating hash...');
    const hash = await hashFile(filePath);

    // Check if already uploaded
    const db = new FileIndex(path.join(dataDir, 'index.db'));
    db.init();

    if (db.exists(hash)) {
        db.close();
        throw new Error('File already uploaded (duplicate hash)');
    }

    // Prepare processing components
    const compressor = new Compressor();
    const { stream: compressStream, compressed } = compressor.getCompressStream(filename);
    const flags = compressed ? 1 : 0;

    const encryptor = new Encryptor(password);
    const encryptStream = encryptor.getEncryptStream();

    const tempDir = process.env.TAS_TMP_DIR || path.join(dataDir, 'tmp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // Connect to Telegram
    onProgress?.('Connecting to Telegram...');
    const client = new TelegramClient(dataDir);
    await client.initialize(config.botToken);
    client.setChatId(config.chatId);

    // We will stream through a custom Writable chunker
    const { Writable } = await import('stream');

    // First pass estimation (for calculating total chunks and progress)
    // We don't know the exact final size due to compression and encryption overhead,
    // so we'll estimate total chunks and update it if needed.
    // For small files < 49MB we assume 1 chunk.
    let estimatedSize = compressed ? originalSize : originalSize + 128; // Add encryption overhead
    if (compressed && originalSize > 1024 * 1024) estimatedSize = originalSize * 0.8; // Rough guess
    let estimatedChunks = Math.ceil(estimatedSize / TELEGRAM_CHUNK_SIZE) || 1;

    // Register file in DB
    const fileId = db.addFile({
        filename,
        hash,
        originalSize,
        storedSize: 0, // Will update later
        chunks: estimatedChunks,
        compressed
    });

    onProgress?.('Processing and uploading streams...');
    let uploadedBytes = 0;
    let chunkIndex = 0;

    let currentChunkBuffer = Buffer.alloc(0);
    let totalStoredSize = 0;

    // Helper to upload a single chunk
    const uploadCurrentChunk = async (isFinal = false) => {
        if (currentChunkBuffer.length === 0 && !isFinal) return; // Nothing to upload
        if (currentChunkBuffer.length === 0 && isFinal && chunkIndex > 0) return; // Empty final chunk after perfect split

        // At this point we know if it's the final chunk, so we know the total chunks
        const totalChunks = isFinal ? chunkIndex + 1 : Math.max(estimatedChunks, chunkIndex + 1);

        const header = createHeader(filename, originalSize, chunkIndex, totalChunks, flags);
        const chunkData = Buffer.concat([header, currentChunkBuffer]);

        const chunkFilename = totalChunks > 1
            ? `${hash.substring(0, 12)}.part${chunkIndex}.tas`
            : `${hash.substring(0, 12)}.tas`;

        const chunkPath = path.join(tempDir, chunkFilename);
        fs.writeFileSync(chunkPath, chunkData);

        const caption = totalChunks > 1
            ? `📦 ${filename} (${chunkIndex + 1}/${totalChunks})`
            : `📦 ${filename}`;

        onProgress?.(`Uploading chunk ${chunkIndex + 1}...`);

        const result = await client.sendFile(chunkPath, caption);

        uploadedBytes += chunkData.length;
        totalStoredSize += currentChunkBuffer.length;

        onByteProgress?.({ uploaded: uploadedBytes, total: estimatedSize, chunk: chunkIndex + 1, totalChunks });

        // Store file_id
        db.addChunk(fileId, chunkIndex, result.messageId.toString(), chunkData.length);
        db.db.prepare('UPDATE chunks SET file_telegram_id = ? WHERE file_id = ? AND chunk_index = ?')
            .run(result.fileId, fileId, chunkIndex);

        // Clean up temp file immediately to save disk space
        fs.unlinkSync(chunkPath);

        chunkIndex++;
        currentChunkBuffer = Buffer.alloc(0);
    };

    const chunkingStream = new Writable({
        async write(chunk, encoding, callback) {
            currentChunkBuffer = Buffer.concat([currentChunkBuffer, chunk]);

            // If we exceeded the chunk limit, flush it
            if (currentChunkBuffer.length >= TELEGRAM_CHUNK_SIZE) {
                const overflow = currentChunkBuffer.subarray(TELEGRAM_CHUNK_SIZE);
                currentChunkBuffer = currentChunkBuffer.subarray(0, TELEGRAM_CHUNK_SIZE);

                try {
                    await uploadCurrentChunk(false);
                    currentChunkBuffer = overflow; // carry over
                    callback();
                } catch (err) {
                    callback(err);
                }
            } else {
                callback();
            }
        },
        async final(callback) {
            try {
                await uploadCurrentChunk(true);
                callback();
            } catch (err) {
                callback(err);
            }
        }
    });

    const readStream = fs.createReadStream(filePath);

    // Run the pipeline: Read -> Compress -> Encrypt -> Chunk & Upload
    await pipeline(readStream, compressStream, encryptStream, chunkingStream);

    // Update the DB with the final accurate values 
    db.db.prepare('UPDATE files SET stored_size = ?, chunks = ? WHERE id = ?')
        .run(totalStoredSize, chunkIndex, fileId);

    db.close();

    // Clean up temp dir
    try {
        fs.rmdirSync(tempDir);
    } catch (e) {
        // Ignore if not empty
    }

    return {
        filename,
        hash,
        originalSize,
        storedSize: totalStoredSize,
        chunks: chunkIndex,
        compressed
    };
}

/**
 * Retrieve a file from Telegram
 */
export async function retrieveFile(fileRecord, options) {
    const { password, dataDir, outputPath, config, onProgress, onByteProgress } = options;

    onProgress?.('Connecting to Telegram...');

    // Get chunk info
    const db = new FileIndex(path.join(dataDir, 'index.db'));
    db.init();

    const chunks = db.getChunks(fileRecord.id);
    db.close();

    if (chunks.length === 0) {
        throw new Error('No chunk metadata found for this file');
    }

    // Prepare components
    const encryptor = new Encryptor(password);
    const decryptStream = encryptor.getDecryptStream();

    const tempDir = process.env.TAS_TMP_DIR || path.join(dataDir, 'tmp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // Connect to Telegram
    const client = new TelegramClient(dataDir);
    await client.initialize(config.botToken);
    client.setChatId(config.chatId);

    // Get total size from first chunk's header, or from DB
    const firstChunkData = await client.downloadFile(chunks[0].file_telegram_id);
    const header = parseHeader(firstChunkData);

    // Total original uncompressed size
    let expectedOriginalSize = header.originalSize;
    let wasCompressed = header.compressed;

    const compressor = new Compressor();
    const decompressStream = compressor.getDecompressStream(wasCompressed);

    // We need a Readable stream that will lazily fetch chunks from Telegram
    // and push them into the decryption pipeline.
    const { Readable } = await import('stream');

    const totalBytes = fileRecord.stored_size || chunks.reduce((acc, c) => acc + (c.size || 0), 0);
    let downloadedBytes = 0;

    // Pre-sort chunks by index so we download them in correct order
    chunks.sort((a, b) => a.chunk_index - b.chunk_index);

    let currentChunkIndex = 0;

    // We already downloaded the first chunk to inspect its header, we shouldn't discard it.
    let preloadedFirstChunk = firstChunkData;

    const downloadStream = new Readable({
        async read() {
            try {
                if (currentChunkIndex >= chunks.length) {
                    this.push(null); // End of stream
                    return;
                }

                const chunk = chunks[currentChunkIndex];
                onProgress?.(`Downloading chunk ${chunk.chunk_index + 1}/${chunks.length}...`);

                let data;
                if (currentChunkIndex === 0 && preloadedFirstChunk) {
                    data = preloadedFirstChunk;
                    preloadedFirstChunk = null;
                } else {
                    data = await client.downloadFile(chunk.file_telegram_id);
                }

                downloadedBytes += data.length;
                onByteProgress?.({ downloaded: downloadedBytes, total: totalBytes, chunk: chunk.chunk_index + 1, totalChunks: chunks.length });

                // Strip header before pushing
                const payload = data.subarray(HEADER_SIZE);
                this.push(payload);

                currentChunkIndex++;
            } catch (err) {
                this.destroy(err);
            }
        }
    });

    const writeStream = fs.createWriteStream(outputPath);
    const { pipeline } = await import('stream/promises');

    onProgress?.('Decrypting, decompressing, and writing file...');

    // Pipeline: Download from Telegram -> Decrypt -> Decompress -> Disk
    await pipeline(downloadStream, decryptStream, decompressStream, writeStream);

    const finalStats = fs.statSync(outputPath);

    return {
        path: outputPath,
        size: finalStats.size
    };
}
