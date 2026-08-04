-- ─── Studio recording telemetry (pilot) ──────────────────────────────────
--
-- Purpose
-- -------
-- Persist reveal-timing telemetry across devices/browsers so pilot runs
-- can be analyzed centrally instead of per-browser localStorage.
--
-- Ingestion path
-- --------------
-- Browser events -> POST /api/studio-telemetry/events -> this table.
-- Route runs server-side with service_role key, so it bypasses RLS.
-- RLS still enabled here (no policies) to keep anon/public access denied.

create table if not exists studio_recording_telemetry (
  id bigserial primary key,
  client_event_id text not null unique,
  run_id text not null,
  theme text not null check (theme in ('classic','claymorphic','glassmorphic','neumorphic','unknown')),
  kind text not null check (kind in ('timing','rollup','interaction')),
  name text,
  metric text,
  scheduled_ms double precision,
  actual_ms double precision,
  drift_ms double precision,
  target_duration_ms double precision,
  actual_duration_ms double precision,
  delay_ms double precision,
  duration_drift_ms double precision,
  metadata jsonb not null default '{}'::jsonb,
  pathname text,
  user_agent text,
  device_class text not null check (device_class in ('desktop','tablet','mobile','unknown')),
  browser_family text not null check (browser_family in ('chromium','safari','firefox','edge','other','unknown')),
  platform text not null check (platform in ('macos','windows','ios','android','linux','unknown')),
  client_captured_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_studio_recording_telemetry_created_at
  on studio_recording_telemetry (created_at desc);

create index if not exists idx_studio_recording_telemetry_theme_created_at
  on studio_recording_telemetry (theme, created_at desc);

create index if not exists idx_studio_recording_telemetry_kind_created_at
  on studio_recording_telemetry (kind, created_at desc);

create index if not exists idx_studio_recording_telemetry_run_id
  on studio_recording_telemetry (run_id);

alter table studio_recording_telemetry enable row level security;

-- Verify
-- ------
-- select tablename, rowsecurity from pg_tables
-- where schemaname='public' and tablename='studio_recording_telemetry';
--
-- select count(*) from studio_recording_telemetry;
