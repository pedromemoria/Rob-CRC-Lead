BEGIN;

CREATE SCHEMA IF NOT EXISTS sdr;
REVOKE ALL ON SCHEMA sdr FROM PUBLIC;

CREATE TABLE IF NOT EXISTS sdr.jobs (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text UNIQUE NOT NULL,
  lead text NOT NULL,
  event jsonb,
  plan jsonb,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'uncertain', 'blocked', 'done')),
  step text,
  effect boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  due timestamptz NOT NULL DEFAULT now(),
  error text
);

CREATE INDEX IF NOT EXISTS jobs_active_lead
  ON sdr.jobs (lead, seq) WHERE state <> 'done';
CREATE INDEX IF NOT EXISTS jobs_queued_due
  ON sdr.jobs (due, seq) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS jobs_running
  ON sdr.jobs (seq) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS sdr.paused (
  lead text PRIMARY KEY,
  since timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sdr.history (
  seq bigint PRIMARY KEY REFERENCES sdr.jobs (seq),
  lead text NOT NULL,
  conversation text NOT NULL,
  inbound text NOT NULL,
  outbound text NOT NULL,
  offered boolean NOT NULL,
  inserted timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS history_lookup
  ON sdr.history (lead, conversation, seq DESC);
CREATE INDEX IF NOT EXISTS history_retention ON sdr.history (inserted);

CREATE TABLE IF NOT EXISTS sdr.knowledge (
  name text PRIMARY KEY CHECK (name ~ '^[A-Za-z0-9_-]+\.(md|txt)$'),
  content text NOT NULL CHECK (octet_length(content) <= 24000)
);

COMMIT;
