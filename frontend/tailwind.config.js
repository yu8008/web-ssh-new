/** @type {import('tailwindcss').Config} */
import animate from "tailwindcss-animate";

const withVar = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: withVar("--canvas"),
        chrome: withVar("--chrome"),
        content: withVar("--content"),
        surface: withVar("--surface"),
        elevated: withVar("--elevated"),
        line: withVar("--line"),
        "line-strong": withVar("--line-strong"),
        ink: withVar("--ink"),
        "ink-soft": withVar("--ink-soft"),
        muted: withVar("--muted"),
        brand: {
          DEFAULT: withVar("--brand"),
          ink: withVar("--brand-ink"),
          soft: withVar("--brand-soft")
        },
        ok: withVar("--ok"),
        warn: withVar("--warn"),
        danger: withVar("--danger")
      },
      borderRadius: {
        xl: "14px",
        lg: "10px",
        md: "8px"
      },
      boxShadow: {
        panel: "var(--shadow-panel)"
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"]
      },
      fontSize: {
        "2xs": ["11px", { lineHeight: "16px", letterSpacing: "0.01em" }],
        xs: ["12px", { lineHeight: "18px" }],
        sm: ["13px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "22px" }],
        lg: ["16px", { lineHeight: "24px" }],
        xl: ["20px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        "2xl": ["26px", { lineHeight: "32px", letterSpacing: "-0.02em" }]
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" }
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.98)" },
          to: { opacity: "1", transform: "scale(1)" }
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" }
        }
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out both",
        "rise-in": "rise-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "pop-in": "pop-in 140ms ease-out both",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite"
      }
    }
  },
  plugins: [animate]
};
