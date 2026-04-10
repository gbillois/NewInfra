-- Create the content table and seed one row.
-- Re-runs are safe: the table guard is IF NOT EXISTS, and the seed
-- row is only inserted if the table is empty.

CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL
);

INSERT INTO content (text)
  SELECT 'hello from DB'
  WHERE NOT EXISTS (SELECT 1 FROM content);
