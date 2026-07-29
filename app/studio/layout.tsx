import { StudioThemeSwitch } from "@/components/studio/StudioThemeSwitch";

/**
 * Shared chrome for every /studio* route.
 *
 * TopNav stays hidden (see app/layout.tsx) so recordings don't pick
 * up the full app header. StudioThemeSwitch is the only chrome —
 * a slim pill of deep links across Classic / Clay / Glass / Soft.
 */
export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <StudioThemeSwitch />
      {children}
    </>
  );
}
