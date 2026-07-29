"use client";

import { LogOut } from "lucide-react";
import { logout } from "@/app/login/actions";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * Header sign-out button.
 *
 * Fires the `logout()` server action which clears the vayu-session
 * cookie and redirects to /login. Rendered as an icon-only button
 * to match the visual weight of ThemeToggle next to it — space in
 * the nav header is tight, especially on mobile.
 *
 * Marked `"use client"` so MobileNav (client) can import it. The
 * form still posts to the `logout` server action — same progressive-
 * enhancement path as before.
 *
 * DOM shape: <form> > <Tooltip's inline-flex span> > <button>. The
 * tooltip is INSIDE the form (not the other way round) so the button
 * is unambiguously the form's submit control and the resulting HTML
 * is valid.
 */
export function SignOutButton() {
  return (
    <form action={logout} className="contents">
      <Tooltip content="Sign out" side="bottom" align="end">
        <button
          type="submit"
          aria-label="Sign out"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <LogOut size={14} />
        </button>
      </Tooltip>
    </form>
  );
}
