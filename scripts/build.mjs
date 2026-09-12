/**
 * Vestyr production build.
 *
 * src/Main.dc.html is the authored source. It is a Design Component file so
 * that the same markup also drives the design canvas; this script strips the
 * <x-dc>/<helmet> wrappers, resolves the two theme tokens, injects the
 * production <head>, and emits a plain static site into dist/.
 *
 * No framework, no bundler — the site is one HTML file plus static assets.
 */
import { mkdir, readFile, writeFile, readdir, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "src");
const OUT = join(root, "dist");

const SITE_URL = process.env.SITE_URL || "https://vestyr.com";
// Public by design — Turnstile site keys are not secrets. Override at build
// time with TURNSTILE_SITE_KEY, or paste yours into the fallback below.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || "TURNSTILE_SITE_KEY_PLACEHOLDER";

const TITLE = "Vestyr — Independent B2B brand & marketing by Joshua Gallacher";
const DESCRIPTION =
  "Independent B2B brand and marketing practice. Sharper positioning, clearer marketing priorities and the finished work to put them into market.";

/** Everything under src/ that ships verbatim. */
const STATIC_FILES = ["wordmark.svg", "wordmark-light.svg", "favicon.svg", "og-image.jpg", "contact.js"];
const STATIC_DIRS = ["img"];

function head() {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${SITE_URL}/">
<meta name="theme-color" content="#202A35">
<meta name="color-scheme" content="light">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="favicon.svg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vestyr">
<meta property="og:url" content="${SITE_URL}/">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:image" content="${SITE_URL}/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Aerial view of broken sea ice on dark water.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESCRIPTION}">
<meta name="twitter:image" content="${SITE_URL}/og-image.jpg">`;
}

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = join(from, entry.name);
    const b = join(to, entry.name);
    if (entry.isDirectory()) await copyDir(a, b);
    else await copyFile(a, b);
  }
}

async function build() {
  const src = await readFile(join(SRC, "Main.dc.html"), "utf8");

  const styleMatch = src.match(/<helmet>([\s\S]*?)<\/helmet>/);
  const bodyMatch = src.match(/<x-dc>([\s\S]*?)<\/x-dc>/);
  const logicMatch = src.match(/<script data-dc-script[^>]*>([\s\S]*?)<\/script>/);
  if (!styleMatch || !bodyMatch || !logicMatch) {
    throw new Error("src/Main.dc.html is missing its <helmet>, <x-dc> or logic block");
  }

  const style = styleMatch[1];
  let body = bodyMatch[1]
    .replace(/<helmet>[\s\S]*?<\/helmet>/, "")
    .replace("{{accent}}", "#CCCB78")
    .replace("{{accentDeep}}", "#706F42");

  // Blocks that exist only to annotate the design canvas never ship.
  body = body.replace(/<div class="notewire" data-design-only>[\s\S]*?<\/div>/g, "");

  // The design canvas resolves images by bare filename from its own file map;
  // on disk they live in img/. Rewrite to real, relative production paths.
  const imageFiles = (await readdir(join(SRC, "img"))).map((f) => f.replace(/\.[^.]+$/, ""));
  for (const stem of imageFiles) {
    body = body.replaceAll(`src="${stem}.jpg"`, `src="img/${stem}.jpg"`);
  }
  if (/\{\{[^}]+\}\}/.test(body)) {
    throw new Error("unresolved template token left in markup: " + body.match(/\{\{[^}]+\}\}/)[0]);
  }

  const runtime = `<script>
class DCLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(p) { Object.assign(this.state, p); }
  forceUpdate() {}
}
${logicMatch[1]}
document.addEventListener("DOMContentLoaded", function () {
  new Component({ accent: "#CCCB78", motion: true }).componentDidMount();
});
</script>
<script>
window.VESTYR_TURNSTILE_SITE_KEY = ${JSON.stringify(TURNSTILE_SITE_KEY)};
// Defined inline so it exists before api.js executes, whatever order the
// deferred/async scripts resolve in.
window.vestyrTurnstileReady = function () {
  window.__vestyrTurnstileLoaded = true;
  if (window.__vestyrRenderTurnstile) window.__vestyrRenderTurnstile();
};
</script>
<script src="contact.js" defer></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=vestyrTurnstileReady&render=explicit" async defer></script>`;

  const html = `<!doctype html>
<html lang="en">
<head>
${head()}
${style}
</head>
<body>
${body}
${runtime}
</body>
</html>
`;

  if (existsSync(OUT)) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "index.html"), html, "utf8");

  for (const file of STATIC_FILES) {
    if (!existsSync(join(SRC, file))) throw new Error(`missing static asset: src/${file}`);
    await copyFile(join(SRC, file), join(OUT, file));
  }
  for (const dir of STATIC_DIRS) await copyDir(join(SRC, dir), join(OUT, dir));

  // Every src="…"/href="…" must resolve inside dist, apart from known externals.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const missing = refs
    .filter((r) => !/^(https?:|data:|mailto:|#|\/\/)/.test(r))
    .map((r) => r.replace(/^\//, ""))
    .filter((r) => r && !existsSync(join(OUT, r)));
  if (missing.length) throw new Error("asset reference(s) not present in dist: " + missing.join(", "));
  if (/localhost|127\.0\.0\.1|file:\/\//.test(html)) throw new Error("localhost reference in production HTML");

  console.log(`built dist/ — index.html (${(html.length / 1024).toFixed(0)} KB) + ${STATIC_FILES.length} files + img/`);
  if (TURNSTILE_SITE_KEY === "TURNSTILE_SITE_KEY_PLACEHOLDER") {
    console.warn("warning: Turnstile site key is still the placeholder — set TURNSTILE_SITE_KEY before deploying");
  }
}

build().catch((err) => {
  console.error("build failed:", err.message);
  process.exit(1);
});
