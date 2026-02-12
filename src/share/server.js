/**
 * Share Server — Temporary file sharing via HTTP
 * Spins up a lightweight server that serves one-time download links
 * for files stored in Telegram. Files are decrypted on-the-fly.
 */

import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { FileIndex } from '../db/index.js';
import { TelegramClient } from '../telegram/client.js';
import { Encryptor } from '../crypto/encryption.js';
import { Compressor } from '../utils/compression.js';
import { parseHeader, HEADER_SIZE } from '../utils/chunker.js';

/**
 * Generate a secure random share token
 */
export function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Parse duration string to milliseconds
 * Supports: 1h, 24h, 7d, 30m, etc.
 */
export function parseDuration(str) {
    const match = str.match(/^(\d+)(m|h|d)$/);
    if (!match) throw new Error(`Invalid duration: ${str}. Use format like 1h, 24h, 7d, 30m`);

    const value = parseInt(match[1]);
    const unit = match[2];

    const multipliers = {
        'm': 60 * 1000,
        'h': 60 * 60 * 1000,
        'd': 24 * 60 * 60 * 1000
    };

    return value * multipliers[unit];
}

/**
 * Format remaining time human-readable
 */
function formatTimeLeft(expiresAt) {
    const now = Date.now();
    const diff = new Date(expiresAt).getTime() - now;

    if (diff <= 0) return 'expired';

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

/**
 * Generate the download HTML page
 */
function generateDownloadPage(share, fileRecord) {
    const timeLeft = formatTimeLeft(share.expires_at);
    const downloadsLeft = share.max_downloads - share.download_count;
    const fileSize = fileRecord.original_size;
    const sizeStr = fileSize > 1048576
        ? `${(fileSize / 1048576).toFixed(1)} MB`
        : fileSize > 1024
            ? `${(fileSize / 1024).toFixed(1)} KB`
            : `${fileSize} B`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TAS — Secure File Download</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .card {
            background: #1a1a2e;
            border: 1px solid #2a2a4a;
            border-radius: 16px;
            padding: 40px;
            max-width: 420px;
            width: 90%;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h1 { font-size: 20px; margin-bottom: 8px; color: #fff; }
        .filename {
            font-family: 'SF Mono', Monaco, monospace;
            background: #0f0f23;
            padding: 8px 16px;
            border-radius: 8px;
            margin: 16px 0;
            font-size: 14px;
            color: #7c83ff;
            word-break: break-all;
        }
        .meta {
            display: flex;
            justify-content: center;
            gap: 24px;
            margin: 16px 0;
            font-size: 13px;
            color: #888;
        }
        .meta span { display: flex; align-items: center; gap: 4px; }
        .btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: #fff;
            text-decoration: none;
            padding: 14px 40px;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            margin-top: 20px;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(102, 126, 234, 0.3);
        }
        .footer {
            margin-top: 24px;
            font-size: 11px;
            color: #555;
        }
        .footer a { color: #667eea; text-decoration: none; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">🔐</div>
        <h1>Secure File Share</h1>
        <div class="filename">${fileRecord.filename}</div>
        <div class="meta">
            <span>📦 ${sizeStr}</span>
            <span>⏳ ${timeLeft}</span>
            <span>⬇️ ${downloadsLeft} left</span>
        </div>
        <a href="/d/${share.token}?download=1" class="btn">⬇ Download</a>
        <div class="footer">
            Encrypted with AES-256-GCM · Powered by <a href="https://github.com/ixchio/tas">TAS</a>
        </div>
    </div>
</body>
</html>`;
}

/**
 * Generate expired/invalid page
 */
function generateExpiredPage(reason = 'expired') {
    const messages = {
        expired: { icon: '⏰', title: 'Link Expired', desc: 'This download link has expired.' },
        used: { icon: '✅', title: 'Already Downloaded', desc: 'This file has reached its download limit.' },
        invalid: { icon: '❌', title: 'Invalid Link', desc: 'This download link is invalid or has been revoked.' }
    };
    const msg = messages[reason] || messages.invalid;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TAS — ${msg.title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0a0a0a;
            color: #e0e0e0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .card {
            background: #1a1a2e;
            border: 1px solid #2a2a4a;
            border-radius: 16px;
            padding: 40px;
            max-width: 420px;
            width: 90%;
            text-align: center;
        }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h1 { font-size: 20px; margin-bottom: 8px; color: #fff; }
        p { color: #888; font-size: 14px; }
    </style>
</head>
<body>
    <div class="card">
        <div class="icon">${msg.icon}</div>
        <h1>${msg.title}</h1>
        <p>${msg.desc}</p>
    </div>
</body>
</html>`;
}

export class ShareServer {
    constructor(options) {
        this.dataDir = options.dataDir;
        this.password = options.password;
        this.config = options.config;
        this.port = options.port || 3000;
        this.host = options.host || '0.0.0.0';

        this.db = null;
        this.client = null;
        this.encryptor = null;
        this.compressor = null;
        this.server = null;
    }

    async initialize() {
        this.db = new FileIndex(path.join(this.dataDir, 'index.db'));
        this.db.init();

        this.client = new TelegramClient(this.dataDir);
        await this.client.initialize(this.config.botToken);
        this.client.setChatId(this.config.chatId);

        this.encryptor = new Encryptor(this.password);
        this.compressor = new Compressor();
    }

    /**
     * Download and decrypt a file from Telegram
     */
    async downloadAndDecrypt(fileRecord) {
        const chunks = this.db.getChunks(fileRecord.id);
        if (chunks.length === 0) throw new Error('No chunks found');

        const downloadedChunks = [];

        for (const chunk of chunks) {
            const data = await this.client.downloadFile(chunk.file_telegram_id);
            const header = parseHeader(data);
            const payload = data.subarray(HEADER_SIZE);

            downloadedChunks.push({
                index: header.chunkIndex,
                data: payload,
                compressed: header.compressed
            });
        }

        downloadedChunks.sort((a, b) => a.index - b.index);
        const encryptedData = Buffer.concat(downloadedChunks.map(c => c.data));

        const compressedData = this.encryptor.decrypt(encryptedData);

        const wasCompressed = downloadedChunks[0].compressed;
        return await this.compressor.decompress(compressedData, wasCompressed);
    }

    /**
     * Handle incoming HTTP requests
     */
    async handleRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // Route: GET /d/:token
        const downloadMatch = url.pathname.match(/^\/d\/([a-f0-9]+)$/);

        if (!downloadMatch) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end(generateExpiredPage('invalid'));
            return;
        }

        const token = downloadMatch[1];
        const wantDownload = url.searchParams.get('download') === '1';

        try {
            // Clean expired shares first
            this.db.cleanExpiredShares();

            // Look up share
            const share = this.db.getShare(token);

            if (!share) {
                res.writeHead(410, { 'Content-Type': 'text/html' });
                res.end(generateExpiredPage('invalid'));
                return;
            }

            // Check expiry
            if (new Date(share.expires_at) < new Date()) {
                res.writeHead(410, { 'Content-Type': 'text/html' });
                res.end(generateExpiredPage('expired'));
                return;
            }

            // Check download limit
            if (share.download_count >= share.max_downloads) {
                res.writeHead(410, { 'Content-Type': 'text/html' });
                res.end(generateExpiredPage('used'));
                return;
            }

            // Get file record
            const fileRecord = this.db.db.prepare('SELECT * FROM files WHERE id = ?').get(share.file_id);
            if (!fileRecord) {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end(generateExpiredPage('invalid'));
                return;
            }

            if (!wantDownload) {
                // Show download page
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(generateDownloadPage(share, fileRecord));
                return;
            }

            // Download the file from Telegram, decrypt, and serve
            const data = await this.downloadAndDecrypt(fileRecord);

            // Increment download count
            this.db.incrementShareDownload(token);

            // Determine content type
            const ext = path.extname(fileRecord.filename).toLowerCase();
            const contentTypes = {
                '.pdf': 'application/pdf',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.txt': 'text/plain',
                '.json': 'application/json',
                '.zip': 'application/zip',
                '.mp4': 'video/mp4',
                '.mp3': 'audio/mpeg'
            };
            const contentType = contentTypes[ext] || 'application/octet-stream';

            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileRecord.filename}"`,
                'Content-Length': data.length
            });
            res.end(data);

        } catch (err) {
            console.error('Share server error:', err.message);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal server error');
        }
    }

    /**
     * Start the HTTP server
     */
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res).catch(err => {
                    console.error('Request error:', err);
                    res.writeHead(500);
                    res.end('Internal error');
                });
            });

            this.server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`Port ${this.port} is already in use. Try --port <other-port>`));
                } else {
                    reject(err);
                }
            });

            this.server.listen(this.port, this.host, () => {
                resolve();
            });
        });
    }

    /**
     * Stop the HTTP server
     */
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    if (this.db) this.db.close();
                    resolve();
                });
            } else {
                if (this.db) this.db.close();
                resolve();
            }
        });
    }
}
