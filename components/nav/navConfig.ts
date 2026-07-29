/**
 * Shared TopNav destinations — kept outside `"use client"` modules so
 * MobileNav / NavLinks can import the list without circular client
 * boundaries or pulling the whole desktop dropdown into the sheet.
 */
export const NAV_LINKS = [
  { href: "/", label: "Overview" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/credits", label: "Credits" },
  { href: "/sync", label: "Sync" },
  { href: "/settings", label: "Settings" },
  { href: "/filings", label: "Filings" },
] as const;

export function studioSectionActive(pathname: string): boolean {
  return pathname === "/studio" || pathname.startsWith("/studio/");
}
