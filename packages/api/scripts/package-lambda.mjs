import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());
const distDir = path.join(root, "dist");
const outDir = path.join(distDir, "lambda");

const ensureDir = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
};

const copyRecursive = (src, dest) => {
  if (!fs.existsSync(src)) {
    throw new Error(`Missing path: ${src}`);
  }
  fs.cpSync(src, dest, { recursive: true });
};

const cleanDir = (dir) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
};

const findNodeModules = () => {
  const candidates = [
    path.join(root, "node_modules"),
    path.join(root, "..", "node_modules"),
    path.join(root, "..", "..", "node_modules")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("node_modules not found for packaging");
};

const packageFunction = (name, entryFile) => {
  const targetDir = path.join(outDir, name);
  cleanDir(targetDir);
  copyRecursive(path.join(distDir, entryFile), path.join(targetDir, entryFile));

  // Minimal Prisma runtime deps
  const nodeModulesDir = findNodeModules();
  copyRecursive(path.join(nodeModulesDir, "@prisma", "client"), path.join(targetDir, "node_modules", "@prisma", "client"));
  copyRecursive(path.join(nodeModulesDir, ".prisma"), path.join(targetDir, "node_modules", ".prisma"));
};

ensureDir(outDir);
packageFunction("events", "events-handler.js");
packageFunction("worker", "aggregation-worker.js");
