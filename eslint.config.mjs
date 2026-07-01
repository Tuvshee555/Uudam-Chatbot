import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".claude/**",
  ]),
  {
    // Poster.js was ported from a standalone (pre-React-Compiler) app and uses
    // a dynamic ref-map-by-index pattern (dayPhotoInputRefs.current[i] = node)
    // that predates react-hooks/immutability. The pattern is safe outside the
    // React Compiler; not worth a structural rewrite for a ported component.
    files: ["src/components/admin/poster/Poster.js"],
    rules: {
      "react-hooks/immutability": "off",
    },
  },
]);

export default eslintConfig;
