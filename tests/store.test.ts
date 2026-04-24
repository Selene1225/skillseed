/**
 * Tests for file store (store/file-store.ts)
 * Uses a temp directory to avoid polluting ~/.skillseed/
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We test by calling the service layer which uses the store
// For isolated tests, we set up a temp SKILLSEED dir via env or direct manipulation

describe("file-store integration", () => {
  let tmpDir: string;
  let origHome: string;

  beforeEach(() => {
    // Create a temp home to isolate ~/.skillseed/
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillseed-test-"));
    origHome = os.homedir;
    // Override homedir for test isolation
    (os as any).homedir = () => tmpDir;
  });

  afterEach(() => {
    (os as any).homedir = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads an experience", async () => {
    // Dynamic import to pick up overridden homedir
    const store = await import("../src/store/file-store.js");
    
    const meta = {
      scope: "universal" as const,
      sensitivity: "public" as const,
      category: "good_practice" as const,
      tags: ["git", "commit"],
      confidence: 0.9,
      source: "manual" as const,
      created: "2025-01-01",
      updated: "2025-01-01",
      used: 0,
    };

    const exp = store.writeExperience(meta, "Use imperative mood in git commits");
    expect(exp.id).toContain("universal/");
    expect(exp.content).toBe("Use imperative mood in git commits");

    const read = store.readExperience(exp.filePath);
    expect(read).not.toBeNull();
    expect(read!.content).toBe("Use imperative mood in git commits");
    expect(read!.meta.scope).toBe("universal");
    expect(read!.meta.tags).toContain("git");
  });

  it("searches by keyword", async () => {
    const store = await import("../src/store/file-store.js");
    
    const date = "2025-01-01";
    store.writeExperience({
      scope: "universal", sensitivity: "public", category: "good_practice",
      tags: ["git"], confidence: 0.9, source: "manual", created: date, updated: date, used: 0,
    }, "Always rebase before merging feature branches");

    store.writeExperience({
      scope: "universal", sensitivity: "public", category: "knowledge",
      tags: ["deployment"], confidence: 0.8, source: "manual", created: date, updated: date, used: 0,
    }, "Run smoke tests before every deployment");

    const results = store.search({ query: "rebase merge" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].experience.content).toContain("rebase");
  });

  it("manages preferences", async () => {
    const store = await import("../src/store/file-store.js");
    
    store.setPreference("language", "zh-CN");
    expect(store.getPreference("language")).toBe("zh-CN");

    store.setPreference("language", "en-US");
    expect(store.getPreference("language")).toBe("en-US");

    const all = store.getAllPreferences();
    expect(all.language).toBe("en-US");
  });
});
