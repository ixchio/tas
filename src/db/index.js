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

    // Create files table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        hash TEXT UNIQUE NOT NULL,
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

    // Create chunks table (for multi-part files)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        file_telegram_id TEXT,
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
  addChunk(fileId, chunkIndex, messageId, size) {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, message_id, size)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(fileId, chunkIndex, messageId, size);
  }

  /**
   * Find file by hash
   */
  findByHash(hash) {
    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE hash = ? OR hash LIKE ?
    `);

    return stmt.get(hash, hash + '%');
  }

  /**
   * Find file by filename
   */
  findByName(filename) {
    const stmt = this.db.prepare(`
      SELECT * FROM files WHERE filename = ? OR filename LIKE ?
    `);

    return stmt.get(filename, '%' + filename + '%');
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

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
    }
  }
}
