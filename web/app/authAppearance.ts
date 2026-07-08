// Clerk appearance for the Spool-themed auth pages. Uses stable `variables` +
// `elements` (no theme package) so it survives SDK bumps. Indigo #4F46E5 matches
// the logo; surfaces mirror the dashboard's dark premium look.
export const authAppearance = {
  variables: {
    colorPrimary: "#4F46E5",
    colorText: "#f2f2f7",
    colorTextSecondary: "rgba(240, 241, 248, 0.55)",
    colorBackground: "#141416",
    colorInputBackground: "#0f0f13",
    colorInputText: "#f2f2f7",
    colorNeutral: "#ffffff",
    colorDanger: "#ff6b6b",
    colorSuccess: "#34d17a",
    borderRadius: "10px",
    fontFamily: "var(--spool-sans), -apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: "0.95rem",
  },
  elements: {
    rootBox: { width: "100%" },
    cardBox: {
      boxShadow:
        "inset 0 0 0 1px rgba(255,255,255,0.09), 0 1px 2px rgba(0,0,0,0.04), 0 40px 90px -50px rgba(0,0,0,0.95)",
      borderRadius: "16px",
    },
    card: { backgroundColor: "#141416", boxShadow: "none" },
    headerTitle: { fontWeight: 650, letterSpacing: "-0.02em", fontSize: "1.25rem" },
    headerSubtitle: { color: "rgba(240, 241, 248, 0.55)" },
    socialButtonsBlockButton: {
      backgroundColor: "rgba(255,255,255,0.05)",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.04)",
      color: "#f2f2f7",
    },
    socialButtonsBlockButton__hover: { backgroundColor: "rgba(255,255,255,0.09)" },
    dividerLine: { backgroundColor: "rgba(255,255,255,0.09)" },
    dividerText: { color: "rgba(240,241,248,0.42)" },
    formFieldLabel: { color: "rgba(240,241,248,0.72)" },
    formFieldInput: {
      backgroundColor: "#0f0f13",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1)",
      color: "#f2f2f7",
    },
    formButtonPrimary: {
      backgroundColor: "#4F46E5",
      boxShadow: "0 1px 2px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)",
      textTransform: "none",
      fontWeight: 600,
      fontSize: "0.95rem",
    },
    formButtonPrimary__hover: { backgroundColor: "#4338ca" },
    footerActionText: { color: "rgba(240,241,248,0.55)" },
    footerActionLink: { color: "#aab8ff", fontWeight: 600 },
    formFieldInputShowPasswordButton: { color: "rgba(240,241,248,0.55)" },
    identityPreviewEditButton: { color: "#aab8ff" },
  },
};
