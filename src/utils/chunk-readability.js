export const HOSTED_BOT_API_DOWNLOAD_LIMIT = 20 * 1000 * 1000;

/**
 * Return a human-readable reason a file cannot be read through its current
 * Bot API endpoints. A local Bot API server can retrieve oversized legacy
 * chunks, whereas the hosted endpoint cannot.
 */
export function getChunkReadabilityError(filename, chunks, usesCustomApi = () => false, expectedChunks = null) {
    if (!Array.isArray(chunks) || chunks.length === 0) {
        return `"${filename}" has no chunk metadata. Run \`tas index repair\` to inspect the incomplete record.`;
    }

    if (Number.isInteger(expectedChunks) && expectedChunks > 0 && chunks.length !== expectedChunks) {
        return `"${filename}" has ${chunks.length} of ${expectedChunks} expected chunks. ` +
            'Run `tas index repair` to inspect the incomplete record.';
    }

    const blocked = chunks.filter(chunk =>
        Number(chunk.size) > HOSTED_BOT_API_DOWNLOAD_LIMIT && !usesCustomApi(chunk.bot_id || null)
    );

    if (blocked.length === 0) return null;

    return `"${filename}" has ${blocked.length} legacy chunk(s) above Telegram's hosted 20 MB download limit. ` +
        'Run a local Bot API server and configure its endpoint with `tas bot endpoint <url>`.';
}
