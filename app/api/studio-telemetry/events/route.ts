import { NextResponse } from "next/server";
import {
  ingestStudioTelemetryEvents,
  purgeStudioTelemetryEvents,
} from "@/lib/studio/recordingTelemetryServer";
import type { StudioTelemetryIngestEvent } from "@/lib/studio/recordingTelemetry";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

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

function parseDeleteScope(req: Request): { mode: "all" | "older_than_days"; days: number | null } {
  const params = new URL(req.url).searchParams;
  const modeRaw = (params.get("mode") ?? "all").toLowerCase();
  const mode = modeRaw === "older_than_days" ? "older_than_days" : "all";
  if (mode !== "older_than_days") {
    return { mode: "all", days: null };
  }

  const daysRaw = params.get("days");
  const daysParsed = daysRaw ? Number(daysRaw) : 30;
  const days = Number.isFinite(daysParsed)
    ? Math.max(1, Math.min(365, Math.floor(daysParsed)))
    : 30;
  return { mode: "older_than_days", days };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON payload." },
      { status: 400 }
    );
  }

  const events =
    body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: unknown[] }).events as StudioTelemetryIngestEvent[])
      : null;

  if (!events || events.length === 0) {
    return NextResponse.json(
      { ok: false, error: "events[] is required." },
      { status: 400 }
    );
  }

  if (events.length > 400) {
    return NextResponse.json(
      { ok: false, error: "Too many events in one request (max 400)." },
      { status: 413 }
    );
  }

  try {
    const result = await ingestStudioTelemetryEvents(events);
    return NextResponse.json({
      ok: true,
      accepted: result.accepted,
      dropped: result.dropped,
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

export async function DELETE(req: Request) {
  const scope = parseDeleteScope(req);
  try {
    const result = await purgeStudioTelemetryEvents(
      scope.mode === "older_than_days" && scope.days != null
        ? { olderThanDays: scope.days }
        : undefined
    );

    return NextResponse.json({
      ok: true,
      deleted: result.deleted,
      mode: scope.mode,
      days: scope.days,
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
