/**
 * Main processing module
 * Orchestrates the upload/download pipeline
 */

import fs from 'fs';
import path from 'path';
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

    // Read file
    const filename = customName || path.basename(filePath);
    const fileData = fs.readFileSync(filePath);
    const originalSize = fileData.length;

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

    // Compress
    onProgress?.('Compressing...');
    const compressor = new Compressor();
    const { data: compressedData, compressed } = await compressor.compress(fileData, filename);

    // Encrypt
    onProgress?.('Encrypting...');
    const encryptor = new Encryptor(password);
    const encryptedData = encryptor.encrypt(compressedData);

    // Chunk if needed (Telegram bot limit ~50MB per file)
    onProgress?.('Preparing chunks...');
    const chunks = [];
    const numChunks = Math.ceil(encryptedData.length / TELEGRAM_CHUNK_SIZE);

    for (let i = 0; i < numChunks; i++) {
        const start = i * TELEGRAM_CHUNK_SIZE;
        const end = Math.min(start + TELEGRAM_CHUNK_SIZE, encryptedData.length);
        chunks.push({
            index: i,
            total: numChunks,
            data: encryptedData.subarray(start, end)
        });
    }

    // Prepare files with headers
    const tempDir = path.join(dataDir, 'tmp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const chunkFiles = [];
    const flags = compressed ? 1 : 0;

    for (const chunk of chunks) {
        const header = createHeader(filename, originalSize, chunk.index, chunk.total, flags);
        const chunkData = Buffer.concat([header, chunk.data]);

        const chunkFilename = chunks.length > 1
            ? `${hash.substring(0, 12)}.part${chunk.index}.tas`
            : `${hash.substring(0, 12)}.tas`;

        const chunkPath = path.join(tempDir, chunkFilename);
        fs.writeFileSync(chunkPath, chunkData);

        chunkFiles.push({
            index: chunk.index,
            path: chunkPath,
            size: chunkData.length
        });
    }

    // Connect to Telegram
    onProgress?.('Connecting to Telegram...');
    const client = new TelegramClient(dataDir);
    await client.initialize(config.botToken);
    client.setChatId(config.chatId);

    // Upload chunks
    const fileId = db.addFile({
        filename,
        hash,
        originalSize,
        storedSize: encryptedData.length,
        chunks: chunks.length,
        compressed
    });

    let uploadedBytes = 0;
    const totalBytes = chunkFiles.reduce((acc, c) => acc + c.size, 0);

    for (const chunk of chunkFiles) {
        onProgress?.(`Uploading chunk ${chunk.index + 1}/${chunkFiles.length}...`);

        const caption = chunks.length > 1
            ? `📦 ${filename} (${chunk.index + 1}/${chunks.length})`
            : `📦 ${filename}`;

        const result = await client.sendFile(chunk.path, caption);

        uploadedBytes += chunk.size;
        onByteProgress?.({ uploaded: uploadedBytes, total: totalBytes, chunk: chunk.index + 1, totalChunks: chunkFiles.length });

        // Store file_id instead of message_id for downloads
        db.addChunk(fileId, chunk.index, result.messageId.toString(), chunk.size);

        // Also store file_id for easier retrieval
        db.db.prepare('UPDATE chunks SET file_telegram_id = ? WHERE file_id = ? AND chunk_index = ?')
            .run(result.fileId, fileId, chunk.index);

        // Clean up temp file
        fs.unlinkSync(chunk.path);
    }

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
        storedSize: encryptedData.length,
        chunks: chunks.length,
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

    // Connect to Telegram
    const client = new TelegramClient(dataDir);
    await client.initialize(config.botToken);
    client.setChatId(config.chatId);

    // Download all chunks
    const downloadedChunks = [];
    let downloadedBytes = 0;
    const totalBytes = fileRecord.stored_size || chunks.reduce((acc, c) => acc + (c.size || 0), 0);

    for (const chunk of chunks) {
        onProgress?.(`Downloading chunk ${chunk.chunk_index + 1}/${chunks.length}...`);

        const data = await client.downloadFile(chunk.file_telegram_id);
        downloadedBytes += data.length;
        onByteProgress?.({ downloaded: downloadedBytes, total: totalBytes, chunk: chunk.chunk_index + 1, totalChunks: chunks.length });

        // Parse header
        const header = parseHeader(data);
        const payload = data.subarray(HEADER_SIZE);

        downloadedChunks.push({
            index: header.chunkIndex,
            total: header.totalChunks,
            data: payload,
            compressed: header.compressed
        });
    }

    // Reassemble
    onProgress?.('Reassembling...');
    downloadedChunks.sort((a, b) => a.index - b.index);
    const encryptedData = Buffer.concat(downloadedChunks.map(c => c.data));

    // Decrypt
    onProgress?.('Decrypting...');
    const encryptor = new Encryptor(password);
    const compressedData = encryptor.decrypt(encryptedData);

    // Decompress
    onProgress?.('Decompressing...');
    const compressor = new Compressor();
    const wasCompressed = downloadedChunks[0].compressed;
    const originalData = await compressor.decompress(compressedData, wasCompressed);

    // Write to output
    onProgress?.('Writing file...');
    fs.writeFileSync(outputPath, originalData);

    return {
        path: outputPath,
        size: originalData.length
    };
}
