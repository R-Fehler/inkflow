import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `@inkflow/shared/*` is the core's client library (src/ts/shared), as
// tsconfig.json's `paths` names it for tsc and esbuild.
export default defineConfig({
    resolve: {
        alias: {
            "@inkflow/shared": fileURLToPath(
                new URL("./src/ts/shared", import.meta.url),
            ),
        },
    },
});
