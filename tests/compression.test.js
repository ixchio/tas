/**
 * Compression tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Compressor } from '../src/utils/compression.js';

describe('Compressor', () => {
    test('compresses and decompresses text correctly', async () => {
        const compressor = new Compressor();

        const original = Buffer.from('Hello, World! This is some text that should compress well. '.repeat(100));
        const { data: compressed, compressed: wasCompressed } = await compressor.compress(original);

        assert.ok(wasCompressed, 'Text should be compressed');
        assert.ok(compressed.length < original.length, 'Compressed size should be smaller');

        const decompressed = await compressor.decompress(compressed, wasCompressed);
        assert.deepStrictEqual(decompressed, original);
    });

    test('skips compression for already compressed formats', async () => {
        const compressor = new Compressor();

        assert.ok(compressor.shouldSkip('image.jpg'));
        assert.ok(compressor.shouldSkip('video.mp4'));
        assert.ok(compressor.shouldSkip('archive.zip'));
        assert.ok(compressor.shouldSkip('audio.mp3'));

        assert.ok(!compressor.shouldSkip('document.txt'));
        assert.ok(!compressor.shouldSkip('code.js'));
        assert.ok(!compressor.shouldSkip('data.json'));
    });

    test('returns original data for non-compressible random data', async () => {
        const compressor = new Compressor();

        // Random data doesn't compress well
        const original = Buffer.alloc(1000);
        for (let i = 0; i < original.length; i++) {
            original[i] = Math.floor(Math.random() * 256);
        }

        const { data, compressed } = await compressor.compress(original, 'random.bin');

        // If compression made it bigger, should return original
        if (!compressed) {
            assert.deepStrictEqual(data, original);
        }
    });

    test('handles empty data', async () => {
        const compressor = new Compressor();

        const original = Buffer.from('');
        const { data, compressed } = await compressor.compress(original);
        const decompressed = await compressor.decompress(data, compressed);

        assert.deepStrictEqual(decompressed, original);
    });
});
