/**
 * copy-assets.mjs — completes the dist/ build.
 *
 * tsc emits only JavaScript, so the manifest and the HTML pages are copied
 * alongside it. dist/ is then a complete, loadable unpacked extension, which
 * is why the manifest's paths are flat (common.js, popup.html) rather than
 * pointing into src/.
 */

import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await mkdir(dist, { recursive: true });
await cp(join(root, "manifest.json"), join(dist, "manifest.json"));

const html = (await readdir(join(root, "src"))).filter((f) => f.endsWith(".html"));
for (const file of html) {
  await cp(join(root, "src", file), join(dist, file));
}

console.log(`copy-assets: manifest.json + ${html.length} html file(s) -> dist/`);
