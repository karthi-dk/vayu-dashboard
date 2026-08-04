import { NextResponse } from "next/server";
import { diagnosticsEnabled } from "@/lib/diagnostics";

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

export async function GET() {
  if (!diagnosticsEnabled()) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const raw = process.env.SUPABASE_SERVICE_KEY;
  const normalized = raw ? normalizeEnvSecret(raw) : null;
  const jwtShape = normalized ? normalized.split(".").length === 3 : false;
  const inferredRole = normalized ? inferJwtRole(normalized) : null;

  return NextResponse.json({
    present: Boolean(raw),
    normalizedLength: normalized?.length ?? 0,
    keyType: jwtShape ? "jwt" : "secret_or_other",
    inferredRole,
    hint:
      jwtShape && inferredRole && inferredRole !== "service_role"
        ? "Key is JWT but not service_role. Update Production SUPABASE_SERVICE_KEY and redeploy."
        : "No obvious role mismatch detected.",
  });
}
