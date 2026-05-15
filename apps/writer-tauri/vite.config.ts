import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Vue feature flags — required because @milkdown/kit/component/list-item-block
  // ships an ESM-bundler Vue build that expects these globals at compile time.
  // Without them, Vue logs a runtime warning on every page load and tree-shakes
  // less aggressively in the production bundle. We don't use the Options API,
  // don't enable prod devtools, and don't SSR — all three are false.
  define: {
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Direct import of proof-sdk source modules so client and server
      // share a single mark-schema definition. The previous local copy
      // (apps/writer-tauri/src/editor/proofMarkSchemas.ts) drifted out
      // of sync with proof-sdk/src/editor/schema/proof-marks.ts — the
      // server's mark schema accepts 17 attrs on proofSuggestion
      // (content/status/runId/agentId/...), our copy carried only 7,
      // and the resulting Y.XmlFragment couldn't be parsed back to
      // markdown server-side (the projection-repair `node.children.some`
      // crash). Importing from the canonical source eliminates the
      // drift surface entirely; proof-sdk updates land here on the
      // next pnpm install.
      "@proof-sdk": path.resolve(__dirname, "../../../proof-sdk/src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: ["es2021", "safari15"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
