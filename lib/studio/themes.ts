/**
 * Studio order-entry UI themes (recording surfaces).
 * Shared by TopNav dropdown + in-studio theme pill.
 */
export const STUDIO_THEMES = [
  {
    href: "/studio",
    label: "Classic",
    hint: "Default Vayu studio",
  },
  {
    href: "/studio/claymorphic",
    label: "Clay",
    hint: "Soft clay / pastel",
  },
  {
    href: "/studio/glassmorphic",
    label: "Glass",
    hint: "Frosted glass",
  },
  {
    href: "/studio/neumorphic",
    label: "Soft",
    hint: "Neumorphic extruded",
  },
  {
    href: "/studio/skeuomorphic",
    label: "Skeuo",
    hint: "Tactile skeuomorphic",
  },
] as const;

export function isStudioThemeActive(pathname: string, href: string): boolean {
  if (href === "/studio") {
    return pathname === "/studio" || pathname === "/studio/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
