/**
 * File chunking utilities for large files
 * WhatsApp document limit is ~2GB, we use 1.9GB chunks to be safe
 */

const MAX_CHUNK_SIZE = 1.9 * 1024 * 1024 * 1024; // 1.9 GB

export class Chunker {
    /**
     * Split data into chunks if needed
     * Returns array of { index, total, data }
     */
    chunk(data) {
        const totalSize = data.length;

        // If small enough, return as single chunk
        if (totalSize <= MAX_CHUNK_SIZE) {
            return [{
                index: 0,
                total: 1,
                data: data
            }];
        }

        // Split into chunks
        const chunks = [];
        const numChunks = Math.ceil(totalSize / MAX_CHUNK_SIZE);

        for (let i = 0; i < numChunks; i++) {
            const start = i * MAX_CHUNK_SIZE;
            const end = Math.min(start + MAX_CHUNK_SIZE, totalSize);

            chunks.push({
                index: i,
                total: numChunks,
                data: data.subarray(start, end)
            });
        }

        return chunks;
    }

    /**
     * Reassemble chunks into original data
     * Chunks must be in order
     */
    reassemble(chunks) {
        // Sort by index just in case
        chunks.sort((a, b) => a.index - b.index);

        // Verify we have all chunks
        const total = chunks[0].total;
        if (chunks.length !== total) {
            throw new Error(`Missing chunks: have ${chunks.length}, need ${total}`);
        }

        // Concatenate
        return Buffer.concat(chunks.map(c => c.data));
    }
}

/**
 * Create WAS file header
 */
export function createHeader(filename, originalSize, chunkIndex, totalChunks, flags) {
    const header = Buffer.alloc(64);
    let offset = 0;

    // Magic bytes "WAS1"
    header.write('WAS1', offset);
    offset += 4;

    // Version (1)
    header.writeUInt16LE(1, offset);
    offset += 2;

    // Flags (bit 0: compressed)
    header.writeUInt16LE(flags, offset);
    offset += 2;

    // Original size (8 bytes for large files)
    header.writeBigUInt64LE(BigInt(originalSize), offset);
    offset += 8;

    // Chunk index
    header.writeUInt16LE(chunkIndex, offset);
    offset += 2;

    // Total chunks
    header.writeUInt16LE(totalChunks, offset);
    offset += 2;

    // Filename length
    const filenameBytes = Buffer.from(filename, 'utf-8').subarray(0, 42);
    header.writeUInt16LE(filenameBytes.length, offset);
    offset += 2;

    // Filename (max 42 bytes)
    filenameBytes.copy(header, offset);

    return header;
}

/**
 * Parse WAS file header
 */
export function parseHeader(buffer) {
    let offset = 0;

    // Check magic bytes
    const magic = buffer.subarray(0, 4).toString();
    if (magic !== 'WAS1') {
        throw new Error('Invalid WAS file: bad magic bytes');
    }
    offset += 4;

    // Version
    const version = buffer.readUInt16LE(offset);
    offset += 2;

    // Flags
    const flags = buffer.readUInt16LE(offset);
    offset += 2;

    // Original size
    const originalSize = Number(buffer.readBigUInt64LE(offset));
    offset += 8;

    // Chunk index
    const chunkIndex = buffer.readUInt16LE(offset);
    offset += 2;

    // Total chunks
    const totalChunks = buffer.readUInt16LE(offset);
    offset += 2;

    // Filename length
    const filenameLength = buffer.readUInt16LE(offset);
    offset += 2;

    // Filename
    const filename = buffer.subarray(offset, offset + filenameLength).toString('utf-8');

    return {
        version,
        flags,
        compressed: (flags & 1) === 1,
        originalSize,
        chunkIndex,
        totalChunks,
        filename
    };
}

export const HEADER_SIZE = 64;
