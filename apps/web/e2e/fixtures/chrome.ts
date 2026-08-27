/**
 * Resolve a chromium binary WITHOUT pinning one (#437).
 *
 * playwright-core's registry and the browser actually downloaded disagree on
 * this workspace — the registry wants chromium-1223 and 1228 is what is in the
 * cache — so BOTH "trust the registry" and "hardcode the path" are wrong. The
 * registry is asked first because it is right whenever the install is coherent,
 * and the cache scan is the fallback for when it is not. An absolute path in
 * source is never acceptable: it pins the suite to one operator's home
 * directory, and the review protocol requires the evidence to come off the
 * build box.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveChrome(chromium: { executablePath(): string }): string {
  const override = process.env.T3_E2E_CHROME;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`T3_E2E_CHROME points at a file that does not exist: ${override}`);
    }
    return override;
  }

  try {
    const fromRegistry = chromium.executablePath();
    if (fromRegistry && fs.existsSync(fromRegistry)) return fromRegistry;
  } catch {
    // The registry throws when the pinned revision was never downloaded. That
    // is the normal case here, not an error worth propagating.
  }

  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    path.join(
      os.homedir(),
      process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright",
    );
  if (!fs.existsSync(cache)) {
    throw new Error(
      `no playwright browser cache at ${cache}. Install one with ` +
        `\`node_modules/.bin/playwright install chromium\` or set T3_E2E_CHROME.`,
    );
  }

  // Linux tails matter: the build box is Linux and the mac-only tails are why
  // the previous rig could not run there at all.
  const tails = [
    "chrome-linux/chrome",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-win/chrome.exe",
  ];
  const builds = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .sort()
    .reverse();
  for (const dir of builds) {
    for (const tail of tails) {
      const candidate = path.join(cache, dir, tail);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `no chromium build found under ${cache} (looked at: ${builds.join(", ") || "nothing"})`,
  );
}
