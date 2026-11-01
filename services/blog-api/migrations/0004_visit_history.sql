CREATE TABLE visit_history_import (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  batch_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  site_base INTEGER NOT NULL,
  first_date TEXT NOT NULL,
  cutover_date TEXT NOT NULL,
  payload TEXT
);
CREATE TABLE visit_history (
  date TEXT PRIMARY KEY,
  visits INTEGER CHECK (visits IS NULL OR visits >= 0),
  partial INTEGER NOT NULL CHECK (partial IN (0, 1))
);
CREATE TRIGGER import_visit_history AFTER INSERT ON visit_history_import BEGIN
  INSERT INTO visit_history(date, visits, partial)
    SELECT json_extract(value, '$.date'), json_extract(value, '$.visits'), json_extract(value, '$.partial') FROM json_each(NEW.payload);
  UPDATE visit_history_import SET payload = NULL WHERE singleton = NEW.singleton;
END;
CREATE INDEX visit_events_created_at ON visit_events(created_at);
