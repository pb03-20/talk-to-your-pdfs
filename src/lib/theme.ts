import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "pdf_rag_theme";

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Private browsing and blocked site data both throw here.
  }
  return "system";
}

/**
 * Reflects the preference onto the document root.
 *
 * "system" removes the attribute entirely rather than writing a resolved
 * value, so the stylesheet's `prefers-color-scheme` rules stay in charge and
 * the page follows the OS live — including when the user flips it mid-session.
 */
function applyPreference(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    applyPreference(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Preference simply will not persist; the UI still works this session.
    }
  }, [preference]);

  // Track the OS setting so the toggle can show what "system" currently means.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved: "light" | "dark" =
    preference === "system" ? (systemDark ? "dark" : "light") : preference;

  /** Cycles light → dark → system, so the OS option stays reachable. */
  const cycleTheme = useCallback(() => {
    setPreference((prev) =>
      prev === "light" ? "dark" : prev === "dark" ? "system" : "light"
    );
  }, []);

  return { preference, resolved, setPreference, cycleTheme };
}
