import type Database from 'better-sqlite3'

export const SCHEMA_VERSION = 3

export function migrate(db: Database.Database) {
  const row = db.pragma('user_version', { simple: true }) as number
  const currentVersion = typeof row === 'number' ? row : 0

  if (currentVersion === 0) {
    db.transaction(() => {
      applyV1(db)
      applyV2(db)
      applyV3(db)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
    return
  }

  if (currentVersion === 1) {
    db.transaction(() => {
      applyV2(db)
      applyV3(db)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
    return
  }

  if (currentVersion === 2) {
    db.transaction(() => {
      applyV3(db)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })()
    return
  }

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(
      `DB schema version ${currentVersion} is newer than app supports (${SCHEMA_VERSION})`
    )
  }
}

function applyV1(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_screenshots_captured_at ON screenshots(captured_at);

    CREATE TABLE IF NOT EXISTS analysis_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_start_ts INTEGER NOT NULL,
      batch_end_ts INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      llm_metadata TEXT,
      detailed_transcription TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_batches_status ON analysis_batches(status);

    CREATE TABLE IF NOT EXISTS batch_screenshots (
      batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
      screenshot_id INTEGER NOT NULL REFERENCES screenshots(id) ON DELETE RESTRICT,
      PRIMARY KEY (batch_id, screenshot_id)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_screenshots_screenshot ON batch_screenshots(screenshot_id);

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL REFERENCES analysis_batches(id) ON DELETE CASCADE,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      observation TEXT NOT NULL,
      metadata TEXT,
      llm_model TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_observations_batch_id ON observations(batch_id);
    CREATE INDEX IF NOT EXISTS idx_observations_time_range ON observations(start_ts, end_ts);

    CREATE TABLE IF NOT EXISTS timeline_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER REFERENCES analysis_batches(id) ON DELETE CASCADE,
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      day DATE NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      category TEXT NOT NULL,
      subcategory TEXT,
      detailed_summary TEXT,
      metadata TEXT,
      video_summary_url TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_cards_day ON timeline_cards(day);
    CREATE INDEX IF NOT EXISTS idx_timeline_cards_active_start_ts
      ON timeline_cards(start_ts) WHERE is_deleted = 0;
    CREATE INDEX IF NOT EXISTS idx_timeline_cards_active_batch
      ON timeline_cards(batch_id) WHERE is_deleted = 0;

    CREATE TABLE IF NOT EXISTS timeline_review_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      rating TEXT NOT NULL CHECK(rating IN ('focus','neutral','distracted'))
    );
    CREATE INDEX IF NOT EXISTS idx_review_ratings_time ON timeline_review_ratings(start_ts, end_ts);

    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      batch_id INTEGER NULL,
      call_group_id TEXT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL,
      model TEXT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success','failure')),
      latency_ms INTEGER NULL,
      http_status INTEGER NULL,
      request_method TEXT NULL,
      request_url TEXT NULL,
      request_headers TEXT NULL,
      request_body TEXT NULL,
      response_headers TEXT NULL,
      response_body TEXT NULL,
      error_domain TEXT NULL,
      error_code INTEGER NULL,
      error_message TEXT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_group ON llm_calls(call_group_id, attempt);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_batch ON llm_calls(batch_id);
  `)
}

function applyV2(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL UNIQUE,
      intentions TEXT,
      notes TEXT,
      reflections TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','complete')),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_journal_entries_day ON journal_entries(day);
    CREATE INDEX IF NOT EXISTS idx_journal_entries_status ON journal_entries(status);
  `)
}

function applyV3(db: Database.Database) {
  // Full-text search index for timeline cards.
  // We maintain this via triggers because timeline_cards uses soft-delete (is_deleted).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS timeline_cards_fts USING fts5(
      title,
      summary,
      detailed_summary,
      metadata,
      category,
      subcategory,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS timeline_cards_fts_ai
    AFTER INSERT ON timeline_cards
    WHEN new.is_deleted = 0
    BEGIN
      INSERT INTO timeline_cards_fts(
        rowid, title, summary, detailed_summary, metadata, category, subcategory
      ) VALUES (
        new.id, new.title, new.summary, new.detailed_summary, new.metadata, new.category, new.subcategory
      );
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_cards_fts_ad
    AFTER DELETE ON timeline_cards
    BEGIN
      DELETE FROM timeline_cards_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS timeline_cards_fts_au
    AFTER UPDATE ON timeline_cards
    BEGIN
      DELETE FROM timeline_cards_fts WHERE rowid = old.id;

      INSERT INTO timeline_cards_fts(
        rowid, title, summary, detailed_summary, metadata, category, subcategory
      )
      SELECT
        new.id, new.title, new.summary, new.detailed_summary, new.metadata, new.category, new.subcategory
      WHERE new.is_deleted = 0;
    END;

    -- Rebuild from source of truth on migration.
    DELETE FROM timeline_cards_fts;
    INSERT INTO timeline_cards_fts(
      rowid, title, summary, detailed_summary, metadata, category, subcategory
    )
    SELECT
      id, title, summary, detailed_summary, metadata, category, subcategory
    FROM timeline_cards
    WHERE is_deleted = 0;
  `)
}
