import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TelegramClient } from '../src/telegram/client.js';
import { TelegramPool } from '../src/telegram/pool.js';

function startLocalBotApi() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        if (req.url === '/bot123:test/getMe') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'TAS', username: 'tas_local_bot' } }));
            return;
        }
        if (req.url === '/bot123:test/getFile') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, result: { file_id: 'legacy-file', file_path: 'legacy.bin' } }));
            return;
        }
        if (req.url === '/file/bot123:test/legacy.bin') {
            res.end('legacy payload');
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    }));
}

describe('Custom Bot API endpoint', () => {
    let server;

    afterEach(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        server = null;
    });

    it('uses the configured endpoint for bot verification and file reads', async () => {
        const local = await startLocalBotApi();
        server = local.server;
        const client = new TelegramClient('/tmp');

        const bot = await client.initialize('123:test', local.url);
        const payload = await client.downloadFile('legacy-file');

        assert.equal(bot.username, 'tas_local_bot');
        assert.equal(payload.toString(), 'legacy payload');
        assert.deepEqual(local.requests, [
            '/bot123:test/getMe',
            '/bot123:test/getFile',
            '/file/bot123:test/legacy.bin'
        ]);
    });

    it('marks only configured bot owners as able to read oversized chunks', () => {
        const pool = new TelegramPool('/tmp', [
            { id: 'primary', botToken: '1:primary', chatId: 1, customApiUrl: 'http://127.0.0.1:8081' },
            { id: 'archive', botToken: '2:archive', chatId: 2 }
        ]);

        assert.equal(pool.usesCustomApi('primary'), true);
        assert.equal(pool.usesCustomApi('archive'), false);
    });
});
