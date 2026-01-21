/**
 * Encryption module - AES-256-GCM with PBKDF2 key derivation
 */

import crypto from 'crypto';

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
