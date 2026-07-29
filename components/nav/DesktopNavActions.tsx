"use client";

import { ThemeToggle } from "./ThemeToggle";
import { SignOutButton } from "./SignOutButton";
import { useIsDesktopNav } from "./useIsDesktopNav";

/** Theme + sign-out for wide TopNav only (sheet owns these on phone). */
export function DesktopNavActions() {
  const isDesktop = useIsDesktopNav();
  if (!isDesktop) return null;
  return (
    <div className="flex items-center gap-1.5">
      <ThemeToggle />
      <SignOutButton />
    </div>
  );
}
