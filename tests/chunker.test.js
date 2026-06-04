/**
 * WAS1 header and chunking tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createHeader, parseHeader, HEADER_SIZE } from '../src/utils/chunker.js';

describe('WAS1 Header', () => {
    test('HEADER_SIZE is 64 bytes', () => {
        assert.strictEqual(HEADER_SIZE, 64);
    });

    test('createHeader produces a 64-byte buffer', () => {
        const header = createHeader('test.txt', 1024, 0, 1, 0);
        assert.strictEqual(header.length, 64);
    });

    test('roundtrip: create then parse preserves all fields', () => {
        const header = createHeader('report.pdf', 98765, 2, 5, 1);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.version, 1);
        assert.strictEqual(parsed.flags, 1);
        assert.strictEqual(parsed.compressed, true);
        assert.strictEqual(parsed.originalSize, 98765);
        assert.strictEqual(parsed.chunkIndex, 2);
        assert.strictEqual(parsed.totalChunks, 5);
        assert.strictEqual(parsed.filename, 'report.pdf');
    });

    test('uncompressed flag parsed correctly', () => {
        const header = createHeader('data.bin', 100, 0, 1, 0);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.flags, 0);
        assert.strictEqual(parsed.compressed, false);
    });

    test('single chunk (index 0, total 1)', () => {
        const header = createHeader('small.txt', 42, 0, 1, 0);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.chunkIndex, 0);
        assert.strictEqual(parsed.totalChunks, 1);
    });

    test('large file size (> 4 GB, BigInt territory)', () => {
        const size = 5 * 1024 * 1024 * 1024; // 5 GB
        const header = createHeader('huge.iso', size, 0, 105, 0);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.originalSize, size);
    });

    test('max uint16 chunk values', () => {
        const header = createHeader('many-parts.bin', 1000, 65535, 65535, 0);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.chunkIndex, 65535);
        assert.strictEqual(parsed.totalChunks, 65535);
    });

    test('empty filename', () => {
        const header = createHeader('', 100, 0, 1, 0);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.filename, '');
    });

    test('ASCII filename at exactly 42 bytes', () => {
        const name = 'a'.repeat(42); // 42 ASCII chars = 42 bytes
        const header = createHeader(name, 100, 0, 1, 0);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.filename, name);
    });

    test('long ASCII filename truncated to 42 bytes', () => {
        const name = 'x'.repeat(100);
        const header = createHeader(name, 100, 0, 1, 0);
        const parsed = parseHeader(header);

        assert.strictEqual(parsed.filename.length, 42);
        assert.strictEqual(parsed.filename, 'x'.repeat(42));
    });

    test('Unicode (CJK) filename truncated safely', () => {
        // Each CJK character is 3 bytes in UTF-8. 42 / 3 = 14 chars max.
        const name = '日本語テストファイル名前確認用の長いファイル'; // 20 CJK chars = 60 bytes
        const header = createHeader(name, 100, 0, 1, 0);
        const parsed = parseHeader(header);

        const parsedBytes = Buffer.from(parsed.filename, 'utf-8').length;
        assert.ok(parsedBytes <= 42, `Filename bytes ${parsedBytes} exceeds 42`);
        // Must be a valid prefix of the original (no partial UTF-8 sequences)
        assert.ok(name.startsWith(parsed.filename), 'Truncated filename is not a prefix of original');
    });

    test('emoji filename truncated safely', () => {
        // Emojis are 4 bytes each in UTF-8
        const name = '🔥🚀📦💾🎉🔐⚡🌟✨💡🎯🔑'.repeat(2); // 24 emojis × 4 bytes = 96 bytes
        const header = createHeader(name, 100, 0, 1, 0);
        const parsed = parseHeader(header);

        const parsedBytes = Buffer.from(parsed.filename, 'utf-8').length;
        assert.ok(parsedBytes <= 42, `Filename bytes ${parsedBytes} exceeds 42`);
        // Verify no partial code points
        assert.ok(Buffer.from(parsed.filename, 'utf-8').toString('utf-8') === parsed.filename,
            'Filename contains invalid UTF-8 (partial code point)');
    });

    test('filename with mixed ASCII and Unicode', () => {
        const name = 'report_日本語_2025.pdf';
        const header = createHeader(name, 5000, 0, 1, 1);
        const parsed = parseHeader(header);

        // This name is 30 bytes (9 ASCII + 9 bytes CJK + 12 ASCII), fits in 42
        assert.strictEqual(parsed.filename, name);
    });

    test('magic bytes are WAS1', () => {
        const header = createHeader('test.txt', 100, 0, 1, 0);
        assert.strictEqual(header.subarray(0, 4).toString(), 'WAS1');
    });

    test('invalid magic bytes throw error', () => {
        const badBuffer = Buffer.alloc(64);
        badBuffer.write('BAD!', 0);

        assert.throws(
            () => parseHeader(badBuffer),
            (err) => err.message.includes('bad magic bytes')
        );
    });

    test('header can be prepended to payload and parsed back', () => {
        const header = createHeader('payload.bin', 256, 0, 1, 0);
        const payload = Buffer.alloc(256, 0x42);
        const combined = Buffer.concat([header, payload]);

        // Parse header from the combined buffer
        const parsed = parseHeader(combined.subarray(0, HEADER_SIZE));
        assert.strictEqual(parsed.filename, 'payload.bin');
        assert.strictEqual(parsed.originalSize, 256);

        // Payload after HEADER_SIZE should be intact
        const extractedPayload = combined.subarray(HEADER_SIZE);
        assert.deepStrictEqual(extractedPayload, payload);
    });

    test('zero original size', () => {
        const header = createHeader('empty.txt', 0, 0, 1, 0);
        const parsed = parseHeader(header);
        assert.strictEqual(parsed.originalSize, 0);
    });

    test('multiple flags bits preserved', () => {
        // Flags is uint16 — test with a value beyond just bit 0
        const header = createHeader('test.bin', 100, 0, 1, 3); // bits 0 and 1 set
        const parsed = parseHeader(header);
        assert.strictEqual(parsed.flags, 3);
        assert.strictEqual(parsed.compressed, true); // bit 0 is set
    });
});
