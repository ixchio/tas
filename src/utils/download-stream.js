/**
 * Shared download pipeline — Telegram → Decrypt → Decompress
 *
 * Eliminates the triplicated download-stream pattern across
 * index.js, share/server.js, and fuse/mount.js.
 */

import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { parseHeader, HEADER_SIZE } from './chunker.js';

/**
 * Create the download pipeline streams for a file stored in Telegram.
 *
 * @param {object} options
 * @param {object} options.client     – TelegramClient instance (initialized, with chatId set)
 * @param {Array}  options.chunks     – Chunk records from DB, each with { chunk_index, file_telegram_id, size }
 * @param {object} options.encryptor  – Encryptor instance
 * @param {object} options.compressor – Compressor instance
 * @param {function} [options.onChunkDownloaded] – Optional callback({ chunkIndex, totalChunks, bytesDownloaded, totalBytes })
 * @returns {Promise<{ readable: Readable, header: object }>}
 *   readable: a stream of decrypted (and decompressed) file content
 *   header: parsed WAS1 header from the first chunk
 */
export async function createDownloadPipeline({ client, chunks, encryptor, compressor, onChunkDownloaded }) {
    if (chunks.length === 0) throw new Error('No chunks found');

    // Sort by chunk_index
    const sortedChunks = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);

    // Download the first chunk to inspect the header
    const firstChunkData = await client.downloadFile(sortedChunks[0].file_telegram_id);
    const header = parseHeader(firstChunkData);

    const decryptStream = encryptor.getDecryptStream();
    const decompressStream = compressor.getDecompressStream(header.compressed);

    const totalBytes = sortedChunks.reduce((acc, c) => acc + (c.size || 0), 0);
    let bytesDownloaded = 0;
    let currentIndex = 0;
    let preloadedFirst = firstChunkData;

    const telegramStream = new Readable({
        async read() {
            try {
                if (currentIndex >= sortedChunks.length) {
                    this.push(null);
                    return;
                }

                let data;
                if (currentIndex === 0 && preloadedFirst) {
                    data = preloadedFirst;
                    preloadedFirst = null;
                } else {
                    data = await client.downloadFile(sortedChunks[currentIndex].file_telegram_id);
                }

                bytesDownloaded += data.length;
                onChunkDownloaded?.({
                    chunkIndex: currentIndex,
                    totalChunks: sortedChunks.length,
                    bytesDownloaded,
                    totalBytes
                });

                // Strip the WAS1 header before pushing into the decrypt pipeline
                this.push(data.subarray(HEADER_SIZE));
                currentIndex++;
            } catch (err) {
                this.destroy(err);
            }
        }
    });

    // Wire the internal pipeline: telegram → decrypt → decompress
    // We use a PassThrough as the readable end so callers can pipe/pipeline it freely.
    const { PassThrough } = await import('stream');
    const output = new PassThrough();

    // Run the internal pipeline in the background; errors propagate through the output stream.
    pipeline(telegramStream, decryptStream, decompressStream, output).catch((err) => {
        if (!output.destroyed) output.destroy(err);
    });

    return { readable: output, header };
}
