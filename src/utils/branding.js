/**
 * ASCII Art and Branding for TAS CLI
 */

import chalk from 'chalk';

export const LOGO = `
████████╗ █████╗ ███████╗
╚══██╔══╝██╔══██╗██╔════╝
   ██║   ███████║███████╗
   ██║   ██╔══██║╚════██║
   ██║   ██║  ██║███████║
   ╚═╝   ╚═╝  ╚═╝╚══════╝
`;

export const TAGLINE = 'Telegram as Storage';
export const VERSION = '2.1.0';

/**
 * Print the TAS banner
 */
export function printBanner() {
    console.log(chalk.cyan(LOGO));
    console.log(chalk.dim(`  ${TAGLINE} v${VERSION}`));
    console.log(chalk.dim('  Free • Encrypted • Unlimited\n'));
}

/**
 * Print a success message with icon
 */
export function success(msg) {
    console.log(chalk.green('✓'), msg);
}

/**
 * Print an error message with icon
 */
export function error(msg) {
    console.log(chalk.red('✗'), msg);
}

/**
 * Print an info message with icon
 */
export function info(msg) {
    console.log(chalk.blue('ℹ'), msg);
}

/**
 * Print a warning message with icon
 */
export function warn(msg) {
    console.log(chalk.yellow('⚠'), msg);
}

/**
 * Format file size
 */
export function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Print a table-like display for files
 */
export function printFileTable(files, showTags = false) {
    if (files.length === 0) {
        console.log(chalk.yellow('\n📭 No files stored yet.\n'));
        return;
    }

    console.log(chalk.cyan(`\n📦 Stored Files (${files.length})\n`));
    console.log(chalk.dim('─'.repeat(60)));

    for (const file of files) {
        const size = formatSize(file.original_size).padEnd(10);
        const name = chalk.white(file.filename);
        const date = new Date(file.created_at).toLocaleDateString();

        console.log(`  ${chalk.blue('●')} ${name}`);
        console.log(chalk.dim(`    ${size} • ${date} • ${file.chunks} chunk(s)`));

        if (showTags && file.tags && file.tags.length > 0) {
            console.log(chalk.magenta(`    🏷️  ${file.tags.join(', ')}`));
        }
    }

    console.log(chalk.dim('─'.repeat(60)));
    console.log();
}
