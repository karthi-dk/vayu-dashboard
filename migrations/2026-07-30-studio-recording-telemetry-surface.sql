-- Extend studio recording telemetry with runtime-surface analytics fields.
-- Captures whether events came from browser tab vs installed PWA shell,
-- plus display mode and iOS standalone compatibility flag.

alter table if exists studio_recording_telemetry
  add column if not exists referrer text,
  add column if not exists runtime_surface text
    check (runtime_surface in ('browser_tab','installed_app','android_twa','unknown'))
    default 'unknown',
  add column if not exists display_mode text
    check (display_mode in ('browser','standalone','minimal-ui','fullscreen','window-controls-overlay','unknown'))
    default 'unknown',
  add column if not exists is_standalone boolean not null default false;

create index if not exists idx_studio_recording_telemetry_runtime_surface_created_at
  on studio_recording_telemetry (runtime_surface, created_at desc);

create index if not exists idx_studio_recording_telemetry_platform_created_at
  on studio_recording_telemetry (platform, created_at desc);
