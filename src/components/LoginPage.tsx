import React, { useState, useEffect, useRef } from "react";
import {
  FileText,
  ShieldCheck,
  Sun,
  Moon,
  MonitorSmartphone,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  Lock,
  ArrowRight,
  Key,
  ExternalLink,
} from "lucide-react";
import { AuthUser, getGoogleClientId, setGoogleClientId } from "../lib/auth";
import { ThemePreference } from "../lib/theme";

interface LoginPageProps {
  onLoginSuccess: (user: AuthUser) => void;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
}

// Official Google 4-Color SVG Icon
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
  const [isGisReady, setIsGisReady] = useState<boolean>(false);
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState<boolean>(!clientId);
  const [keyInput, setKeyInput] = useState<string>(clientId);

  const googleBtnContainerRef = useRef<HTMLDivElement>(null);

  // Poll for Google Identity Services script from Google
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

  // Fetch client ID from backend if not yet in state
  useEffect(() => {
    if (!clientId) {
      fetch("/api/config")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.googleClientId) {
            setClientId(data.googleClientId);
            setKeyInput(data.googleClientId);
            setShowConfig(false);
          }
        })
        .catch(() => {});
    }
  }, [clientId]);

  // Authenticate and cryptographically verify Google ID token
  const handleCredentialReceived = async (credential: string) => {
    try {
      setIsVerifying(true);
      setAuthError(null);

      const res = await fetch("/api/auth/verify-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_token: credential }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || err.error || "Google authentication rejected.");
      }

      const verified = await res.json();
      if (!verified.email) {
        throw new Error("No verified email returned by Google.");
      }

      onLoginSuccess({
        id: verified.sub || `google_${Date.now()}`,
        name: verified.name || verified.email.split("@")[0],
        email: verified.email,
        picture: verified.picture || "",
        provider: "google",
        verifiedEmail: true,
        signedInAt: new Date().toISOString(),
        idToken: credential,
      });
    } catch (err: any) {
      console.error("Verification error:", err);
      setAuthError(err.message || "Failed to verify real Google identity.");
    } finally {
      setIsVerifying(false);
    }
  };

  // Render official Google button once GIS and Client ID are active
  useEffect(() => {
    if (!isGisReady || !clientId || !googleBtnContainerRef.current) return;

    try {
      setAuthError(null);

      window.google?.accounts.id.initialize({
        client_id: clientId,
        callback: (response: { credential: string }) => {
          if (response?.credential) {
            handleCredentialReceived(response.credential);
          } else {
            setAuthError("Google Sign-In was cancelled.");
          }
        },
        auto_select: false,
        cancel_on_tap_outside: true,
      });

      googleBtnContainerRef.current.innerHTML = "";
      window.google?.accounts.id.renderButton(googleBtnContainerRef.current, {
        theme: themePreference === "dark" ? "filled_black" : "outline",
        size: "large",
        shape: "rectangular",
        text: "continue_with",
        width: 320,
        logo_alignment: "left",
      });

      try {
        window.google?.accounts.id.prompt();
      } catch (e) {}
    } catch (err: any) {
      console.warn("Google GIS init error:", err);
    }
  }, [isGisReady, clientId, themePreference]);

  const handleSaveClientKey = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = keyInput.trim();
    if (!trimmed) {
      setAuthError("Please paste a valid Google OAuth Client ID.");
      return;
    }
    setGoogleClientId(trimmed);
    setClientId(trimmed);
    setShowConfig(false);
    setAuthError(null);
  };

  const handleManualGoogleClick = () => {
    if (clientId && isGisReady) {
      try {
        window.google?.accounts.id.prompt();
        return;
      } catch (e) {}
    }
    setShowConfig(true);
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
            onClick={() => setShowConfig((p) => !p)}
            className="p-2 text-ink-3 hover:text-ink rounded-lg transition-colors text-xs"
            title="Configure Google Client ID"
            aria-label="Configure Google Client ID"
          >
            <Key className="w-3.5 h-3.5" />
          </button>
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
                Log in with your verified Google account to authenticate your real identity and access your documents.
              </p>
            </div>

            {/* Error Banner */}
            {authError && (
              <div className="mb-5 p-3 rounded-xl bg-critical-bg text-critical text-xs border border-critical/20 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 leading-relaxed">{authError}</div>
              </div>
            )}

            {/* Verification in progress spinner */}
            {isVerifying && (
              <div className="mb-5 p-3 rounded-xl bg-sunken border border-line text-xs flex items-center justify-center gap-2.5 text-ink">
                <div className="w-3.5 h-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                <span>Verifying authentic Google identity with Google servers...</span>
              </div>
            )}

            {/* If Client ID is missing, show builder configuration form */}
            {!clientId || showConfig ? (
              <div className="space-y-4 mb-4">
                <div className="p-3.5 rounded-xl bg-sunken border border-line text-xs space-y-2">
                  <div className="flex items-center justify-between font-medium text-ink">
                    <span className="flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5 text-accent" />
                      <span>Google OAuth Client ID</span>
                    </span>
                    {clientId && (
                      <button
                        onClick={() => setShowConfig(false)}
                        className="text-ink-3 hover:text-ink text-[11px]"
                      >
                        Hide
                      </button>
                    )}
                  </div>
                  <p className="text-ink-2 text-[11.5px] leading-relaxed">
                    Google requires a Client ID from your Google Cloud Console so it can open the real Google authentication popup:
                  </p>
                  <form onSubmit={handleSaveClientKey} className="space-y-2.5 pt-1">
                    <input
                      type="text"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="e.g. 123456789-abcdef.apps.googleusercontent.com"
                      className="w-full h-9 px-3 rounded-lg bg-surface border border-line text-xs text-ink font-mono focus:outline-none focus:border-ink transition-colors"
                      required
                    />
                    <button
                      type="submit"
                      className="w-full h-9 rounded-lg bg-accent text-accent-ink hover:bg-accent-hover text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <GoogleIcon className="w-3.5 h-3.5" />
                      <span>Activate Real Google Sign-In</span>
                    </button>
                  </form>
                </div>
              </div>
            ) : null}

            {/* Official Google Sign-In Button */}
            <div className="space-y-3">
              <div className="flex justify-center min-h-[44px] w-full">
                {clientId && isGisReady ? (
                  <div ref={googleBtnContainerRef} className="flex justify-center w-full" />
                ) : (
                  <button
                    onClick={handleManualGoogleClick}
                    className="w-full h-11 flex items-center justify-center gap-3 px-4 rounded-xl bg-surface hover:bg-sunken border border-line-strong hover:border-ink font-medium text-[14px] text-ink transition-all shadow-sm active:scale-[0.99] group"
                  >
                    <GoogleIcon className="w-5 h-5 group-hover:scale-105 transition-transform" />
                    <span>Continue with Google</span>
                    <ArrowRight className="w-4 h-4 ml-auto text-ink-3 group-hover:text-ink transition-colors" />
                  </button>
                )}
              </div>

              <div className="pt-3 border-t border-line flex items-center justify-center text-xs text-ink-3">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-positive shrink-0" />
                  <span>Cryptographically Verified by Google OAuth</span>
                </span>
              </div>
            </div>

            {/* Privacy & Authentication Guarantee */}
            <div className="mt-5 pt-4 border-t border-line text-center text-[11px] text-ink-3 flex items-center justify-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-positive" />
              <span>Identity verified via official Google ID token</span>
            </div>
          </div>

          {/* Feature Highlights Grid */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="p-3.5 rounded-xl bg-surface/60 border border-line/80 flex flex-col gap-1.5">
              <div className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center">
                <FileText className="w-3.5 h-3.5" />
              </div>
              <div className="text-xs font-semibold text-ink">Multi-PDF Search</div>
              <div className="text-[11px] text-ink-3 leading-snug">
                Embed and search across dozens of documents simultaneously.
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-surface/60 border border-line/80 flex flex-col gap-1.5">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
                <Sparkles className="w-3.5 h-3.5" />
              </div>
              <div className="text-xs font-semibold text-ink">Live Voice Agent</div>
              <div className="text-[11px] text-ink-3 leading-snug">
                Sub-second audio dialogue powered by Google Gemini.
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-surface/60 border border-line/80 flex flex-col gap-1.5">
              <div className="w-7 h-7 rounded-lg bg-sky-500/10 text-sky-500 flex items-center justify-center">
                <CheckCircle2 className="w-3.5 h-3.5" />
              </div>
              <div className="text-xs font-semibold text-ink">Exact Citations</div>
              <div className="text-[11px] text-ink-3 leading-snug">
                Every answer references exact PDF page numbers and snippets.
              </div>
            </div>
          </div>

          {/* Quick info badges */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-ink-3">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
              100% Free
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
              Official Google Sign-In
            </span>
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-positive" />
              Private & Encrypted
            </span>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 py-4 border-t border-line/50 text-center text-[11px] text-ink-3">
        Talk to Your PDFs • Google Account Authentication
      </footer>
    </div>
  );
};
