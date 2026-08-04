import "server-only";

import { diagnosticsEnabled } from "@/lib/diagnostics";
import type { HealthCheck, SupabaseKeyMeta, SystemHealthReport } from "@/lib/systemHealthTypes";

type SupabaseLike = {
  from: (table: string) => {
    select: (column: string) => {
      limit: (count: number) => Promise<{
        error: { message: string; code?: string } | null;
      }>;
    };
  };
};

type ProbeError = {
  message: string;
  code?: string;
};

const TABLE_PROBES = [
  { name: "nw_daily", table: "nw_daily", selectColumn: "date" },
  { name: "fund_holdings", table: "fund_holdings", selectColumn: "fund_code" },
  { name: "nps_state", table: "nps_state", selectColumn: "id" },
  { name: "epf_state", table: "epf_state", selectColumn: "id" },
  { name: "portfolio_config", table: "portfolio_config", selectColumn: "key" },
  {
    name: "studio_recording_telemetry",
    table: "studio_recording_telemetry",
    selectColumn: "id",
  },
] as const;

function isTransientJwtFutureError(error: ProbeError): boolean {
  return (
    error.code === "PGRST303" &&
    /jwt issued at future/i.test(error.message)
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEnvSecret(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function inferJwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (payloadB64.length % 4)) % 4;
    const padded = payloadB64 + "=".repeat(padLen);
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { role?: unknown };
    return typeof parsed.role === "string" ? parsed.role : null;
  } catch {
    return null;
  }
}

function supabaseServiceKeyMeta(): SupabaseKeyMeta {
  const raw = process.env.SUPABASE_SERVICE_KEY;
  if (!raw) {
    return {
      present: false,
      normalizedLength: 0,
      keyType: "secret_or_other",
      inferredRole: null,
      roleLooksValid: false,
    };
  }

  const normalized = normalizeEnvSecret(raw);
  const jwtShape = normalized.split(".").length === 3;
  const inferredRole = jwtShape ? inferJwtRole(normalized) : null;
  const roleLooksValid = !jwtShape || inferredRole === "service_role";

  return {
    present: true,
    normalizedLength: normalized.length,
    keyType: jwtShape ? "jwt" : "secret_or_other",
    inferredRole,
    roleLooksValid,
  };
}

async function probeTable(
  sb: SupabaseLike,
  name: string,
  table: string,
  selectColumn: string
): Promise<HealthCheck> {
  const startedAt = Date.now();
  try {
    let retried = false;
    let { error } = await sb.from(table).select(selectColumn).limit(1);

    if (error && isTransientJwtFutureError(error)) {
      retried = true;
      await wait(150);
      const retry = await sb.from(table).select(selectColumn).limit(1);
      error = retry.error;
    }

    const finishedAt = Date.now();
    if (error) {
      return {
        name,
        ok: false,
        detail: `${(error as { code?: string }).code ?? "unknown"}: ${error.message}`,
        checkedAt: new Date(finishedAt).toISOString(),
        latencyMs: finishedAt - startedAt,
      };
    }
    return {
      name,
      ok: true,
      detail: retried ? "ok (after retry)" : "ok",
      checkedAt: new Date(finishedAt).toISOString(),
      latencyMs: finishedAt - startedAt,
    };
  } catch (err) {
    const finishedAt = Date.now();
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      checkedAt: new Date(finishedAt).toISOString(),
      latencyMs: finishedAt - startedAt,
    };
  }
}

async function probeTables(): Promise<HealthCheck[]> {
  try {
    const { sbServer } = await import("@/lib/supabase");
    return Promise.all(
      TABLE_PROBES.map((probe) =>
        probeTable(sbServer as unknown as SupabaseLike, probe.name, probe.table, probe.selectColumn)
      )
    );
  } catch (err) {
    const now = new Date().toISOString();
    const detail = err instanceof Error ? err.message : String(err);
    return TABLE_PROBES.map((probe) => ({
      name: probe.name,
      ok: false,
      detail: `client init failed: ${detail}`,
      checkedAt: now,
      latencyMs: 0,
    }));
  }
}

export async function getSystemHealthReport(): Promise<SystemHealthReport> {
  const keyMeta = supabaseServiceKeyMeta();
  const diagEnabled = diagnosticsEnabled();

  const tables = await probeTables();

  const envOk =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.APP_SESSION_SECRET) &&
    keyMeta.present &&
    keyMeta.roleLooksValid;

  const overallOk = envOk && tables.every((t) => t.ok);

  return {
    generatedAt: new Date().toISOString(),
    overallOk,
    diagnosticsEnabled: diagEnabled,
    environment: {
      nextPublicSupabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      appSessionSecret: Boolean(process.env.APP_SESSION_SECRET),
      studioMp3OverridesEnabled:
        process.env.NEXT_PUBLIC_STUDIO_MP3_OVERRIDES === "true",
      supabaseServiceKey: keyMeta,
    },
    tables,
    improvements: {
      diagnosticsGate: diagEnabled ? "enabled" : "disabled",
      systemHealthApi: "/api/health/system",
      audioProbeMode:
        process.env.NEXT_PUBLIC_STUDIO_MP3_OVERRIDES === "true"
          ? "mp3-override probe enabled"
          : "mp3-override probe disabled (synth-only default)",
      ciWorkflow: ".github/workflows/verify-pwa-local.yml",
      verifierCommand: "npm run verify:pwa-local",
    },
  };
}
