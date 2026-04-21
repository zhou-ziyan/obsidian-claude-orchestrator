import { readFileSync, writeFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const parts = pkg.version.split(".").map(Number);
parts[2]++;
const newVersion = parts.join(".");

pkg.version = newVersion;
writeFileSync("package.json", JSON.stringify(pkg, null, "\t") + "\n");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = newVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[newVersion] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.debug(`Bumped to ${newVersion}`);
