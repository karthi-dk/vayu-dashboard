import { NextResponse } from "next/server";
import { getStudioTelemetryRemoteSummary } from "@/lib/studio/recordingTelemetryServer";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function parseDays(url: string): number {
  const params = new URL(url).searchParams;
  const raw = params.get("days");
  if (!raw) return 30;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 30;
  return Math.max(1, Math.min(90, Math.floor(parsed)));
}

function isTableMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const maybe = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
      hint?: unknown;
    };
    const rawCode = typeof maybe.code === "string" ? maybe.code.toLowerCase() : "";
    if (rawCode === "pgrst205" || rawCode === "42p01" || rawCode === "42703") {
      return true;
    }

    const rawText = [maybe.message, maybe.details, maybe.hint]
      .filter((part): part is string => typeof part === "string")
      .join(" ")
      .toLowerCase();
    if (
      rawText.includes("studio_recording_telemetry") ||
      rawText.includes("runtime_surface") ||
      rawText.includes("display_mode")
    ) {
      return true;
    }
  }

  const text = describeError(error).toLowerCase();
  return (
    text.includes("42p01") ||
    text.includes("42703") ||
    text.includes("pgrst205") ||
    text.includes("studio_recording_telemetry") ||
    text.includes("runtime_surface") ||
    text.includes("display_mode")
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const maybe = error as {
      message?: unknown;
      details?: unknown;
      hint?: unknown;
      code?: unknown;
    };
    const parts: string[] = [];
    if (typeof maybe.message === "string" && maybe.message.trim()) {
      parts.push(maybe.message.trim());
    }
    if (typeof maybe.details === "string" && maybe.details.trim()) {
      parts.push(maybe.details.trim());
    }
    if (typeof maybe.hint === "string" && maybe.hint.trim()) {
      parts.push(maybe.hint.trim());
    }
    if (typeof maybe.code === "string" && maybe.code.trim()) {
      parts.push(`code=${maybe.code.trim()}`);
    }
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown server error object";
    }
  }
  return String(error);
}

export async function GET(req: Request) {
  const days = parseDays(req.url);
  try {
    const summary = await getStudioTelemetryRemoteSummary(days);
    return NextResponse.json(summary, {
      headers: {
        "cache-control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    if (isTableMissingError(error)) {
      return NextResponse.json(
        {
          ok: false,
          code: "table_missing",
          error:
            "studio_recording_telemetry table is missing. Run the latest SQL migration.",
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: describeError(error),
      },
      { status: 500 }
    );
  }
}
