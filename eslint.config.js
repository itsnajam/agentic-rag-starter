import next from "eslint-config-next";

const config = [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"],
  },
  ...next,
  {
    files: ["**/*.{ts,tsx,mjs}"],
    rules: {
      // Prompt building and the store SQL both read better as long lines.
      "max-len": "off",
      "@next/next/no-img-element": "off",
    },
  },
  {
    files: ["scripts/**/*.ts", "tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];

export default config;
