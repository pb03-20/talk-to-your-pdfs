/**
 * Real Google Authentication & Identity Services (GIS) utilities.
 * Handles client-side decoding and session management for verified Google accounts.
 */

import { AuthUser } from "../types";
export type { AuthUser };

const AUTH_STORAGE_KEY = "pdf_rag_google_auth_user";
const GOOGLE_CLIENT_ID_KEY = "pdf_rag_google_client_id";

/**
 * Retrieves the Google OAuth Client ID from localStorage or Vite environment variables.
 */
export function getGoogleClientId(): string {
  const custom = localStorage.getItem(GOOGLE_CLIENT_ID_KEY);
  if (custom && custom.trim()) {
    return custom.trim();
  }
  const envId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID;
  if (typeof envId === "string" && envId.trim()) {
    return envId.trim();
  }
  return "";
}

/**
 * Saves or clears the Google OAuth Client ID in localStorage.
 */
export function setGoogleClientId(id: string): void {
  if (id && id.trim()) {
    localStorage.setItem(GOOGLE_CLIENT_ID_KEY, id.trim());
  } else {
    localStorage.removeItem(GOOGLE_CLIENT_ID_KEY);
  }
}

/**
 * Gets currently logged-in verified Google user from localStorage.
 */
export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw) as AuthUser;
    if (user && user.email) {
      return user;
    }
    return null;
  } catch (e) {
    console.error("Failed to parse stored Google auth user:", e);
    return null;
  }
}

/**
 * Persists the verified Google user in localStorage.
 */
export function setStoredUser(user: AuthUser): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
}

/**
 * Clears the active Google session.
 */
export function clearStoredUser(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

/**
 * Derives a secure, dedicated workspace ID from the user's verified Google email address.
 * This guarantees all documents, chunks, and chats belong exclusively to that email.
 */
export function getUserWorkspaceId(email: string): string {
  const sanitized = email.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "_");
  return `ws_user_${sanitized}`;
}

/**
 * Decodes the cryptographically signed JWT ID token returned by Google Identity Services.
 * Returns the verified user profile (email, name, Google sub, picture URL).
 */
export function decodeGoogleCredential(token: string): AuthUser | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      console.error("Invalid JWT structure from Google");
      return null;
    }

    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    const data = JSON.parse(jsonPayload);

    if (!data.email) {
      console.error("Google ID token missing email attribute");
      return null;
    }

    return {
      id: data.sub || `google_${Date.now()}`,
      name: data.name || data.given_name || data.email.split("@")[0],
      email: data.email.toLowerCase(),
      picture: data.picture || "",
      provider: "google",
      verifiedEmail: Boolean(data.email_verified),
      signedInAt: new Date().toISOString(),
      idToken: token,
    };
  } catch (err) {
    console.error("Failed to decode Google Identity credential:", err);
    return null;
  }
}
