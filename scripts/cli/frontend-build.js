const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const runtime = require("./runtime");

const BUILD_STAMP = ".sclaw-build.json";

function frontendSourceHash(frontendDir) {
  const hash = createHash("sha256");
  function include(relative) {
    const absolute = path.join(frontendDir, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) include(path.join(relative, name));
    } else {
      hash.update(relative.replace(/\\/gu, "/")).update("\0").update(fs.readFileSync(absolute)).update("\0");
    }
  }
  for (const directory of ["src", "public", "scripts"]) include(directory);
  // Pure contracts imported by the browser are part of its build, even though they live in backend/.
  for (const contract of ["runtime/limits.ts", "shared/legacy-capabilities.ts"]) include(path.join("..", "backend", "src", contract));
  for (const name of fs.readdirSync(frontendDir).sort()) {
    if (name !== "next-env.d.ts" && (/\.(?:json|[cm]?js|ts)$/u.test(name) || name.startsWith(".env"))) include(name);
  }
  return hash.digest("hex");
}

function isFrontendBuildCurrent(paths) {
  try {
    if (!fs.existsSync(path.join(paths.frontendDir, "out", "index.html"))) return false;
    const stamp = JSON.parse(fs.readFileSync(path.join(paths.frontendDir, "out", BUILD_STAMP), "utf8"));
    return stamp.sourceHash === frontendSourceHash(paths.frontendDir);
  } catch { return false; }
}

async function runFrontendBuild(paths, env) {
  const sourceHash = frontendSourceHash(paths.frontendDir);
  const stampPath = path.join(paths.frontendDir, "out", BUILD_STAMP);
  fs.rmSync(stampPath, { force: true });
  const buildEnv = { ...env };
  // next build must see NODE_ENV=production; root .env often sets development for local runtime.
  buildEnv.NODE_ENV = "production";
  delete buildEnv.NEXT_PUBLIC_API_URL;
  if (runtime.isWindows()) {
    buildEnv.NODE_OPTIONS = "--require ./scripts/fs-rename-fallback.cjs";
  }
  await runtime.runCommand(runtime.getNpmCommand(), ["exec", "next", "build"], {
    cwd: paths.frontendDir,
    env: buildEnv,
  });
  fs.writeFileSync(stampPath, JSON.stringify({ sourceHash }));
}

module.exports = {
  frontendSourceHash,
  isFrontendBuildCurrent,
  runFrontendBuild,
};
