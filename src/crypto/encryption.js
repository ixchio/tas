/**
 * Encryption module - AES-256-GCM with PBKDF2 key derivation
 */

import crypto from 'crypto';
import { Transform } from 'stream';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits auth tag
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

export class Encryptor {
    constructor(password) {
        this.password = password;
    }

    /**
     * Get a hash of the password for verification (not the actual key!)
     */
    getPasswordHash() {
        return crypto.createHash('sha256')
            .update(this.password + 'was-verify')
            .digest('hex');
    }

    /**
     * Derive encryption key from password using PBKDF2
     */
    deriveKey(salt) {
        return crypto.pbkdf2Sync(
            this.password,
            salt,
            PBKDF2_ITERATIONS,
            KEY_LENGTH,
            'sha512'
        );
    }

    /**
     * Encrypt data
     * Returns: Buffer containing [salt (32) | iv (12) | ciphertext | authTag (16)]
     */
    encrypt(data) {
        // Generate random salt and IV
        const salt = crypto.randomBytes(SALT_LENGTH);
        const iv = crypto.randomBytes(IV_LENGTH);

        // Derive key from password
        const key = this.deriveKey(salt);

        // Create cipher
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        // Encrypt
        const encrypted = Buffer.concat([
            cipher.update(data),
            cipher.final()
        ]);

        // Get auth tag
        const authTag = cipher.getAuthTag();

        // Combine: salt + iv + ciphertext + authTag
        return Buffer.concat([salt, iv, encrypted, authTag]);
    }

    /**
     * Get an encryption transform stream
     * Needs to append the salt/iv to the stream begin, and authTag to the stream end
     */
    getEncryptStream() {
        const salt = crypto.randomBytes(SALT_LENGTH);
        const iv = crypto.randomBytes(IV_LENGTH);
        const key = this.deriveKey(salt);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        let headerWritten = false;

        return new Transform({
            transform(chunk, encoding, callback) {
                if (!headerWritten) {
                    this.push(Buffer.concat([salt, iv]));
                    headerWritten = true;
                }
                const encrypted = cipher.update(chunk);
                if (encrypted.length > 0) {
                    this.push(encrypted);
                }
                callback();
            },
            flush(callback) {
                const final = cipher.final();
                if (final.length > 0) {
                    this.push(final);
                }
                this.push(cipher.getAuthTag());
                callback();
            }
        });
    }

    /**
     * Decrypt data
     * Input: Buffer containing [salt (32) | iv (12) | ciphertext | authTag (16)]
     */
    decrypt(encryptedData) {
        // Extract components
        const salt = encryptedData.subarray(0, SALT_LENGTH);
        const iv = encryptedData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
        const authTag = encryptedData.subarray(-TAG_LENGTH);
        const ciphertext = encryptedData.subarray(SALT_LENGTH + IV_LENGTH, -TAG_LENGTH);

        // Derive key from password
        const key = this.deriveKey(salt);

        // Create decipher
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        // Decrypt
        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);
    }

    /**
     * Get a decryption transform stream
     * Expects [salt (32) | iv (12) | ciphertext | authTag (16)]
     */
    getDecryptStream() {
        let salt = null;
        let iv = null;
        let authTag = null;
        let key = null;
        let decipher = null;

        // Buffer for storing the salt and iv during the first few chunks
        let headerBuffer = Buffer.alloc(0);
        let headerRead = false;

        // We must buffer the last 16 bytes across chunks because it's the authTag
        let tailBuffer = Buffer.alloc(0);

        const self = this;

        return new Transform({
            transform(chunk, encoding, callback) {
                try {
                    // 1. Read the header (salt + iv)
                    if (!headerRead) {
                        headerBuffer = Buffer.concat([headerBuffer, chunk]);

                        if (headerBuffer.length >= SALT_LENGTH + IV_LENGTH) {
                            salt = headerBuffer.subarray(0, SALT_LENGTH);
                            iv = headerBuffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
                            key = self.deriveKey(salt);
                            decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

                            // The rest of the header buffer is ciphertext
                            const remaining = headerBuffer.subarray(SALT_LENGTH + IV_LENGTH);
                            headerBuffer = null; // free memory
                            headerRead = true;

                            // Push remaining into tailBuffer for processing
                            if (remaining.length > 0) {
                                tailBuffer = Buffer.concat([tailBuffer, remaining]);
                            }
                        }
                    } else {
                        tailBuffer = Buffer.concat([tailBuffer, chunk]);
                    }

                    // 2. Process ciphertext, keeping exactly TAG_LENGTH bytes in tailBuffer
                    if (headerRead && tailBuffer.length > TAG_LENGTH) {
                        const processLength = tailBuffer.length - TAG_LENGTH;
                        const toProcess = tailBuffer.subarray(0, processLength);

                        const decrypted = decipher.update(toProcess);
                        if (decrypted.length > 0) {
                            this.push(decrypted);
                        }

                        // Keep only the end
                        tailBuffer = tailBuffer.subarray(processLength);
                    }

                    callback();
                } catch (err) {
                    callback(err);
                }
            },
            flush(callback) {
                try {
                    if (!headerRead) {
                        return callback(new Error('Invalid encrypted data stream: too short'));
                    }

                    if (tailBuffer.length !== TAG_LENGTH) {
                        return callback(new Error(`Invalid encrypted data stream: missing auth tag. Got ${tailBuffer.length} bytes, expected ${TAG_LENGTH}`));
                    }

                    authTag = tailBuffer;
                    decipher.setAuthTag(authTag);

                    const final = decipher.final();
                    if (final.length > 0) {
                        this.push(final);
                    }

                    callback();
                } catch (err) {
                    callback(new Error(`Decryption failed: wrong password or corrupt data (${err.message})`));
                }
            }
        });
    }
}

/**
 * Generate SHA-256 hash of data
 */
export function hashData(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generate SHA-256 hash of a file (streaming)
 */
export async function hashFile(filePath) {
    const { createReadStream } = await import('fs');

    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = createReadStream(filePath);

        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
