#!/usr/bin/env node
/**
 * StructureClaw packaging script.
 * Runs during `prepack` for both npm pack and npm publish.
 */
"use strict";

const { execSync } = require("node:child_process");
const { existsSync, lstatSync, realpathSync, mkdirSync, cpSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

function run(cmd, label) {
  console.log(`[sclaw] ${label}...`);
  try {
    execSync(cmd, { stdio: "inherit", cwd: rootDir, timeout: 300000 });
    console.log(`[sclaw] ${label} done.`);
  } catch (err) {
    console.error(`[sclaw] ${label} failed.`);
    process.exit(1);
  }
}

function clearBuildDirectory(relative) {
  const directory = path.resolve(rootDir, relative);
  if (path.relative(rootDir, directory).startsWith('..') || directory === rootDir) throw new Error('Invalid build directory / 构建目录无效');
  if (existsSync(directory)) {
    if (lstatSync(directory).isSymbolicLink() || path.relative(realpathSync(rootDir), realpathSync(directory)).startsWith('..')) {
      throw new Error(`Refusing linked build output / 不清理链接到外部的构建目录: ${directory}`);
    }
    rmSync(directory, { recursive: true });
  }
}

// Rebuild this source revision. File existence does not establish freshness.
run("npm run db:generate --prefix backend", "Generating database client / 生成数据库客户端");
clearBuildDirectory('backend/dist');
run("npm run build --prefix backend", "Building backend / 编译后端");
const backendDist = path.join(rootDir, "backend", "dist", "index.js");
if (!existsSync(backendDist)) {
  console.error("[sclaw] backend/dist/index.js not found after build.");
  process.exit(1);
}

// Static UI uses the installed server's origin, never a developer API address.
process.env.NEXT_PUBLIC_API_URL = '';
clearBuildDirectory('frontend/out');
run("npm run build --prefix frontend", "Building frontend / 编译网页");
const frontendOut = path.join(rootDir, "frontend", "out", "index.html");
if (!existsSync(frontendOut)) {
  console.error("[sclaw] frontend/out/index.html not found after build.");
  process.exit(1);
}

// Step 3: Clean and recreate dist/
clearBuildDirectory('dist');
mkdirSync(distDir, { recursive: true });

// Step 4: Copy built artifacts into dist/
console.log("[sclaw] Assembling dist/...");

// Backend compiled JS
const distBackend = path.join(distDir, "backend");
cpSync(path.join(rootDir, "backend", "dist"), distBackend, { recursive: true });

// Write package.json with "type": "module" so Node.js treats dist/backend/*.js as ESM
const backendPackageJson = JSON.stringify({ type: "module" }, null, 2) + "\n";
writeFileSync(path.join(distBackend, "package.json"), backendPackageJson, "utf8");
console.log("[sclaw] Wrote dist/backend/package.json (type: module)");

// Frontend static export
const distFrontend = path.join(distDir, "frontend");
cpSync(path.join(rootDir, "frontend", "out"), distFrontend, { recursive: true });

// Step 5: Validate
const checks = [
  path.join(distBackend, "index.js"),
  path.join(distBackend, "generated", "prisma", "client.js"),
  path.join(distFrontend, "index.html"),
  path.join(rootDir, "backend", "prisma", "schema.prisma"),
  path.join(rootDir, "sclaw"),
  path.join(rootDir, "sclaw_cn"),
];

let valid = true;
for (const file of checks) {
  if (!existsSync(file)) {
    console.error(`[sclaw] Missing: ${path.relative(rootDir, file)}`);
    valid = false;
  }
}

if (!valid) {
  console.error("[sclaw] Package validation failed.");
  process.exit(1);
}

console.log("[sclaw] Package ready for publishing.");
