import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    HOSTED_BOT_API_DOWNLOAD_LIMIT,
    getChunkReadabilityError
} from '../src/utils/chunk-readability.js';

describe('Legacy chunk readability', () => {
    it('explains a file record that has no chunks', () => {
        assert.match(
            getChunkReadabilityError('broken.mp4', []),
            /no chunk metadata.*tas index repair/
        );
    });

    it('explains an incomplete chunk set before attempting a download', () => {
        assert.match(
            getChunkReadabilityError('partial.mp4', [{ size: 1 }], () => false, 2),
            /1 of 2 expected chunks/
        );
    });

    it('requires a custom endpoint for oversized legacy chunks', () => {
        const chunks = [{ size: HOSTED_BOT_API_DOWNLOAD_LIMIT + 1, bot_id: 'primary' }];
        assert.match(getChunkReadabilityError('legacy.mp4', chunks), /local Bot API server/);
        assert.equal(getChunkReadabilityError('legacy.mp4', chunks, () => true), null);
    });
});
