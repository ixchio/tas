import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findMacFuseInstallation, MACFUSE_BUNDLE } = require('../src/fuse/macfuse.cjs');

test('macFUSE detection', async (t) => {
    await t.test('accepts a current macFUSE bundle with system library and headers', () => {
        const present = new Set([
            MACFUSE_BUNDLE,
            '/opt/homebrew/lib/libfuse.dylib',
            '/opt/homebrew/include/osxfuse/fuse.h'
        ]);
        const result = findMacFuseInstallation({ exists: candidate => present.has(candidate) });

        assert.deepEqual(result, {
            ready: true,
            bundle: MACFUSE_BUNDLE,
            library: '/opt/homebrew/lib/libfuse.dylib',
            include: '/opt/homebrew/include/osxfuse'
        });
    });

    await t.test('rejects a missing macFUSE bundle instead of accepting legacy OSXFUSE state', () => {
        const result = findMacFuseInstallation({ exists: () => false });
        assert.equal(result.ready, false);
        assert.match(result.reason, /macFUSE is not installed/);
    });

    await t.test('requires headers as well as a mounted framework', () => {
        const present = new Set([MACFUSE_BUNDLE, '/usr/local/lib/libfuse.dylib']);
        const result = findMacFuseInstallation({ exists: candidate => present.has(candidate) });
        assert.equal(result.ready, false);
        assert.match(result.reason, /development headers/);
    });
});
