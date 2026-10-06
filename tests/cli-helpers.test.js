import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPrivatePasswordFile } from '../src/utils/cli-helpers.js';

describe('Private password files', () => {
    it('reads one password line and removes the final newline', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-password-'));
        try {
            const passwordFile = path.join(directory, 'password');
            fs.writeFileSync(passwordFile, 'correct horse battery staple\n', { mode: 0o600 });
            assert.equal(readPrivatePasswordFile(passwordFile), 'correct horse battery staple');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('rejects password files readable by other users on POSIX', { skip: process.platform === 'win32' }, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-password-'));
        try {
            const passwordFile = path.join(directory, 'password');
            fs.writeFileSync(passwordFile, 'unsafe\n', { mode: 0o644 });
            assert.throws(() => readPrivatePasswordFile(passwordFile), /chmod 600/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('rejects multi-line password files', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-password-'));
        try {
            const passwordFile = path.join(directory, 'password');
            fs.writeFileSync(passwordFile, 'first\nsecond\n', { mode: 0o600 });
            assert.throws(() => readPrivatePasswordFile(passwordFile), /exactly one line/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
