CREATE TABLE IF NOT EXISTS answer_audit_jobs (
  id TEXT PRIMARY KEY,
  report_short_id TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  dealership_name TEXT NOT NULL,
  city TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'partial', 'unavailable', 'failed')),
  methodology_version TEXT NOT NULL,
  source_job_id TEXT,
  vehicle_context_json TEXT,
  summary_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (source_job_id) REFERENCES answer_audit_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_answer_audit_jobs_domain_created
  ON answer_audit_jobs(domain, created_at DESC);

CREATE TABLE IF NOT EXISTS answer_audit_results (
  job_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_label TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('mentioned', 'not_mentioned', 'unavailable')),
  answer TEXT NOT NULL DEFAULT '',
  citations_json TEXT NOT NULL DEFAULT '[]',
  observed_at TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  assessment_json TEXT,
  PRIMARY KEY (job_id, question_id),
  FOREIGN KEY (job_id) REFERENCES answer_audit_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_answer_audit_results_job_provider
  ON answer_audit_results(job_id, provider, question_id);

CREATE TABLE IF NOT EXISTS answer_audit_rate_limits (
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ip_hash, day)
);
