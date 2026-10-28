-- La carga guiada ahora puede quedar esperando confirmación ("ya existe alguien parecido") con la entrada pendiente en payload.
-- Es estado temporal, así que se recrea la tabla (SQLite no permite cambiar un CHECK).
DROP TABLE IF EXISTS conversations;
CREATE TABLE conversations (
    chat_id    INTEGER PRIMARY KEY,
    kind       TEXT    NOT NULL,
    step       TEXT    NOT NULL CHECK (step IN ('name', 'date', 'confirm')),
    name       TEXT,
    payload    TEXT,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
