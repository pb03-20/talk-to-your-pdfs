import React, { useState, useEffect, useRef } from "react";
import {
  FileText,
  ShieldCheck,
  Key,
  ExternalLink,
  Sun,
  Moon,
  MonitorSmartphone,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Sparkles,
  Lock,
} from "lucide-react";
import { AuthUser, decodeGoogleCredential, getGoogleClientId, setGoogleClientId } from "../lib/auth";
import { ThemePreference } from "../lib/theme";

interface LoginPageProps {
  onLoginSuccess: (user: AuthUser) => void;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
}

// Google 4-Color SVG Icon
export const GoogleIcon: React.FC<{ className?: string }> = ({ className = "w-5 h-5" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none">
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      fill="#EA4335"
    />
  </svg>
);

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: "outline" | "filled_blue" | "filled_black";
              size?: "large" | "medium" | "small";
              type?: "standard" | "icon";
              text?: "signin_with" | "signup_with" | "continue_with" | "signin";
              shape?: "rectangular" | "pill" | "circle" | "square";
              width?: string | number;
              logo_alignment?: "left" | "center";
            }
          ) => void;
          prompt: (momentListener?: (notification: any) => void) => void;
        };
      };
    };
  }
}

export const LoginPage: React.FC<LoginPageProps> = ({
  onLoginSuccess,
  themePreference,
  onCycleTheme,
}) => {
  const [clientId, setClientId] = useState<string>(getGoogleClientId());
  const [inputClientId, setInputClientId] = useState<string>(clientId);
  const [isGisReady, setIsGisReady] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isEditingClientId, setIsEditingClientId] = useState<boolean>(!clientId);
  const [isInitializing, setIsInitializing] = useState<boolean>(false);

  const googleBtnContainerRef = useRef<HTMLDivElement>(null);

  // Poll until Google Identity Services script loads from accounts.google.com
  useEffect(() => {
    let interval: NodeJS.Timeout;
    const checkGis = () => {
      if (typeof window !== "undefined" && window.google?.accounts?.id) {
        setIsGisReady(true);
        clearInterval(interval);
      }
    };
    checkGis();
    interval = setInterval(checkGis, 250);
    return () => clearInterval(interval);
  }, []);

  // Fetch server-configured Client ID from backend (/api/config) if not yet set in browser
  useEffect(() => {
    if (!clientId) {
      fetch("/api/config")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.googleClientId) {
            setClientId(data.googleClientId);
            setInputClientId(data.googleClientId);
            setIsEditingClientId(false);
          }
        })
        .catch(() => {});
    }
  }, [clientId]);

  // Initialize official Google Identity Services once Client ID and GIS are ready
  useEffect(() => {
    if (!isGisReady || !clientId || !googleBtnContainerRef.current) return;

    try {
      setIsInitializing(true);
      setAuthError(null);

      window.google?.accounts.id.initialize({
        client_id: clientId,
        callback: (response: { credential: string }) => {
          if (response?.credential) {
            const user = decodeGoogleCredential(response.credential);
            if (user && user.email) {
              onLoginSuccess(user);
            } else {
              setAuthError("Failed to extract verified email from Google ID token. Please try again.");
            }
          } else {
            setAuthError("No credentials received from Google. Sign-in was cancelled.");
          }
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });

      // Clear previous button render
      googleBtnContainerRef.current.innerHTML = "";

      // Render official Google Sign In button
      window.google?.accounts.id.renderButton(googleBtnContainerRef.current, {
        theme: themePreference === "dark" ? "filled_black" : "outline",
        size: "large",
        shape: "rectangular",
        text: "continue_with",
        width: 320,
        logo_alignment: "left",
      });

      // Optionally trigger One Tap prompt for users already signed in to Google
      try {
        window.google?.accounts.id.prompt((notification: any) => {
          if (notification.isNotDisplayed()) {
            console.log("Google One Tap suppressed:", notification.getNotDisplayedReason());
          }
        });
      } catch (e) {
        // One tap prompt is optional
      }
    } catch (err: any) {
      console.error("Error setting up Google Identity Services:", err);
      setAuthError("Could not initialize Google Sign-In. Please verify that your Client ID is correct.");
    } finally {
      setIsInitializing(false);
    }
  }, [isGisReady, clientId, themePreference, onLoginSuccess]);

  const handleSaveClientId = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputClientId.trim();
    if (!trimmed) {
      setAuthError("Please enter a valid Google OAuth Client ID.");
      return;
    }
    setGoogleClientId(trimmed);
    setClientId(trimmed);
    setIsEditingClientId(false);
    setAuthError(null);
  };

  const handleLaunchGooglePrompt = () => {
    if (!isGisReady) {
      setAuthError("Google Identity Services is still loading. Please check your internet connection.");
      return;
    }
    if (!clientId) {
      setIsEditingClientId(true);
      return;
    }
    try {
      window.google?.accounts.id.prompt();
    } catch (e) {
      console.warn("Could not open Google prompt:", e);
    }
  };

  const ThemeIcon =
    themePreference === "light" ? Sun : themePreference === "dark" ? Moon : MonitorSmartphone;

  return (
    <div className="min-h-screen w-full bg-canvas text-ink flex flex-col justify-between selection:bg-accent selection:text-accent-ink relative overflow-y-auto">
      {/* Background ambient lighting */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-gradient-to-b from-blue-500/10 via-indigo-500/5 to-transparent blur-3xl opacity-70" />
        <div className="absolute bottom-0 right-10 w-[500px] h-[300px] bg-gradient-to-t from-emerald-500/5 via-teal-500/5 to-transparent blur-3xl opacity-60" />
      </div>

      {/* Top Navbar */}
      <header className="relative z-10 w-full max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-accent text-accent-ink flex items-center justify-center shadow-sm">
            <FileText className="w-4 h-4" strokeWidth={2.2} />
          </div>
          <span className="font-semibold text-[15px] tracking-tight">Talk to Your PDFs</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onCycleTheme}
            className="p-2 text-ink-2 hover:text-ink hover:bg-sunken rounded-lg transition-colors"
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            <ThemeIcon className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Login Screen */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-4 py-8 sm:py-12">
        <div className="w-full max-w-md">
          {/* Card */}
          <div className="bg-surface/90 backdrop-blur-xl border border-line rounded-2xl shadow-xl p-6 sm:p-8 transition-all">
            {/* Header */}
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/15 via-sky-500/10 to-indigo-500/15 border border-line mb-3.5 text-accent shadow-sm">
                <GoogleIcon className="w-6 h-6" />
              </div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink">
                Sign in with Google
              </h1>
              <p className="text-ink-2 text-[13.5px] mt-1.5 leading-relaxed">
                Continue with your Google account to verify your email and access your private document library.
              </p>
            </div>

            {/* Error Banner */}
            {authError && (
              <div className="mb-5 p-3 rounded-xl bg-critical-bg text-critical text-xs border border-critical/20 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 leading-relaxed">{authError}</div>
              </div>
            )}

            {/* If Client ID is configured, render official Google Sign In button */}
            {clientId && !isEditingClientId ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center justify-center py-2">
                  <div
                    ref={googleBtnContainerRef}
                    className="flex justify-center min-h-[44px] w-full"
                  />
                  {!isGisReady && (
                    <div className="text-xs text-ink-3 mt-2 flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                      <span>Loading Google Identity Services...</span>
                    </div>
                  )}
                </div>

                <div className="pt-2 border-t border-line flex items-center justify-between text-xs text-ink-3">
                  <span className="flex items-center gap-1.5 truncate max-w-[220px]">
                    <ShieldCheck className="w-3.5 h-3.5 text-positive shrink-0" />
                    <span>Real Google OAuth 2.0</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setInputClientId(clientId);
                      setIsEditingClientId(true);
                    }}
                    className="text-ink hover:underline text-[11.5px]"
                  >
                    Change Client ID
                  </button>
                </div>
              </div>
            ) : (
              /* Client ID Setup Form */
              <div className="space-y-4">
                <div className="p-3.5 rounded-xl bg-sunken/80 border border-line text-xs space-y-2.5">
                  <div className="flex items-center gap-2 font-medium text-ink">
                    <Key className="w-4 h-4 text-accent" />
                    <span>Enter your Free Google OAuth Client ID</span>
                  </div>
                  <p className="text-ink-2 text-[11.5px] leading-relaxed">
                    To authenticate real users via their Google email, Google requires an OAuth 2.0 Web Client ID. It is 100% free with zero fees:
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-[11px] text-ink-2 pl-0.5">
                    <li>
                      Open{" "}
                      <a
                        href="https://console.cloud.google.com/apis/credentials"
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-500 hover:underline font-medium inline-flex items-center gap-0.5"
                      >
                        Google Cloud Console Credentials <ExternalLink className="w-2.5 h-2.5 inline" />
                      </a>
                    </li>
                    <li>
                      Create <strong>OAuth client ID</strong> &rarr; Application type: <strong>Web application</strong>.
                    </li>
                    <li>
                      Add <code className="bg-surface px-1 py-0.5 rounded border border-line font-mono">http://localhost:3000</code> to <strong>Authorized JavaScript origins</strong>.
                    </li>
                    <li>Paste your Client ID below:</li>
                  </ol>
                </div>

                <form onSubmit={handleSaveClientId} className="space-y-3">
                  <div>
                    <label className="block text-[11.5px] font-medium text-ink-2 mb-1">
                      Google OAuth Client ID:
                    </label>
                    <input
                      type="text"
                      value={inputClientId}
                      onChange={(e) => setInputClientId(e.target.value)}
                      placeholder="e.g. 123456789-abcdef.apps.googleusercontent.com"
                      className="w-full h-9 px-3 rounded-lg bg-sunken border border-line text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink font-mono transition-colors"
                      required
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    {clientId && (
                      <button
                        type="button"
                        onClick={() => setIsEditingClientId(false)}
                        className="h-8 px-3 rounded-lg text-xs text-ink-2 hover:bg-sunken transition-colors"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="submit"
                      className="h-9 px-4 rounded-lg bg-accent text-accent-ink hover:bg-accent-hover text-xs font-medium transition-colors flex items-center gap-2"
                    >
                      <GoogleIcon className="w-3.5 h-3.5" />
                      <span>Save & Activate Google Sign-In</span>
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* Privacy & Authentication Guarantee */}
            <div className="mt-5 pt-4 border-t border-line text-center text-[11px] text-ink-3 flex items-center justify-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-positive" />
              <span>Grounded RAG workspace scoped to your verified Google email</span>
            </div>
          </div>

          {/* Quick info badges */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-ink-3">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
              Real Google Sign-In
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
              100% Free Service
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
              Private PDF Indexing
            </span>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 border-t border-line/50 text-center text-[11px] text-ink-3">
        Talk to Your PDFs • Real Google Account Authentication
      </footer>
    </div>
  );
};
