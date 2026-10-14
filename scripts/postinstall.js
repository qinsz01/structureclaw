#!/usr/bin/env node
"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");

function main() {
  const rootDir = path.resolve(__dirname, "..");
  // Developers generate before compiling; installs use the compiled client.
  if (existsSync(path.join(rootDir, "frontend", "package.json"))) return;
  for (const asset of ["dist/backend/index.js", "dist/backend/generated/prisma/client.js", "dist/frontend/index.html", "backend/prisma/schema.prisma"]) {
    if (!existsSync(path.join(rootDir, asset))) {
      throw new Error(`Incomplete StructureClaw package / StructureClaw 安装包不完整: ${asset}`);
    }
  }
  console.log("[sclaw] Runtime assets verified. Run sclaw doctor / 运行资源已检查，请执行 sclaw doctor。");
}

main();
