/**
 * Miniflare integration harness entrypoint — Phase 15.
 *
 * Wires the project worker's default fetch handler over real Cloudflare
 * primitives running under Miniflare: R2-backed Storage, DO-backed
 * Coordinator, HMR DO Transport, Worker Loader-backed Executor.
 *
 * The framework runtime is supplied via Vite's `?raw` imports of the
 * runtime's dist bundle. The same shape works in production via the
 * Phase 15a deploy pipeline (bundle the runtime at deploy time).
 *
 * Tests reach the worker via `SELF.fetch` and pre-seed R2 via
 * `env.FILES.put(...)`; the project worker reads files back through
 * `R2Storage`, compiles via the inline-bundle path, and renders.
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-expect-error — Vite's `?raw` plugin returns the file as a string.
import RUNTIME_COMPONENTS_SRC from "../../packages/astroflare-runtime/dist/components.js?raw";
// @ts-expect-error
import RUNTIME_COOKIES_SRC from "../../packages/astroflare-runtime/dist/cookies.js?raw";
// @ts-expect-error
import RUNTIME_HMR_SRC from "../../packages/astroflare-runtime/dist/hmr-client.js?raw";
// @ts-expect-error — index.js re-exports from internal/render/jsx-runtime; all
// of those need to be present in the spawned isolate's module map.
import RUNTIME_INDEX_SRC from "../../packages/astroflare-runtime/dist/index.js?raw";
// @ts-expect-error
import RUNTIME_INTERNAL_SRC from "../../packages/astroflare-runtime/dist/internal.js?raw";
// @ts-expect-error
import RUNTIME_JSX_RUNTIME_SRC from "../../packages/astroflare-runtime/dist/jsx-runtime.js?raw";
// @ts-expect-error
import RUNTIME_RENDER_SRC from "../../packages/astroflare-runtime/dist/render.js?raw";
import { setProjectWorkerRuntime } from "@astroflare/host-cloudflare/project-worker";

setProjectWorkerRuntime({
	"runtime/index.js": RUNTIME_INDEX_SRC as string,
	"runtime/internal.js": RUNTIME_INTERNAL_SRC as string,
	"runtime/render.js": RUNTIME_RENDER_SRC as string,
	"runtime/hmr-client.js": RUNTIME_HMR_SRC as string,
	"runtime/cookies.js": RUNTIME_COOKIES_SRC as string,
	"runtime/components.js": RUNTIME_COMPONENTS_SRC as string,
	"runtime/jsx-runtime.js": RUNTIME_JSX_RUNTIME_SRC as string,
});

export {
	CoordinatorDurableObject,
	HmrDurableObject,
} from "@astroflare/host-cloudflare";
export { default } from "@astroflare/host-cloudflare/project-worker";
