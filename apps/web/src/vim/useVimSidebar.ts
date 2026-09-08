import { useVimAction, vimPane } from "./runtime";

/** Navigate existing sidebar rows without duplicating their selection or disclosure state. */
export function useVimSidebar() {
  useVimAction(({ command, scope, count }) => {
    if (scope !== "sidebar") return;
    const root = vimPane(document.activeElement);
    if (!root) return;
    const rows = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-thread-item] [role="button"], [data-thread-item] a, button[aria-expanded]:not([aria-haspopup])',
      ),
    ).filter(
      (element) =>
        element.getClientRects().length > 0 &&
        !element.closest('[role="dialog"], [role="listbox"]'),
    );
    const current = rows.findIndex(
      (row) => row === document.activeElement || row.contains(document.activeElement),
    );
    if (
      command === "move.down" ||
      command === "move.up" ||
      command === "move.top" ||
      command === "move.bottom"
    ) {
      const index =
        command === "move.top"
          ? 0
          : command === "move.bottom"
            ? rows.length - 1
            : current < 0
              ? 0
              : Math.max(
                  0,
                  Math.min(rows.length - 1, current + (command === "move.down" ? count : -count)),
                );
      rows[index]?.focus({ preventScroll: true });
      rows[index]?.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (command === "list.open") {
      rows[current]?.click();
      return true;
    }
    if (command === "list.collapse" || command === "list.expand") {
      const row = rows[current];
      if (
        row?.hasAttribute("aria-expanded") &&
        (row.getAttribute("aria-expanded") === "true") !== (command === "list.expand")
      )
        row.click();
      return true;
    }
  });
}
