-- Hasta 3 saludos sugeridos por persona (JSON array de strings) en lugar de uno solo
ALTER TABLE events ADD COLUMN greetings TEXT;
UPDATE events SET greetings = json_array(greeting) WHERE greeting IS NOT NULL;
ALTER TABLE events DROP COLUMN greeting;
