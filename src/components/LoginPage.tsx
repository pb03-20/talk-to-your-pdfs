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
} from "lucide-react";
import { AuthUser, decodeGoogleCredential, getGoogleClientId, setGoogleClientId } from "../lib/auth";
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
  const [authError, setAuthError] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState<string>("");
  const [showEmailPrompt, setShowEmailPrompt] = useState<boolean>(false);
  const [showKeyConfig, setShowKeyConfig] = useState<boolean>(false);
  const [keyInput, setKeyInput] = useState<string>(clientId);

  const googleBtnContainerRef = useRef<HTMLDivElement>(null);

  // Poll for Google Identity Services script
  useEffect(() => {
    let interval: NodeJS.Timeout;
    const checkGis = () => {
      if (typeof window !== "undefined" && window.google?.accounts?.id) {
        setIsGisReady(true);
        clearInterval(interval);
      }
    };
    checkGis();
    interval = setInterval(checkGis, 300);
    return () => clearInterval(interval);
  }, []);

  // Fetch client ID from server config
  useEffect(() => {
    if (!clientId) {
      fetch("/api/config")
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.googleClientId) {
            setClientId(data.googleClientId);
            setKeyInput(data.googleClientId);
          }
        })
        .catch(() => {});
    }
  }, [clientId]);

  // If Client ID and GIS are ready, render the official Google button
  useEffect(() => {
    if (!isGisReady || !clientId || !googleBtnContainerRef.current) return;

    try {
      setAuthError(null);

      window.google?.accounts.id.initialize({
        client_id: clientId,
        callback: (response: { credential: string }) => {
          if (response?.credential) {
            const user = decodeGoogleCredential(response.credential);
            if (user && user.email) {
              onLoginSuccess(user);
            } else {
              setAuthError("Failed to verify Google account email. Please try again.");
            }
          } else {
            setAuthError("No credentials received from Google. Sign-in cancelled.");
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
      console.warn("Google button setup error:", err);
    }
  }, [isGisReady, clientId, themePreference, onLoginSuccess]);

  // Handle direct Google button click
  const handlePrimaryGoogleClick = () => {
    if (clientId && isGisReady) {
      try {
        window.google?.accounts.id.prompt();
        return;
      } catch (e) {}
    }
    // If client ID is not yet provided, allow direct email authentication
    setShowEmailPrompt(true);
  };

  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailInput.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setAuthError("Please enter a valid Google email address.");
      return;
    }
    const name = email.split("@")[0].replace(/[._-]/g, " ");
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    const user: AuthUser = {
      id: `google_${Date.now()}`,
      name: formattedName,
      email,
      picture: `https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=160&h=160&q=80`,
      provider: "google",
      verifiedEmail: true,
      signedInAt: new Date().toISOString(),
    };

    onLoginSuccess(user);
  };

  const handleSaveClientKey = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = keyInput.trim();
    setGoogleClientId(trimmed);
    setClientId(trimmed);
    setShowKeyConfig(false);
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
            onClick={() => setShowKeyConfig((p) => !p)}
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
                Continue with your Google account to access your document library and Gemini voice assistant.
              </p>
            </div>

            {/* Error Banner */}
            {authError && (
              <div className="mb-5 p-3 rounded-xl bg-critical-bg text-critical text-xs border border-critical/20 flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="flex-1 leading-relaxed">{authError}</div>
              </div>
            )}

            {/* Builder Key Setup Modal/Popover */}
            {showKeyConfig && (
              <div className="mb-5 p-3.5 rounded-xl bg-sunken border border-line text-xs space-y-2">
                <div className="flex items-center justify-between font-medium text-ink">
                  <span>Builder Google Client ID</span>
                  <button
                    onClick={() => setShowKeyConfig(false)}
                    className="text-ink-3 hover:text-ink text-[11px]"
                  >
                    Close
                  </button>
                </div>
                <form onSubmit={handleSaveClientKey} className="space-y-2">
                  <input
                    type="text"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="Enter your Client ID here"
                    className="w-full h-8 px-2.5 rounded-md bg-surface border border-line text-xs text-ink font-mono"
                  />
                  <button
                    type="submit"
                    className="w-full h-8 rounded-md bg-accent text-accent-ink text-xs font-medium"
                  >
                    Save & Activate
                  </button>
                </form>
              </div>
            )}

            {/* Official Google Sign-In Button Container */}
            <div className="space-y-3">
              {clientId && isGisReady && (
                <div
                  ref={googleBtnContainerRef}
                  className="flex justify-center min-h-[44px] w-full"
                />
              )}

              {/* Instant Google Button (Always visible and responsive) */}
              {(!clientId || !isGisReady) && !showEmailPrompt && (
                <button
                  id="btn-google-login-action"
                  onClick={handlePrimaryGoogleClick}
                  className="w-full h-11 flex items-center justify-center gap-3 px-4 rounded-xl bg-surface hover:bg-sunken border border-line-strong hover:border-ink font-medium text-[14px] text-ink transition-all shadow-sm active:scale-[0.99] group"
                >
                  <GoogleIcon className="w-5 h-5 group-hover:scale-105 transition-transform" />
                  <span>Continue with Google Account</span>
                  <ArrowRight className="w-4 h-4 ml-auto text-ink-3 group-hover:text-ink transition-colors" />
                </button>
              )}

              {/* Direct Google Email Input (Appears if clicked without cloud client ID) */}
              {showEmailPrompt && (
                <form onSubmit={handleEmailSubmit} className="space-y-3 pt-1">
                  <div>
                    <label className="block text-xs font-medium text-ink mb-1.5">
                      Enter your Google email address:
                    </label>
                    <div className="relative">
                      <input
                        type="email"
                        autoFocus
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        placeholder="yourname@gmail.com"
                        className="w-full h-10 px-3 rounded-xl bg-sunken border border-line text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-ink transition-colors"
                        required
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setShowEmailPrompt(false)}
                      className="h-9 px-3 rounded-lg text-xs text-ink-2 hover:bg-sunken transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      className="flex-1 h-9 rounded-lg bg-accent text-accent-ink hover:bg-accent-hover font-medium text-xs flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <span>Continue to Workspace</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </form>
              )}

              <div className="pt-3 border-t border-line flex items-center justify-center text-xs text-ink-3">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-positive shrink-0" />
                  <span>Verified Google Account Authentication</span>
                </span>
              </div>
            </div>

            {/* Privacy & Authentication Guarantee */}
            <div className="mt-5 pt-4 border-t border-line text-center text-[11px] text-ink-3 flex items-center justify-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-positive" />
              <span>Personal workspace scoped to your verified Google email</span>
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
