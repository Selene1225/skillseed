/**
 * Tests for recall service (service/recall.ts)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("recall service", () => {
  let tmpDir: string;
  let origHome: string | (() => string);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillseed-test-"));
    origHome = os.homedir;
    (os as any).homedir = () => tmpDir;
  });

  afterEach(() => {
    (os as any).homedir = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns friendly hint when no experiences exist", async () => {
    const { recall } = await import("../src/service/recall.js");
    const result = recall({ query: "how to deploy" });
    expect(result.total).toBe(0);
    expect(result.hint).toBeTruthy();
    expect(result.hint).toContain("No experiences found");
  });

  it("recalls matching experiences", async () => {
    const { logExperience } = await import("../src/service/experience.js");
    const { recall } = await import("../src/service/recall.js");

    logExperience({ content: "Always rebase before merging feature branches into main", tags: ["git", "merge"] });
    logExperience({ content: "Run smoke tests before every deployment to staging", tags: ["deployment", "testing"] });
    logExperience({ content: "Use React hooks instead of class components for new features", tags: ["react", "frontend"] });

    const result = recall({ query: "deployment testing" });
    expect(result.total).toBeGreaterThan(0);
    expect(result.results[0].summary).toContain("deployment");
  });

  it("respects token budget", async () => {
    const { logExperience } = await import("../src/service/experience.js");
    const { recall } = await import("../src/service/recall.js");

    // Log many experiences with enough content to exceed a small budget
    for (let i = 0; i < 10; i++) {
      logExperience({ content: `Deploy tip number ${i}: always check logs after deployment step ${i} and verify the rollback plan is in place`, tags: ["deployment"] });
    }

    const allResults = recall({ query: "deployment", limit: 10 });
    const budgeted = recall({ query: "deployment", maxTokens: 100, limit: 10 });
    // Budget should return fewer results than unbounded
    expect(budgeted.total).toBeLessThan(allResults.total);
    expect(budgeted.total).toBeGreaterThan(0);
  });

  it("respects limit parameter", async () => {
    const { logExperience } = await import("../src/service/experience.js");
    const { recall } = await import("../src/service/recall.js");

    for (let i = 0; i < 10; i++) {
      logExperience({ content: `Git tip ${i}: always use meaningful branch names for feature development`, tags: ["git"] });
    }

    const result = recall({ query: "git branch", limit: 3 });
    expect(result.total).toBeLessThanOrEqual(3);
  });
});
