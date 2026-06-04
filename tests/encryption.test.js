/**
 * Encryption tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Readable, PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import { Encryptor, hashData } from '../src/crypto/encryption.js';

/**
 * Collect all data from a readable stream into a single Buffer.
 */
function collectStream(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

/**
 * Push a Buffer through a Transform stream and collect the result.
 */
async function pipeBuffer(data, transform) {
    const input = new PassThrough();
    const resultPromise = collectStream(transform);
    input.pipe(transform);
    input.end(data);
    return resultPromise;
}

describe('Encryptor', () => {
    test('encrypts and decrypts data correctly', () => {
        const password = 'test-password-123';
        const encryptor = new Encryptor(password);

        const original = Buffer.from('Hello, Telegram Storage!');
        const encrypted = encryptor.encrypt(original);
        const decrypted = encryptor.decrypt(encrypted);

        assert.deepStrictEqual(decrypted, original);
    });

    test('produces different ciphertext for same plaintext (random IV)', () => {
        const password = 'test-password-123';
        const encryptor = new Encryptor(password);

        const original = Buffer.from('Same message');
        const encrypted1 = encryptor.encrypt(original);
        const encrypted2 = encryptor.encrypt(original);

        // Should be different due to random IV and salt
        assert.notDeepStrictEqual(encrypted1, encrypted2);
    });

    test('fails with wrong password', () => {
        const encryptor1 = new Encryptor('correct-password');
        const encryptor2 = new Encryptor('wrong-password');

        const original = Buffer.from('Secret data');
        const encrypted = encryptor1.encrypt(original);

        assert.throws(() => {
            encryptor2.decrypt(encrypted);
        });
    });

    test('handles empty data', () => {
        const encryptor = new Encryptor('test-password');

        const original = Buffer.from('');
        const encrypted = encryptor.encrypt(original);
        const decrypted = encryptor.decrypt(encrypted);

        assert.deepStrictEqual(decrypted, original);
    });

    test('handles large data', () => {
        const encryptor = new Encryptor('test-password');

        // 1MB of random data
        const original = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < original.length; i++) {
            original[i] = Math.floor(Math.random() * 256);
        }

        const encrypted = encryptor.encrypt(original);
        const decrypted = encryptor.decrypt(encrypted);

        assert.deepStrictEqual(decrypted, original);
    });

    test('password hash is consistent', () => {
        const password = 'my-secure-password';
        const encryptor1 = new Encryptor(password);
        const encryptor2 = new Encryptor(password);

        assert.strictEqual(encryptor1.getPasswordHash(), encryptor2.getPasswordHash());
    });

    test('different passwords have different hashes', () => {
        const encryptor1 = new Encryptor('password1');
        const encryptor2 = new Encryptor('password2');

        assert.notStrictEqual(encryptor1.getPasswordHash(), encryptor2.getPasswordHash());
    });
});

describe('Streaming encryption', () => {
    test('stream encrypt → stream decrypt roundtrip', async () => {
        const encryptor = new Encryptor('stream-test-password');
        const original = Buffer.from('Hello, streaming encryption!');

        const encrypted = await pipeBuffer(original, encryptor.getEncryptStream());
        const decrypted = await pipeBuffer(encrypted, encryptor.getDecryptStream());

        assert.deepStrictEqual(decrypted, original);
    });

    test('handles empty data', async () => {
        const encryptor = new Encryptor('stream-test-password');
        const original = Buffer.alloc(0);

        const encrypted = await pipeBuffer(original, encryptor.getEncryptStream());
        const decrypted = await pipeBuffer(encrypted, encryptor.getDecryptStream());

        assert.deepStrictEqual(decrypted, original);
    });

    test('handles large data (1 MB)', async () => {
        const encryptor = new Encryptor('stream-test-password');
        const original = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < original.length; i++) {
            original[i] = i & 0xff;
        }

        const encrypted = await pipeBuffer(original, encryptor.getEncryptStream());
        const decrypted = await pipeBuffer(encrypted, encryptor.getDecryptStream());

        assert.deepStrictEqual(decrypted, original);
    });

    test('handles multi-chunk streaming with small pushes', async () => {
        const encryptor = new Encryptor('stream-test-password');
        const original = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(100));

        // Push data in tiny 7-byte chunks to stress the stream buffering logic
        const encryptStream = encryptor.getEncryptStream();
        const encryptedPromise = collectStream(encryptStream);

        for (let i = 0; i < original.length; i += 7) {
            encryptStream.write(original.subarray(i, Math.min(i + 7, original.length)));
        }
        encryptStream.end();
        const encrypted = await encryptedPromise;

        // Decrypt with similarly small pushes
        const decryptStream = encryptor.getDecryptStream();
        const decryptedPromise = collectStream(decryptStream);

        for (let i = 0; i < encrypted.length; i += 13) {
            decryptStream.write(encrypted.subarray(i, Math.min(i + 13, encrypted.length)));
        }
        decryptStream.end();
        const decrypted = await decryptedPromise;

        assert.deepStrictEqual(decrypted, original);
    });

    test('wrong password fails on stream decrypt', async () => {
        const enc = new Encryptor('correct-password');
        const dec = new Encryptor('wrong-password');

        const original = Buffer.from('Sensitive data');
        const encrypted = await pipeBuffer(original, enc.getEncryptStream());

        await assert.rejects(
            () => pipeBuffer(encrypted, dec.getDecryptStream()),
            (err) => {
                assert.ok(err.message.includes('Decryption failed'), `Unexpected error: ${err.message}`);
                return true;
            }
        );
    });

    test('different streams produce different ciphertext (random IV/salt)', async () => {
        const encryptor = new Encryptor('stream-test-password');
        const original = Buffer.from('Same data for both streams');

        const encrypted1 = await pipeBuffer(original, encryptor.getEncryptStream());
        const encrypted2 = await pipeBuffer(original, encryptor.getEncryptStream());

        assert.notDeepStrictEqual(encrypted1, encrypted2);
    });

    test('stream encrypt output is buffer-decrypt compatible', async () => {
        const encryptor = new Encryptor('compat-test-password');
        const original = Buffer.from('Cross-API compatibility test');

        const encrypted = await pipeBuffer(original, encryptor.getEncryptStream());
        const decrypted = encryptor.decrypt(encrypted);

        assert.deepStrictEqual(decrypted, original);
    });

    test('buffer encrypt output is stream-decrypt compatible', async () => {
        const encryptor = new Encryptor('compat-test-password');
        const original = Buffer.from('Cross-API compatibility test (reverse)');

        const encrypted = encryptor.encrypt(original);
        const decrypted = await pipeBuffer(encrypted, encryptor.getDecryptStream());

        assert.deepStrictEqual(decrypted, original);
    });

    test('truncated ciphertext fails on stream decrypt', async () => {
        const encryptor = new Encryptor('truncation-test');
        const original = Buffer.from('Data that will be truncated');

        const encrypted = await pipeBuffer(original, encryptor.getEncryptStream());
        // Chop off the last 10 bytes (corrupts auth tag)
        const truncated = encrypted.subarray(0, encrypted.length - 10);

        await assert.rejects(
            () => pipeBuffer(truncated, encryptor.getDecryptStream()),
            (err) => {
                assert.ok(err.message.length > 0);
                return true;
            }
        );
    });

    test('too-short data fails on stream decrypt', async () => {
        const encryptor = new Encryptor('short-data-test');
        // Only 20 bytes — shorter than header (salt 32 + iv 12 = 44 bytes minimum)
        const tooShort = Buffer.alloc(20, 0xAB);

        await assert.rejects(
            () => pipeBuffer(tooShort, encryptor.getDecryptStream()),
            (err) => {
                assert.ok(err.message.includes('too short') || err.message.includes('Decryption failed'),
                    `Unexpected error: ${err.message}`);
                return true;
            }
        );
    });
});

describe('hashData', () => {
    test('produces consistent hash', () => {
        const data = Buffer.from('test data');
        const hash1 = hashData(data);
        const hash2 = hashData(data);

        assert.strictEqual(hash1, hash2);
    });

    test('produces different hash for different data', () => {
        const hash1 = hashData(Buffer.from('data1'));
        const hash2 = hashData(Buffer.from('data2'));

        assert.notStrictEqual(hash1, hash2);
    });
});
