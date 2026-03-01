import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#09090b",
        panel: "#111113",
        muted: "#27272a",
      },
    },
  },
  plugins: [],
};

export default config;
