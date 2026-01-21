/**
 * Compression utilities - gzip with smart bypass for already-compressed formats
 */

import zlib from 'zlib';
import { promisify } from 'util';
import path from 'path';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// File extensions that are already compressed (skip compression for these)
const SKIP_COMPRESSION = new Set([
    // Images
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif',
    // Video
    '.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v',
    // Audio
    '.mp3', '.aac', '.m4a', '.ogg', '.opus', '.flac', '.wma',
    // Archives
    '.zip', '.rar', '.7z', '.gz', '.bz2', '.xz', '.tar.gz', '.tgz',
    // Documents (already compressed internally)
    '.pdf', '.docx', '.xlsx', '.pptx', '.epub',
    // Other
    '.dmg', '.iso', '.apk', '.ipa'
]);

export class Compressor {
    /**
     * Check if a file should skip compression
     */
    shouldSkip(filename) {
        const ext = path.extname(filename).toLowerCase();
        return SKIP_COMPRESSION.has(ext);
    }

    /**
     * Compress data using gzip
     * Returns: { data: Buffer, compressed: boolean }
     */
    async compress(data, filename = '') {
        // Skip if already compressed format
        if (this.shouldSkip(filename)) {
            return {
                data: data,
                compressed: false
            };
        }

        try {
            const compressed = await gzip(data, { level: 6 });

            // Only use compression if it actually reduces size
            if (compressed.length < data.length) {
                return {
                    data: compressed,
                    compressed: true
                };
            }

            return {
                data: data,
                compressed: false
            };
        } catch (err) {
            // If compression fails, return original
            return {
                data: data,
                compressed: false
            };
        }
    }

    /**
     * Decompress gzip data
     */
    async decompress(data, wasCompressed) {
        if (!wasCompressed) {
            return data;
        }

        return await gunzip(data);
    }
}
