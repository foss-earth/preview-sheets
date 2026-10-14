import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const owner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf("="); assert.ok(arg.startsWith("--") && at > 2, "Use --name=value"); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = path.resolve(args.out ?? path.join(owner, "build", "installed-consumer", stamp));
assert.ok(output.startsWith(path.join(owner, "build") + path.sep), "Evidence must stay inside this owner's build/");
const workspace = path.join(output, "workspace");
mkdirSync(output, { recursive: true }); mkdirSync(workspace); // fail rather than overwrite prior evidence
const dependencies = {}, pins = {};
for (const [key, name, version] of [["preview", "@foss-earth/preview-sheets", "0.1.0"], ["images", "@foss-earth/images", "0.1.0"], ["cubemap", "@foss-earth/sphere-cubemap", "0.1.0"], ["ui", "@foss-earth/ui", "0.1.0"], ["jpeg", "jpeg-js", "0.4.4"], ["typescript", "typescript", "5.9.3"]]) {
  assert.ok(args[key] && /^[a-f0-9]{64}$/.test(args[`${key}-sha256`] ?? ""), `Supply exact --${key} archive and --${key}-sha256`);
  const artifact = path.resolve(args[key]), bytes = readFileSync(artifact);
  const sha256 = createHash("sha256").update(bytes).digest("hex"); assert.equal(sha256, args[`${key}-sha256`]);
  dependencies[name] = `file:${artifact}`; pins[name] = { artifact, sha256, bytes: bytes.length, version };
}
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "preview-installed-fixture", version: "1.0.0", private: true, type: "module", dependencies }, null, 2));
const run = (command, argv, log) => {
  const filename = path.join(output, log), fd = openSync(filename, "wx"); let result;
  const env = { ...process.env, TMPDIR: output, npm_config_cache: path.join(output, "npm-cache") }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  try { result = spawnSync(command, argv, { cwd: workspace, env, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error; assert.equal(result.status, 0, `Inspect ${filename}`);
  return readFileSync(filename, "utf8");
};
run("npm", ["install", "--offline", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--cache", path.join(output, "npm-cache")], "install.log");
const physicalWorkspace = realpathSync(workspace) + path.sep;
for (const [name, pin] of Object.entries(pins)) {
  const packageDirectory = realpathSync(path.join(workspace, "node_modules", name));
  const manifestPath = realpathSync(path.join(packageDirectory, "package.json"));
  assert.ok(packageDirectory.startsWith(physicalWorkspace), `${name} physical package escapes isolated workspace`);
  assert.ok(manifestPath.startsWith(packageDirectory + path.sep), `${name} physical manifest escapes its package`);
  const installed = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(installed.name, name); assert.equal(installed.version, pin.version);
}
run(process.execPath, [path.join(owner, "scripts", "check-installed-artifact.mjs"), workspace, pins["@foss-earth/preview-sheets"].artifact], "runtime.log");
writeFileSync(path.join(workspace, "consumer.ts"), readFileSync(path.join(owner, "tests", "consumer.ts")));
writeFileSync(path.join(workspace, "pure.ts"), 'import { PREVIEW_SHEETS_EXTENSION, sheetSourceKey } from "@foss-earth/preview-sheets"; import { sheetFaceRectangles } from "@foss-earth/preview-sheets/core"; import { validatePreviewSheets } from "@foss-earth/preview-sheets/schema"; void [PREVIEW_SHEETS_EXTENSION, sheetSourceKey, sheetFaceRectangles, validatePreviewSheets];\n');
// Common owner declarations name the standard AbortSignal contract. DOM
// typings supply that contract; runtime pure imports still forbid DOM access.
for (const [name, lib] of [["pure", ["ES2023", "DOM"]], ["consumer", ["ES2023", "DOM", "DOM.Iterable"]]]) {
  const config = path.join(workspace, `tsconfig.${name}.json`);
  writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", lib, types: [], strict: true, skipLibCheck: false, noEmit: true, incremental: true, tsBuildInfoFile: `node_modules/.tmp/${name}.tsbuildinfo` }, include: [`${name}.ts`] }));
  const trace = run(process.execPath, [path.join(workspace, "node_modules", "typescript", "bin", "tsc"), "-p", config, "--traceResolution"], `${name}-types.log`);
  for (const match of trace.matchAll(/successfully resolved to '([^']+)'/g)) assert.ok(realpathSync(match[1]).startsWith(physicalWorkspace), "Declaration resolution escaped isolated workspace");
}
const receipt = { pins, runtime: { node: process.version, platform: process.platform, arch: process.arch }, checks: ["exact offline archives", "installed physical package names/versions/realpaths", "realpath guarded runtime with outside negative control", "no renderer/Babylon/React initialization", "public core/schema/browser/preparation/settings/scene-extension/composition/composition-node and schema assets", "actual sheet dedup/conflict/reversible alias/content verification/bounded memory/work/pixels/cancellation", "common broker/shared decode/fallback/cubemap readiness and host settlement", "published face retain through synchronous upload cancellation and throwing late output cleanup with ordered errors", "full strict pure/public declarations with standard AbortSignal DOM typings"], limitations: ["local source candidate only", "no DOM-free declaration or GPU/device qualification", "shared conformance and remote admission require separate coordinator receipts"] };
writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify({ output, receipt }));
