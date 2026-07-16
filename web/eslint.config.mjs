import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// Next 16 removed `next lint`, so ESLint runs via its own CLI (`npm run lint`).
// eslint-config-next@16 ships native flat configs, so we spread them directly
// (FlatCompat can't wrap them — its legacy validator chokes on the flat plugin
// objects). core-web-vitals brings the React/hooks/a11y/Next rules; typescript
// layers in typescript-eslint.
const eslintConfig = [
  { ignores: [".next/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // react-hooks v7 (React-Compiler-era) rules that fire on patterns we use
      // deliberately and correctly throughout the app: hydrating client-only
      // state in a mount ([])-effect (SSR-safe), and the "latest ref" idiom
      // (ref.current = fn during render). Enabling these as errors would force
      // churn on working code. Revisit if/when we adopt the React Compiler.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      // pages/-era rule that misfires in the App Router: the only hits are <a>
      // tags pointing at /api/auth/signin — a server-redirect endpoint, not a
      // page — where <Link> would be wrong.
      "@next/next/no-html-link-for-pages": "off",
      // Underscore-prefixed args/vars are an intentional "unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];

export default eslintConfig;
