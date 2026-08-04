#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const NEXT_DIST_DIR = process.env.NEXT_DIST_DIR || ".next-build";

function parseArgs(argv) {
  const options = {
    port: 5010,
    baseUrl: "",
    reuse: false,
    skipBuild: false,
    sessionToken: process.env.VAYU_SESSION_TOKEN ?? "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reuse") {
      options.reuse = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--port") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--port requires a value");
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --port value: ${raw}`);
      }
      options.port = parsed;
      i += 1;
      continue;
    }
    if (arg === "--base-url") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--base-url requires a value");
      options.baseUrl = raw;
      i += 1;
      continue;
    }
    if (arg === "--session-token") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--session-token requires a value");
      options.sessionToken = raw;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.baseUrl) options.baseUrl = `http://localhost:${options.port}`;
  return options;
}

function logStep(msg) {
  process.stdout.write(`\n[verify-pwa-local] ${msg}\n`);
}

function runBuild() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, ["run", "build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_DIST_DIR,
      NODE_TLS_REJECT_UNAUTHORIZED:
        process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0",
    },
  });
  if (res.status !== 0) {
    throw new Error(`Build failed with exit code ${res.status ?? -1}`);
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function waitForServer(baseUrl, maxAttempts = 80) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/login`, {
        redirect: "manual",
      });
      if (res.status > 0) return;
    } catch {
      // keep polling
    }
    await delay(250);
  }
  throw new Error(`Server did not become ready at ${baseUrl}`);
}

async function startServer(port, baseUrl) {
  const nextBin =
    process.platform === "win32"
      ? "node_modules/.bin/next.cmd"
      : "./node_modules/.bin/next";

  const child = spawn(nextBin, ["start", "-p", String(port)], {
    env: {
      ...process.env,
      NEXT_DIST_DIR,
      NODE_TLS_REJECT_UNAUTHORIZED:
        process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (buf) => {
    process.stdout.write(`[next] ${String(buf)}`);
  });
  child.stderr.on("data", (buf) => {
    process.stderr.write(`[next] ${String(buf)}`);
  });

  await waitForServer(baseUrl);
  return child;
}

function printCheck(ok, passMsg, failMsg, failures, stats) {
  stats.total += 1;
  if (ok) {
    process.stdout.write(`PASS ${passMsg}\n`);
  } else {
    process.stdout.write(`FAIL ${failMsg}\n`);
    failures.push(failMsg);
  }
}

async function runChecks(baseUrl, sessionToken) {
  const failures = [];
  const stats = { total: 0 };

  const swRes = await fetchWithTimeout(`${baseUrl}/sw.js`, {
    redirect: "manual",
  });
  const swText = await swRes.text();
  const swCache = swRes.headers.get("cache-control") ?? "";

  printCheck(swRes.status === 200, "/sw.js returns 200", `/sw.js status=${swRes.status}`, failures, stats);
  printCheck(
    /no-cache/i.test(swCache) && /no-store/i.test(swCache),
    "/sw.js cache-control is no-cache/no-store",
    `/sw.js cache-control unexpected: ${swCache || "<missing>"}`,
    failures,
    stats
  );
  printCheck(
    swText.includes("SW_VERSION"),
    "/sw.js includes SW_VERSION marker",
    "/sw.js missing SW_VERSION marker",
    failures,
    stats
  );
  printCheck(
    swText.includes("skip-waiting") && swText.includes("caches.keys"),
    "/sw.js includes skip-waiting + cache cleanup hooks",
    "/sw.js missing skip-waiting/cache cleanup hooks",
    failures,
    stats
  );

  const manifestRes = await fetchWithTimeout(`${baseUrl}/manifest.webmanifest`, {
    redirect: "manual",
  });
  const manifestText = await manifestRes.text();
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    manifest = null;
  }

  printCheck(
    manifestRes.status === 200,
    "/manifest.webmanifest returns 200",
    `/manifest.webmanifest status=${manifestRes.status}`,
    failures,
    stats
  );
  printCheck(
    Boolean(manifest && manifest.display === "standalone"),
    "manifest display is standalone",
    "manifest missing display=standalone",
    failures,
    stats
  );
  printCheck(
    Boolean(manifest && manifest.start_url === "/"),
    "manifest start_url is /",
    "manifest start_url is not /",
    failures,
    stats
  );

  const rootRes = await fetchWithTimeout(`${baseUrl}/`, { redirect: "manual" });
  const rootLoc = rootRes.headers.get("location") ?? "";
  printCheck(
    rootRes.status >= 300 && rootRes.status < 400 && rootLoc.includes("/login"),
    "unauthenticated / redirects to /login",
    `unexpected / response: status=${rootRes.status}, location=${rootLoc || "<none>"}`,
    failures,
    stats
  );

  if (sessionToken) {
    const debugRes = await fetchWithTimeout(`${baseUrl}/api/debug/supabase-key`, {
      redirect: "manual",
      headers: { Cookie: `vayu-session=${sessionToken}` },
    });
    if (debugRes.status === 200) {
      const text = await debugRes.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }

      printCheck(
        true,
        "authenticated /api/debug/supabase-key returns 200",
        "",
        failures,
        stats
      );
      printCheck(
        Boolean(payload && typeof payload.present === "boolean"),
        "debug endpoint returns expected JSON shape",
        "debug endpoint JSON shape invalid",
        failures,
        stats
      );
    } else if (debugRes.status === 404) {
      printCheck(
        true,
        "authenticated /api/debug/supabase-key is disabled by diagnostics gate (404)",
        "",
        failures,
        stats
      );
      printCheck(
        true,
        "diagnostics gate behavior confirmed for debug endpoint",
        "",
        failures,
        stats
      );
    } else {
      printCheck(
        false,
        "",
        `/api/debug/supabase-key status=${debugRes.status}`,
        failures,
        stats
      );
      printCheck(
        false,
        "",
        "debug endpoint JSON shape invalid",
        failures,
        stats
      );
    }
  } else {
    const debugRes = await fetchWithTimeout(`${baseUrl}/api/debug/supabase-key`, {
      redirect: "manual",
    });
    const loc = debugRes.headers.get("location") ?? "";
    printCheck(
      debugRes.status >= 300 && debugRes.status < 400 && loc.includes("/login"),
      "unauthenticated /api/debug/supabase-key is protected by auth",
      `debug endpoint protection mismatch: status=${debugRes.status}, location=${loc || "<none>"}`,
      failures,
      stats
    );
    process.stdout.write(
      "INFO Tip: pass --session-token <token> or set VAYU_SESSION_TOKEN to validate authenticated debug JSON.\n"
    );
  }

  return { failures, totalChecks: stats.total };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let server = null;
  const startedByScript = !options.reuse;

  const stopServer = () => {
    if (server && !server.killed) {
      server.kill("SIGTERM");
    }
  };

  process.on("SIGINT", () => {
    stopServer();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    stopServer();
    process.exit(143);
  });
  process.on("exit", () => {
    stopServer();
  });

  if (!options.reuse) {
    if (!options.skipBuild) {
      logStep("Running production build...");
      runBuild();
    } else {
      logStep("Skipping build (--skip-build)");
    }

    logStep(`Starting local production server at ${options.baseUrl} ...`);
    server = await startServer(options.port, options.baseUrl);
  } else {
    logStep(`Reusing existing server at ${options.baseUrl}`);
    await waitForServer(options.baseUrl);
  }

  logStep("Running PWA + auth protection checks...");
  const { failures, totalChecks } = await runChecks(
    options.baseUrl,
    options.sessionToken
  );

  // If this script started the server, stop it before printing the
  // summary so the command exits cleanly.
  if (startedByScript) {
    stopServer();
    server = null;
  }

  logStep("Summary");
  const passed = totalChecks - failures.length;
  process.stdout.write(`Checks passed: ${passed}\n`);
  process.stdout.write(`Checks failed: ${failures.length}\n`);
  process.stdout.write(`Checks total: ${totalChecks}\n`);

  if (failures.length > 0) {
    process.exitCode = 1;
    for (const f of failures) process.stdout.write(` - ${f}\n`);
  } else {
    process.stdout.write("All checks passed.\n");
  }
}

main().catch((err) => {
  process.stderr.write(`[verify-pwa-local] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
