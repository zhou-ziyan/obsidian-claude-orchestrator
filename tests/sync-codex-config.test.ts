/**
 * Tests for scripts/sync-codex-config.sh — the one-way Claude → Codex config sync.
 *
 * Why the shape of this script is what it is, in one place (measured against
 * codex-cli 0.154.0-alpha.6.2 on 2026-09-16, see the EngineSync task note):
 *
 * - Codex loads skills from `$CODEX_HOME/skills`, `~/.agents/skills`,
 *   `<project>/.codex/skills` and `<project>/.agents/skills`. It does NOT read
 *   `<project>/.claude/skills`, which is where the vault keeps its skills — so
 *   without this sync Codex sees none of them.
 * - A skill DIRECTORY may be a symlink and still loads. A `SKILL.md` FILE that
 *   is a symlink is silently dropped. Hence: link directories, never files, and
 *   refuse to publish a skill whose SKILL.md is itself a link.
 * - Silent drops are the failure mode this script exists to prevent, so every
 *   condition it cannot fix is a hard error, never a skipped line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, lstatSync, readlinkSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sync-codex-config.sh");

interface Sandbox {
	root: string;
	vault: string;
	skillsSrc: string;
	codexHome: string;
	skillsDest: string;
	claudeMd: string;
	agentsMd: string;
}

/** A throwaway HOME-shaped tree: a vault with skills and an empty CODEX_HOME. */
function makeSandbox(skills: string[] = ["intake", "next-go"]): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "co-sync-"));
	const vault = join(root, "vault");
	const skillsSrc = join(vault, ".claude", "skills");
	const codexHome = join(root, "codex-home");
	mkdirSync(skillsSrc, { recursive: true });
	mkdirSync(codexHome, { recursive: true });
	const claudeMd = join(root, "claude", "CLAUDE.md");
	mkdirSync(dirname(claudeMd), { recursive: true });
	writeFileSync(claudeMd, "# Global Conventions\n\nmarker-v1\n");
	for (const name of skills) addSkill(skillsSrc, name);
	return { root, vault, skillsSrc, codexHome, skillsDest: join(codexHome, "skills"), claudeMd, agentsMd: join(codexHome, "AGENTS.md") };
}

function addSkill(skillsSrc: string, name: string, body = "do the thing"): string {
	const dir = join(skillsSrc, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${name}\n`);
	return dir;
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
	all: string;
}

function run(box: Sandbox, args: string[] = []): RunResult {
	const res = spawnSync("/bin/sh", [SCRIPT, "--vault", box.vault, ...args], {
		encoding: "utf-8",
		env: {
			...process.env,
			CODEX_HOME: box.codexHome,
			CO_SYNC_CLAUDE_MD: box.claudeMd,
		},
	});
	const stdout = res.stdout ?? "";
	const stderr = res.stderr ?? "";
	return { status: res.status ?? -1, stdout, stderr, all: stdout + stderr };
}

function cleanup(box: Sandbox): void {
	rmSync(box.root, { recursive: true, force: true });
}

/** What a published skill must look like: a symlink pointing at the real source dir. */
function assertLinkedTo(dest: string, expected: string): void {
	assert.ok(lstatSync(dest).isSymbolicLink(), `${dest} should be a symlink`);
	assert.equal(readlinkSync(dest), expected);
}

// ---------------------------------------------------------------------------
// Fresh sync
// ---------------------------------------------------------------------------

describe("sync-codex-config: fresh sync", () => {
	it("copies CLAUDE.md to AGENTS.md and links every skill", () => {
		const box = makeSandbox();
		try {
			const res = run(box);
			assert.equal(res.status, 0, res.all);
			assert.equal(readFileSync(box.agentsMd, "utf-8"), readFileSync(box.claudeMd, "utf-8"));
			assertLinkedTo(join(box.skillsDest, "intake"), join(box.skillsSrc, "intake"));
			assertLinkedTo(join(box.skillsDest, "next-go"), join(box.skillsSrc, "next-go"));
		} finally {
			cleanup(box);
		}
	});

	it("creates the skills destination when CODEX_HOME has none yet", () => {
		const box = makeSandbox(["dashboard"]);
		try {
			assert.equal(existsSync(box.skillsDest), false);
			assert.equal(run(box).status, 0);
			assert.ok(existsSync(join(box.skillsDest, "dashboard")));
		} finally {
			cleanup(box);
		}
	});

	it("resolves a skill that is itself a symlink to its real directory", () => {
		// The vault links .claude/skills/vault-report -> .agents/skills/vault-report.
		// Linking a link would work today but chains are a silent-breakage risk,
		// so the script is expected to publish the resolved real path.
		const box = makeSandbox(["intake"]);
		try {
			const real = join(box.vault, ".agents", "skills");
			addSkill(real, "vault-report");
			symlinkSync(join(real, "vault-report"), join(box.skillsSrc, "vault-report"));
			assert.equal(run(box).status, 0);
			assertLinkedTo(join(box.skillsDest, "vault-report"), join(real, "vault-report"));
		} finally {
			cleanup(box);
		}
	});
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe("sync-codex-config: idempotence", () => {
	it("is a no-op on the second run and says so", () => {
		const box = makeSandbox();
		try {
			assert.equal(run(box).status, 0);
			const second = run(box);
			assert.equal(second.status, 0, second.all);
			assert.match(second.all, /up to date/i);
			assert.doesNotMatch(second.all, /^link /im);
		} finally {
			cleanup(box);
		}
	});

	it("repoints a symlink that drifted to the wrong target", () => {
		const box = makeSandbox(["intake"]);
		try {
			assert.equal(run(box).status, 0);
			const dest = join(box.skillsDest, "intake");
			rmSync(dest);
			symlinkSync(join(box.root, "somewhere-else"), dest);
			const res = run(box);
			assert.equal(res.status, 0, res.all);
			assertLinkedTo(dest, join(box.skillsSrc, "intake"));
		} finally {
			cleanup(box);
		}
	});

	it("rewrites AGENTS.md when CLAUDE.md changed", () => {
		const box = makeSandbox(["intake"]);
		try {
			assert.equal(run(box).status, 0);
			writeFileSync(box.claudeMd, "# Global Conventions\n\nmarker-v2\n");
			assert.equal(run(box).status, 0);
			assert.match(readFileSync(box.agentsMd, "utf-8"), /marker-v2/);
		} finally {
			cleanup(box);
		}
	});
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("sync-codex-config: --dry-run", () => {
	it("reports the plan and writes nothing", () => {
		const box = makeSandbox();
		try {
			const res = run(box, ["--dry-run"]);
			assert.equal(res.status, 0, res.all);
			assert.match(res.all, /intake/);
			assert.match(res.all, /AGENTS\.md/);
			assert.equal(existsSync(box.agentsMd), false);
			assert.equal(existsSync(join(box.skillsDest, "intake")), false);
		} finally {
			cleanup(box);
		}
	});

	it("still fails loudly on a broken source instead of printing a plan", () => {
		const box = makeSandbox();
		try {
			rmSync(box.claudeMd);
			const res = run(box, ["--dry-run"]);
			assert.notEqual(res.status, 0);
		} finally {
			cleanup(box);
		}
	});
});

// ---------------------------------------------------------------------------
// Hard errors — every one of these is a case Codex would otherwise swallow
// ---------------------------------------------------------------------------

describe("sync-codex-config: missing sources are errors, not skips", () => {
	it("fails when CLAUDE.md does not exist, naming the path", () => {
		const box = makeSandbox();
		try {
			rmSync(box.claudeMd);
			const res = run(box);
			assert.notEqual(res.status, 0);
			assert.match(res.all, /CLAUDE\.md/);
			assert.equal(existsSync(box.agentsMd), false);
		} finally {
			cleanup(box);
		}
	});

	it("fails when the vault skills directory does not exist", () => {
		const box = makeSandbox();
		try {
			rmSync(box.skillsSrc, { recursive: true });
			const res = run(box);
			assert.notEqual(res.status, 0);
			assert.match(res.all, /skills/);
		} finally {
			cleanup(box);
		}
	});

	it("fails when the vault itself does not exist", () => {
		const box = makeSandbox();
		try {
			const res = spawnSync("/bin/sh", [SCRIPT, "--vault", join(box.root, "no-such-vault")], {
				encoding: "utf-8",
				env: { ...process.env, CODEX_HOME: box.codexHome, CO_SYNC_CLAUDE_MD: box.claudeMd },
			});
			assert.notEqual(res.status, 0);
		} finally {
			cleanup(box);
		}
	});

	it("fails when a skill directory has no SKILL.md, naming the skill", () => {
		const box = makeSandbox(["intake"]);
		try {
			mkdirSync(join(box.skillsSrc, "half-written"));
			const res = run(box);
			assert.notEqual(res.status, 0);
			assert.match(res.all, /half-written/);
		} finally {
			cleanup(box);
		}
	});

	it("fails when a skill's SKILL.md is a symlink — Codex drops those silently", () => {
		const box = makeSandbox(["intake"]);
		try {
			const dir = join(box.skillsSrc, "linked-md");
			mkdirSync(dir);
			const realMd = join(box.root, "real-SKILL.md");
			writeFileSync(realMd, "---\nname: linked-md\ndescription: x\n---\n");
			symlinkSync(realMd, join(dir, "SKILL.md"));
			const res = run(box);
			assert.notEqual(res.status, 0);
			assert.match(res.all, /linked-md/);
		} finally {
			cleanup(box);
		}
	});
});

// ---------------------------------------------------------------------------
// Destination safety
// ---------------------------------------------------------------------------

describe("sync-codex-config: destination safety", () => {
	it("refuses to clobber a real directory it did not create", () => {
		const box = makeSandbox(["intake"]);
		try {
			const dest = join(box.skillsDest, "intake");
			mkdirSync(dest, { recursive: true });
			writeFileSync(join(dest, "SKILL.md"), "hand-written\n");
			const res = run(box);
			assert.notEqual(res.status, 0);
			assert.match(res.all, /intake/);
			assert.equal(readFileSync(join(dest, "SKILL.md"), "utf-8"), "hand-written\n");
		} finally {
			cleanup(box);
		}
	});

	it("leaves Codex's own .system skills and unrelated skills alone", () => {
		const box = makeSandbox(["intake"]);
		try {
			const system = join(box.skillsDest, ".system", "skill-creator");
			mkdirSync(system, { recursive: true });
			writeFileSync(join(system, "SKILL.md"), "system\n");
			const foreign = join(box.skillsDest, "installed-elsewhere");
			mkdirSync(foreign, { recursive: true });
			writeFileSync(join(foreign, "SKILL.md"), "foreign\n");
			assert.equal(run(box).status, 0);
			assert.ok(existsSync(join(system, "SKILL.md")));
			assert.ok(existsSync(join(foreign, "SKILL.md")));
		} finally {
			cleanup(box);
		}
	});

	it("prunes its own stale link when a skill is deleted from the vault", () => {
		const box = makeSandbox(["intake", "retired"]);
		try {
			assert.equal(run(box).status, 0);
			assert.ok(existsSync(join(box.skillsDest, "retired")));
			rmSync(join(box.skillsSrc, "retired"), { recursive: true });
			const res = run(box);
			assert.equal(res.status, 0, res.all);
			assert.equal(existsSync(join(box.skillsDest, "retired")), false);
			assert.ok(existsSync(join(box.skillsDest, "intake")));
		} finally {
			cleanup(box);
		}
	});

	it("does not prune a symlink that points outside the vault skills root", () => {
		const box = makeSandbox(["intake"]);
		try {
			const other = join(box.root, "other-skill");
			mkdirSync(other, { recursive: true });
			writeFileSync(join(other, "SKILL.md"), "other\n");
			assert.equal(run(box).status, 0);
			symlinkSync(other, join(box.skillsDest, "other-skill"));
			assert.equal(run(box).status, 0);
			assert.ok(existsSync(join(box.skillsDest, "other-skill")));
		} finally {
			cleanup(box);
		}
	});
});

// ---------------------------------------------------------------------------
// --copy mode: for when the vault lives on iCloud and links are not wanted
// ---------------------------------------------------------------------------

describe("sync-codex-config: --copy", () => {
	it("copies real directories instead of linking, and stays idempotent", () => {
		const box = makeSandbox(["intake"]);
		try {
			assert.equal(run(box, ["--copy"]).status, 0);
			const dest = join(box.skillsDest, "intake");
			assert.equal(lstatSync(dest).isSymbolicLink(), false);
			assert.match(readFileSync(join(dest, "SKILL.md"), "utf-8"), /name: intake/);
			const second = run(box, ["--copy"]);
			assert.equal(second.status, 0, second.all);
			assert.equal(readdirSync(box.skillsDest).length, 1);
		} finally {
			cleanup(box);
		}
	});

	it("replaces a link left by a previous link-mode run", () => {
		const box = makeSandbox(["intake"]);
		try {
			assert.equal(run(box).status, 0);
			assert.ok(lstatSync(join(box.skillsDest, "intake")).isSymbolicLink());
			assert.equal(run(box, ["--copy"]).status, 0);
			assert.equal(lstatSync(join(box.skillsDest, "intake")).isSymbolicLink(), false);
		} finally {
			cleanup(box);
		}
	});

	it("refreshes copied content when the source changed", () => {
		const box = makeSandbox(["intake"]);
		try {
			assert.equal(run(box, ["--copy"]).status, 0);
			writeFileSync(join(box.skillsSrc, "intake", "SKILL.md"), "---\nname: intake\ndescription: changed-v2\n---\n");
			assert.equal(run(box, ["--copy"]).status, 0);
			assert.match(readFileSync(join(box.skillsDest, "intake", "SKILL.md"), "utf-8"), /changed-v2/);
		} finally {
			cleanup(box);
		}
	});
});
