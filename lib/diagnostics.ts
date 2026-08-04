/**
 * Central switch for sensitive diagnostics routes/pages.
 *
 * - Enabled by default in non-production for local troubleshooting.
 * - In production, must be explicitly enabled with
 *   ENABLE_DEBUG_DIAGNOSTICS=true.
 */
export function diagnosticsEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.ENABLE_DEBUG_DIAGNOSTICS === "true"
  );
}
