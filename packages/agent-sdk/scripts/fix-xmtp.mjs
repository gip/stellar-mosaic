// The @xmtp/node-bindings 1.10.0 darwin binaries published to npm were built in a nix sandbox and
// hardcode a /nix/store/... libiconv install path that doesn't exist on normal machines, so dlopen
// fails. Rewrite the load command to the system libiconv and ad-hoc re-sign. Idempotent; runs
// before setup/demo (and is harmless on other platforms or fixed binaries).

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
let bindingsDir;
try {
  // Resolve through the workspace's pnpm symlinks: node-sdk -> its node-bindings dependency.
  const nodeSdk = realpathSync(join(here, "../node_modules/@xmtp/node-sdk"));
  bindingsDir = realpathSync(join(nodeSdk, "node_modules/@xmtp/node-bindings"));
} catch {
  process.exit(0); // not installed (yet)
}

const binary = join(bindingsDir, "dist", `bindings_node.darwin-${process.arch}.node`);
if (!existsSync(binary)) process.exit(0);

const deps = execFileSync("otool", ["-L", binary], { encoding: "utf8" });
const nixDep = deps.split("\n").find((l) => l.includes("/nix/store/") && l.includes("libiconv"));
if (!nixDep) process.exit(0);

const nixPath = nixDep.trim().split(" ")[0];
execFileSync("install_name_tool", ["-change", nixPath, "/usr/lib/libiconv.2.dylib", binary]);
execFileSync("codesign", ["-f", "-s", "-", binary]);
console.log(`fixed libiconv path in ${binary}`);
