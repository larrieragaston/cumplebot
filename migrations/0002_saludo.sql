-- Último saludo que le mandaste y su número de WhatsApp (para el botón "Saludar por WhatsApp")
ALTER TABLE events ADD COLUMN greeting TEXT;
ALTER TABLE events ADD COLUMN phone TEXT;
