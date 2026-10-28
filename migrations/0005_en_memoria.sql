-- Personas fallecidas: el aviso es solo un recordatorio, sin saludos ni botones
ALTER TABLE events ADD COLUMN memorial INTEGER NOT NULL DEFAULT 0;
