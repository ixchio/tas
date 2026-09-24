/** Normalize a TAS logical path to portable POSIX form. */
export function normalizeLogicalPath(value, { allowRoot = false } = {}) {
    if (typeof value !== 'string' || value.includes('\0')) {
        throw new Error('Invalid logical path');
    }

    const portable = value.replace(/\\/g, '/').replace(/^\/+/, '');
    const normalized = portable === '' ? '' : portable.split('/').filter(Boolean).join('/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) {
        throw new Error('Logical paths cannot contain . or .. segments');
    }
    if (!allowRoot && normalized === '') throw new Error('Logical path cannot be empty');
    return normalized;
}

export function parentLogicalPath(value) {
    const normalized = normalizeLogicalPath(value);
    const index = normalized.lastIndexOf('/');
    return index < 0 ? '' : normalized.slice(0, index);
}

/** Return only immediate children for a virtual directory. */
export function listLogicalChildren(paths, directory = '') {
    const dir = normalizeLogicalPath(directory, { allowRoot: true });
    const prefix = dir ? `${dir}/` : '';
    const children = new Set();

    for (const value of paths) {
        const logical = normalizeLogicalPath(value);
        if (!logical.startsWith(prefix)) continue;
        const remainder = logical.slice(prefix.length);
        if (!remainder) continue;
        children.add(remainder.split('/')[0]);
    }
    return [...children].sort((a, b) => a.localeCompare(b));
}

export function isImplicitDirectory(paths, directory) {
    const dir = normalizeLogicalPath(directory, { allowRoot: true });
    if (dir === '') return true;
    const prefix = `${dir}/`;
    return paths.some(value => normalizeLogicalPath(value).startsWith(prefix));
}
