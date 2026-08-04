import { NextResponse } from "next/server";

import { getSystemHealthReport } from "@/lib/systemHealth";

export async function GET() {
  const report = await getSystemHealthReport();
  return NextResponse.json(report, {
    status: report.overallOk ? 200 : 503,
    headers: {
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
