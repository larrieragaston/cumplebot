CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('birthday', 'event')),
    name       TEXT    NOT NULL,
    day        INTEGER NOT NULL,
    month      INTEGER NOT NULL,
    year       INTEGER,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_chat ON events (chat_id);
CREATE INDEX IF NOT EXISTS idx_events_month ON events (month);

-- Avisos enviados, para no duplicar entre corridas del cron
CREATE TABLE IF NOT EXISTS notifications (
    event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    sent_on  TEXT    NOT NULL,
    PRIMARY KEY (event_id, sent_on)
);

-- Estado de la carga guiada (/cumple sin argumentos), ya que el Worker no guarda memoria entre mensajes
CREATE TABLE IF NOT EXISTS conversations (
    chat_id    INTEGER PRIMARY KEY,
    kind       TEXT    NOT NULL,
    step       TEXT    NOT NULL CHECK (step IN ('name', 'date')),
    name       TEXT,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
