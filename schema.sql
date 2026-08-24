CREATE TABLE IF NOT EXISTS daily_site_metrics (
  date TEXT PRIMARY KEY,
  visits INTEGER DEFAULT 0,
  users INTEGER DEFAULT 0,
  pageviews INTEGER DEFAULT 0,
  bounce_rate REAL DEFAULT 0,
  depth REAL DEFAULT 0,
  duration REAL DEFAULT 0,
  conversions REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS traffic_sources (
  period_key TEXT NOT NULL,
  name TEXT NOT NULL,
  visits INTEGER DEFAULT 0,
  conversions REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (period_key, name)
);

CREATE TABLE IF NOT EXISTS landing_pages (
  period_key TEXT NOT NULL,
  page TEXT NOT NULL,
  title TEXT,
  visits INTEGER DEFAULT 0,
  bounce REAL DEFAULT 0,
  depth REAL DEFAULT 0,
  conversions REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (period_key, page)
);

CREATE TABLE IF NOT EXISTS seo_queries (
  query TEXT PRIMARY KEY,
  shows REAL DEFAULT 0,
  clicks REAL DEFAULT 0,
  ctr REAL DEFAULT 0,
  position REAL DEFAULT 0,
  delta REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_campaigns (
  name TEXT PRIMARY KEY,
  impressions REAL DEFAULT 0,
  clicks REAL DEFAULT 0,
  spend REAL DEFAULT 0,
  conversions REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_daily (
  date TEXT PRIMARY KEY,
  spend REAL DEFAULT 0,
  clicks REAL DEFAULT 0,
  conversions REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sync_log (
  source TEXT PRIMARY KEY,
  last_sync TEXT,
  status TEXT,
  message TEXT
);
