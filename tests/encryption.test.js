/**
 * Encryption tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Encryptor, hashData } from '../src/crypto/encryption.js';

describe('Encryptor', () => {
    test('encrypts and decrypts data correctly', () => {
        const password = 'test-password-123';
        const encryptor = new Encryptor(password);

        const original = Buffer.from('Hello, WhatsApp Storage!');
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
