/**
 * Progress bar utility with speed calculation
 * Shows actual MB/s instead of boring spinners
 */

import chalk from 'chalk';

export class ProgressBar {
    constructor(options = {}) {
        this.total = options.total || 100;
        this.width = options.width || 30;
        this.label = options.label || 'Progress';
        this.current = 0;
        this.startTime = Date.now();
        this.lastUpdate = 0;
        this.lastBytes = 0;
        this.speed = 0;
    }

    /**
     * Update progress
     * @param {number} current - Current bytes processed
     */
    update(current) {
        this.current = current;

        const now = Date.now();
        const elapsed = now - this.lastUpdate;

        // Calculate speed every 200ms
        if (elapsed >= 200) {
            const bytesDelta = current - this.lastBytes;
            this.speed = (bytesDelta / elapsed) * 1000; // bytes per second
            this.lastUpdate = now;
            this.lastBytes = current;
        }

        this.render();
    }

    /**
     * Render the progress bar
     */
    render() {
        const percent = Math.min(100, Math.round((this.current / this.total) * 100));
        const filled = Math.round((percent / 100) * this.width);
        const empty = this.width - filled;

        const bar = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
        const speedStr = this.formatSpeed(this.speed);
        const sizeStr = `${this.formatBytes(this.current)}/${this.formatBytes(this.total)}`;

        // Calculate ETA
        const eta = this.speed > 0
            ? Math.round((this.total - this.current) / this.speed)
            : 0;
        const etaStr = eta > 0 ? this.formatTime(eta) : '--:--';

        // Clear line and write
        process.stdout.write(`\r${this.label} ${bar} ${percent}% | ${sizeStr} | ${speedStr} | ETA: ${etaStr}  `);
    }

    /**
     * Complete the progress bar
     */
    complete(message) {
        const totalTime = (Date.now() - this.startTime) / 1000;
        const avgSpeed = this.total / totalTime;

        process.stdout.write('\r' + ' '.repeat(100) + '\r'); // Clear line
        console.log(chalk.green(`✓ ${message || this.label}`) +
            chalk.dim(` (${this.formatBytes(this.total)} in ${totalTime.toFixed(1)}s, avg ${this.formatSpeed(avgSpeed)})`));
    }

    /**
     * Format bytes to human readable
     */
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    }

    /**
     * Format speed to human readable
     */
    formatSpeed(bytesPerSec) {
        if (bytesPerSec === 0) return '-- MB/s';
        const mbps = bytesPerSec / (1024 * 1024);
        if (mbps >= 1) {
            return mbps.toFixed(1) + ' MB/s';
        }
        const kbps = bytesPerSec / 1024;
        return kbps.toFixed(0) + ' KB/s';
    }

    /**
     * Format seconds to mm:ss
     */
    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}

/**
 * Create a simple progress callback for ora-style usage
 */
export function createProgressCallback(label, total) {
    const bar = new ProgressBar({ label, total });
    return {
        update: (current) => bar.update(current),
        complete: (msg) => bar.complete(msg),
        bar
    };
}
