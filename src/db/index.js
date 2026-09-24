/**
 * SQLite database for file index
 * Stores metadata about uploaded files
 */

import Database from 'better-sqlite3';
import path from 'path';

export class FileIndex {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize the database and create tables
   */
  init() {
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');
    // Enforce foreign keys so ON DELETE CASCADE actually works
    // (SQLite disables FK enforcement by default per connection)
    this.db.pragma('foreign_keys = ON');
    // Don't fail instantly when sync workers write concurrently
    this.db.pragma('busy_timeout = 5000');

    // Create files table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        hash TEXT NOT NULL,
        original_size INTEGER NOT NULL,
        stored_size INTEGER NOT NULL,
        chunks INTEGER NOT NULL DEFAULT 1,
        compressed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
      CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
    `);

    this._removeLegacyUniqueHashConstraint();

    // Create chunks table (for multi-part files)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        file_telegram_id TEXT,
        bot_id TEXT,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        UNIQUE(file_id, chunk_index)
      );

    `);

    // Create tags table for file organization
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        tag TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        UNIQUE(file_id, tag)
      );
      
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    `);

    // Create sync_folders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_path TEXT UNIQUE NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Create sync_state table for tracking file changes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        file_hash TEXT,
        mtime INTEGER,
        synced_at TEXT,
        FOREIGN KEY (folder_id) REFERENCES sync_folders(id) ON DELETE CASCADE,
        UNIQUE(folder_id, relative_path)
      );
    `);

    // Create shares table for temporary file sharing
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL,
        max_downloads INTEGER NOT NULL DEFAULT 1,
        download_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
    `);

    // Create pending_uploads table for resume functionality
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        original_size INTEGER NOT NULL,
        stored_size INTEGER NOT NULL DEFAULT 0,
        compressed INTEGER NOT NULL DEFAULT 0,
        total_chunks INTEGER NOT NULL,
        uploaded_chunks INTEGER NOT NULL DEFAULT 0,
        temp_dir TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS pending_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pending_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_path TEXT NOT NULL,
        uploaded INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,
        file_telegram_id TEXT,
        bot_id TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (pending_id) REFERENCES pending_uploads(id) ON DELETE CASCADE,
        UNIQUE(pending_id, chunk_index)
      );
    `);

    // Online migration for databases created before multi-bot support.
    // NULL means the legacy `primary` bot and is intentionally not rewritten.
    const chunkColumns = this.db.pragma('table_info(chunks)').map(column => column.name);
    if (!chunkColumns.includes('bot_id')) {
      this.db.exec('ALTER TABLE chunks ADD COLUMN bot_id TEXT');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_bot_id ON chunks(bot_id)');
    const pendingChunkColumns = this.db.pragma('table_info(pending_chunks)').map(column => column.name);
    if (!pendingChunkColumns.includes('bot_id')) {
      this.db.exec('ALTER TABLE pending_chunks ADD COLUMN bot_id TEXT');
    }
    if (!pendingChunkColumns.includes('size')) {
      this.db.exec('ALTER TABLE pending_chunks ADD COLUMN size INTEGER NOT NULL DEFAULT 0');
    }
    const pendingUploadColumns = this.db.pragma('table_info(pending_uploads)').map(column => column.name);
    if (!pendingUploadColumns.includes('stored_size')) {
      this.db.exec('ALTER TABLE pending_uploads ADD COLUMN stored_size INTEGER NOT NULL DEFAULT 0');
    }
    if (!pendingUploadColumns.includes('compressed')) {
      this.db.exec('ALTER TABLE pending_uploads ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0');
    }
    this._removeLegacyPendingHashConstraint();
  }

  /**
   * v1-v2.5 made content hashes UNIQUE, which prevented the same bytes from
   * being stored at two logical paths and could orphan FUSE uploads. Rebuild
   * only legacy tables that still carry that constraint.
   */
  _removeLegacyUniqueHashConstraint() {
    const hasUniqueHash = this.db.pragma('index_list(files)').some(index => {
      if (!index.unique) return false;
      const columns = this.db.pragma(`index_info('${index.name.replaceAll("'", "''")}')`);
      return columns.length === 1 && columns[0].name === 'hash';
    });
    if (!hasUniqueHash) return;

    this.db.pragma('foreign_keys = OFF');
    this.db.pragma('legacy_alter_table = ON');
    try {
      this.db.exec(`
        BEGIN;
        ALTER TABLE files RENAME TO files_legacy_unique_hash;
        CREATE TABLE files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          hash TEXT NOT NULL,
          original_size INTEGER NOT NULL,
          stored_size INTEGER NOT NULL,
          chunks INTEGER NOT NULL DEFAULT 1,
          compressed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO files
          (id, filename, hash, original_size, stored_size, chunks, compressed, created_at, updated_at)
        SELECT id, filename, hash, original_size, stored_size, chunks, compressed, created_at, updated_at
        FROM files_legacy_unique_hash;
        DROP TABLE files_legacy_unique_hash;
        CREATE INDEX IF NOT EXISTS idx_files_filename ON files(filename);
        CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { }
      throw error;
    } finally {
      this.db.pragma('legacy_alter_table = OFF');
      this.db.pragma('foreign_keys = ON');
    }
  }

  _removeLegacyPendingHashConstraint() {
    const hasUniqueHash = this.db.pragma('index_list(pending_uploads)').some(index => {
      if (!index.unique) return false;
      const columns = this.db.pragma(`index_info('${index.name.replaceAll("'", "''")}')`);
      return columns.length === 1 && columns[0].name === 'hash';
    });
    if (!hasUniqueHash) return;

    this.db.pragma('foreign_keys = OFF');
    this.db.pragma('legacy_alter_table = ON');
    try {
      this.db.exec(`
        BEGIN;
        ALTER TABLE pending_uploads RENAME TO pending_uploads_legacy_unique_hash;
        CREATE TABLE pending_uploads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          file_path TEXT NOT NULL,
          hash TEXT NOT NULL,
          original_size INTEGER NOT NULL,
          stored_size INTEGER NOT NULL DEFAULT 0,
          compressed INTEGER NOT NULL DEFAULT 0,
          total_chunks INTEGER NOT NULL,
          uploaded_chunks INTEGER NOT NULL DEFAULT 0,
          temp_dir TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO pending_uploads
          (id, filename, file_path, hash, original_size, stored_size, compressed, total_chunks, uploaded_chunks, temp_dir, created_at)
        SELECT id, filename, file_path, hash, original_size, stored_size, compressed, total_chunks, uploaded_chunks, temp_dir, created_at
        FROM pending_uploads_legacy_unique_hash;
        DROP TABLE pending_uploads_legacy_unique_hash;
        COMMIT;
      `);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { }
      throw error;
    } finally {
      this.db.pragma('legacy_alter_table = OFF');
      this.db.pragma('foreign_keys = ON');
    }
  }

  /**
   * Add a new file record
   */
  addFile(fileData) {
    const stmt = this.db.prepare(`
      INSERT INTO files (filename, hash, original_size, stored_size, chunks, compressed)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      fileData.filename,
      fileData.hash,
      fileData.originalSize,
      fileData.storedSize,
      fileData.chunks,
      fileData.compressed ? 1 : 0
    );

    return result.lastInsertRowid;
  }

  /**
   * Add chunk metadata
   */
  addChunk(fileId, chunkIndex, messageId, size, fileTelegramId = null, botId = null) {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, message_id, size, file_telegram_id, bot_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(fileId, chunkIndex, messageId, size, fileTelegramId, botId);
  }

  /** Number of chunks that depend on a configured bot. */
  countChunksByBot(botId) {
    if (botId === 'primary') {
      return this.db.prepare(`
        SELECT COUNT(*) AS count FROM chunks WHERE bot_id = ? OR bot_id IS NULL
      `).get(botId).count;
    }
    return this.db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE bot_id = ?').get(botId).count;
  }

  countPendingChunksByBot(botId) {
    if (botId === 'primary') {
      return this.db.prepare(`
        SELECT COUNT(*) AS count FROM pending_chunks
        WHERE uploaded = 1 AND (bot_id = ? OR bot_id IS NULL)
      `).get(botId).count;
    }
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM pending_chunks WHERE uploaded = 1 AND bot_id = ?
    `).get(botId).count;
  }

  /**
   * Escape SQL LIKE wildcard characters
   */
  _escapeLike(str) {
    return str.replace(/[%_\\]/g, '\\$&');
  }

  /**
   * Find file by hash (exact match preferred, then prefix match)
   */
  findByHash(hash) {
    const exact = this.db.prepare('SELECT * FROM files WHERE hash = ?').get(hash);
    if (exact) return exact;

    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE hash LIKE ? ESCAPE '\\'
    `);

    return stmt.get(this._escapeLike(hash) + '%');
  }

  /**
   * Find file by filename (exact match preferred, then substring match)
   * Preferring exact matches avoids returning an arbitrary row when
   * duplicate filenames exist in the index.
   */
  findByName(filename) {
    const exact = this.db.prepare('SELECT * FROM files WHERE filename = ?').get(filename);
    if (exact) return exact;

    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE filename LIKE ? ESCAPE '\\'
    `);

    return stmt.get('%' + this._escapeLike(filename) + '%');
  }

  /** Exact logical-path lookup. Required by FUSE; never falls back to LIKE. */
  findByExactName(filename) {
    return this.db.prepare('SELECT * FROM files WHERE filename = ? ORDER BY id DESC LIMIT 1').get(filename);
  }

  /**
   * Find files whose chunk rows don't match the expected chunk count.
   * These are leftovers from interrupted uploads (see processFile cleanup).
   * Used by `tas resume` to offer cleanup/retry.
   */
  getIncompleteUploads() {
    const stmt = this.db.prepare(`
      SELECT f.*, COUNT(c.id) as actual_chunks
      FROM files f
      LEFT JOIN chunks c ON c.file_id = f.id
      GROUP BY f.id
      HAVING actual_chunks != f.chunks OR f.stored_size = 0
    `);
    return stmt.all();
  }

  /**
   * Delete a file and all its chunk rows explicitly.
   * Explicit deletes keep things correct even on connections
   * where FK enforcement was not enabled (older DBs).
   */
  deleteFileCascade(fileId) {
    const delChunks = this.db.prepare('DELETE FROM chunks WHERE file_id = ?');
    delChunks.run(fileId);
    const delTags = this.db.prepare('DELETE FROM tags WHERE file_id = ?');
    try { delTags.run(fileId); } catch { /* tags table may not exist on very old DBs */ }
    const delShares = this.db.prepare('DELETE FROM shares WHERE file_id = ?');
    try { delShares.run(fileId); } catch { /* ignore */ }
    const stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    stmt.run(fileId);
  }

  /**
   * Get chunks for a file
   */
  getChunks(fileId) {
    const stmt = this.db.prepare(`
      SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index
    `);

    return stmt.all(fileId);
  }

  /**
   * List all files
   */
  listAll() {
    const stmt = this.db.prepare(`
      SELECT * FROM files ORDER BY created_at DESC
    `);

    return stmt.all();
  }

  /**
   * Delete a file record
   */
  delete(fileId) {
    // Chunks are deleted automatically via CASCADE
    const stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    stmt.run(fileId);
  }

  /**
   * Check if file exists by hash
   */
  exists(hash) {
    const stmt = this.db.prepare('SELECT 1 FROM files WHERE hash = ?');
    return stmt.get(hash) !== undefined;
  }

  /**
   * Get total stats
   */
  getStats() {
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as file_count,
        COALESCE(SUM(original_size), 0) as total_original,
        COALESCE(SUM(stored_size), 0) as total_stored
      FROM files
    `);

    return stmt.get();
  }

  /** Export only durable storage metadata required to rebuild the local index. */
  exportManifest({ includeShares = false } = {}) {
    const files = this.db.prepare('SELECT * FROM files ORDER BY id').all();
    const chunks = this.db.prepare('SELECT * FROM chunks ORDER BY file_id, chunk_index').all();
    const tags = this.db.prepare('SELECT file_id, tag, created_at FROM tags ORDER BY file_id, tag').all();
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      files,
      chunks,
      tags
    };
    if (includeShares) manifest.shares = this.db.prepare('SELECT * FROM shares ORDER BY id').all();
    return manifest;
  }

  /** Replace storage metadata from a validated decrypted remote manifest. */
  importManifest(manifest) {
    if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.chunks)) {
      throw new Error('Unsupported or malformed TAS manifest');
    }

    const insertFile = this.db.prepare(`
      INSERT INTO files
        (id, filename, hash, original_size, stored_size, chunks, compressed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks
        (id, file_id, chunk_index, message_id, file_telegram_id, bot_id, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTag = this.db.prepare(`
      INSERT OR IGNORE INTO tags (file_id, tag, created_at) VALUES (?, ?, ?)
    `);
    const insertShare = this.db.prepare(`
      INSERT INTO shares
        (id, file_id, token, expires_at, max_downloads, download_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      if (Array.isArray(manifest.shares)) this.db.prepare('DELETE FROM shares').run();
      this.db.prepare('DELETE FROM tags').run();
      this.db.prepare('DELETE FROM chunks').run();
      this.db.prepare('DELETE FROM files').run();
      for (const file of manifest.files) {
        insertFile.run(
          file.id,
          file.filename,
          file.hash,
          file.original_size,
          file.stored_size,
          file.chunks,
          file.compressed,
          file.created_at,
          file.updated_at
        );
      }
      for (const chunk of manifest.chunks) {
        insertChunk.run(
          chunk.id,
          chunk.file_id,
          chunk.chunk_index,
          chunk.message_id,
          chunk.file_telegram_id,
          chunk.bot_id || null,
          chunk.size,
          chunk.created_at
        );
      }
      for (const tag of manifest.tags || []) {
        insertTag.run(tag.file_id, tag.tag, tag.created_at);
      }
      for (const share of manifest.shares || []) {
        insertShare.run(
          share.id,
          share.file_id,
          share.token,
          share.expires_at,
          share.max_downloads,
          share.download_count,
          share.created_at
        );
      }
    })();
  }

  // ============== TAG METHODS ==============

  /**
   * Add a tag to a file
   */
  addTag(fileId, tag) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO tags (file_id, tag) VALUES (?, ?)
    `);
    stmt.run(fileId, tag.toLowerCase().trim());
  }

  /**
   * Remove a tag from a file
   */
  removeTag(fileId, tag) {
    const stmt = this.db.prepare(`
      DELETE FROM tags WHERE file_id = ? AND tag = ?
    `);
    stmt.run(fileId, tag.toLowerCase().trim());
  }

  /**
   * Get all tags for a file
   */
  getFileTags(fileId) {
    const stmt = this.db.prepare(`
      SELECT tag FROM tags WHERE file_id = ? ORDER BY tag
    `);
    return stmt.all(fileId).map(row => row.tag);
  }

  /**
   * Find all files with a specific tag
   */
  findByTag(tag) {
    const stmt = this.db.prepare(`
      SELECT f.* FROM files f
      INNER JOIN tags t ON f.id = t.file_id
      WHERE t.tag = ?
      ORDER BY f.created_at DESC
    `);
    return stmt.all(tag.toLowerCase().trim());
  }

  /**
   * Get all unique tags
   */
  getAllTags() {
    const stmt = this.db.prepare(`
      SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY tag
    `);
    return stmt.all();
  }

  // ============== SYNC METHODS ==============

  /**
   * Add a folder to sync
   */
  addSyncFolder(localPath) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO sync_folders (local_path) VALUES (?)
    `);
    const result = stmt.run(localPath);
    return result.lastInsertRowid || this.getSyncFolderByPath(localPath)?.id;
  }

  /**
   * Remove a sync folder
   */
  removeSyncFolder(localPath) {
    const stmt = this.db.prepare(`
      DELETE FROM sync_folders WHERE local_path = ?
    `);
    stmt.run(localPath);
  }

  /**
   * Get sync folder by path
   */
  getSyncFolderByPath(localPath) {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_folders WHERE local_path = ?
    `);
    return stmt.get(localPath);
  }

  /**
   * Get all sync folders
   */
  getSyncFolders() {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_folders ORDER BY created_at
    `);
    return stmt.all();
  }

  /**
   * Update sync state for a file
   */
  updateSyncState(folderId, relativePath, fileHash, mtime) {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (folder_id, relative_path, file_hash, mtime, synced_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(folder_id, relative_path) DO UPDATE SET
        file_hash = excluded.file_hash,
        mtime = excluded.mtime,
        synced_at = datetime('now')
    `);
    stmt.run(folderId, relativePath, fileHash, mtime);
  }

  /**
   * Get sync state for a file
   */
  getSyncState(folderId, relativePath) {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_state WHERE folder_id = ? AND relative_path = ?
    `);
    return stmt.get(folderId, relativePath);
  }

  /**
   * Get all sync states for a folder
   */
  getFolderSyncStates(folderId) {
    const stmt = this.db.prepare(`
      SELECT * FROM sync_state WHERE folder_id = ?
    `);
    return stmt.all(folderId);
  }

  /**
   * Remove sync state for a file
   */
  removeSyncState(folderId, relativePath) {
    const stmt = this.db.prepare(`
      DELETE FROM sync_state WHERE folder_id = ? AND relative_path = ?
    `);
    stmt.run(folderId, relativePath);
  }

  // ============== SEARCH METHODS ==============

  /**
   * Search files by filename (fuzzy match)
   */
  search(query) {
    const stmt = this.db.prepare(`
      SELECT f.*, GROUP_CONCAT(t.tag) as tags
      FROM files f
      LEFT JOIN tags t ON f.id = t.file_id
      WHERE f.filename LIKE ? ESCAPE '\\'
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    return stmt.all(`%${this._escapeLike(query)}%`);
  }

  /**
   * Search files by tag
   */
  searchByTag(query) {
    const stmt = this.db.prepare(`
      SELECT f.*, GROUP_CONCAT(t.tag) as tags
      FROM files f
      INNER JOIN tags t ON f.id = t.file_id
      WHERE t.tag LIKE ? ESCAPE '\\'
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    return stmt.all(`%${this._escapeLike(query)}%`);
  }

  // ============== RESUME UPLOAD METHODS ==============

  /**
   * Add a pending upload
   */
  addPendingUpload(data) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pending_uploads 
      (filename, file_path, hash, original_size, stored_size, compressed, total_chunks, uploaded_chunks, temp_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.filename,
      data.filePath,
      data.hash,
      data.originalSize,
      data.storedSize || 0,
      data.compressed ? 1 : 0,
      data.totalChunks,
      data.uploadedChunks || 0,
      data.tempDir
    );
    return result.lastInsertRowid;
  }

  /**
   * Add a pending chunk
   */
  addPendingChunk(pendingId, chunkIndex, chunkPath, size = 0) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pending_chunks (pending_id, chunk_index, chunk_path, size, uploaded)
      VALUES (?, ?, ?, ?, 0)
    `);
    stmt.run(pendingId, chunkIndex, chunkPath, size);
  }

  /**
   * Mark chunk as uploaded
   */
  markChunkUploaded(pendingId, chunkIndex, messageId, fileTelegramId, botId = null) {
    const stmt = this.db.prepare(`
      UPDATE pending_chunks 
      SET uploaded = 1, message_id = ?, file_telegram_id = ?, bot_id = ?
      WHERE pending_id = ? AND chunk_index = ? AND uploaded = 0
    `);
    const result = stmt.run(messageId, fileTelegramId, botId, pendingId, chunkIndex);

    // Update uploaded count
    if (result.changes > 0) this.db.prepare(`
      UPDATE pending_uploads SET uploaded_chunks = uploaded_chunks + 1 WHERE id = ?
    `).run(pendingId);
  }

  /**
   * Get all pending uploads
   */
  getPendingUploads() {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_uploads ORDER BY created_at DESC
    `);
    return stmt.all();
  }

  /**
   * Get pending chunks for an upload
   */
  getPendingChunks(pendingId) {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_chunks WHERE pending_id = ? ORDER BY chunk_index
    `);
    return stmt.all(pendingId);
  }

  /**
   * Delete a pending upload (and its chunks via CASCADE)
   */
  deletePendingUpload(pendingId) {
    const stmt = this.db.prepare('DELETE FROM pending_uploads WHERE id = ?');
    stmt.run(pendingId);
  }

  /**
   * Get pending upload by hash
   */
  getPendingByHash(hash) {
    const stmt = this.db.prepare('SELECT * FROM pending_uploads WHERE hash = ?');
    return stmt.get(hash);
  }

  // ============== SHARE METHODS ==============

  /**
   * Create a share link for a file
   */
  addShare(fileId, token, expiresAt, maxDownloads = 1) {
    const stmt = this.db.prepare(`
      INSERT INTO shares (file_id, token, expires_at, max_downloads)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(fileId, token, expiresAt, maxDownloads);
    return result.lastInsertRowid;
  }

  /**
   * Get a share by token (returns null if not found)
   */
  getShare(token) {
    const stmt = this.db.prepare(`
      SELECT s.*, f.filename, f.original_size
      FROM shares s
      JOIN files f ON s.file_id = f.id
      WHERE s.token = ?
    `);
    return stmt.get(token) || null;
  }

  /**
   * List all active shares
   */
  listShares() {
    const stmt = this.db.prepare(`
      SELECT s.*, f.filename, f.original_size
      FROM shares s
      JOIN files f ON s.file_id = f.id
      ORDER BY s.created_at DESC
    `);
    return stmt.all();
  }

  /**
   * Revoke (delete) a share by token
   */
  revokeShare(token) {
    const stmt = this.db.prepare('DELETE FROM shares WHERE token = ?');
    const result = stmt.run(token);
    return result.changes > 0;
  }

  /**
   * Increment download count for a share
   */
  incrementShareDownload(token) {
    const stmt = this.db.prepare(`
      UPDATE shares SET download_count = download_count + 1 WHERE token = ?
    `);
    stmt.run(token);
  }

  /**
   * Remove expired shares
   */
  cleanExpiredShares() {
    const stmt = this.db.prepare(`
      DELETE FROM shares WHERE expires_at < ?
    `);
    return stmt.run(new Date().toISOString()).changes;
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}
