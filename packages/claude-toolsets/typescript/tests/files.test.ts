import { describe, expect, it } from "vitest";
import type { BetaFilePolicy, BetaURLContext } from "@anthropic-ai/sdk/helpers/beta/toolsets";
import { DaytonaFilePolicy, isUnder } from "../src/files.js";

describe("Daytona file policy", () => {
  const context = { member: "file_upload" } satisfies BetaURLContext;

  it.each([
    ["/etc/shadow", "/", false],
    ["/", "/", false],
    ["/etc/shadow", "//", false],
    ["/tmp/up", "/tmp/up/", true],
    ["/tmp/up/a.txt", "/tmp/up/", true],
    ["/tmp/up", "/tmp/up", true],
    ["/tmp/upload/a.txt", "/tmp/up", false],
    ["/tmp/up-other", "/tmp/up", false],
    ["/tmp/up.txt", "/tmp/up", false],
    ["/tmp/up/../etc/passwd", "/tmp/up", false],
    ["/etc/passwd", "/tmp/up/..", false],
    ["tmp/up/a.txt", "/tmp/up", false],
    ["/tmp/up/a.txt", "tmp/up", false],
  ] satisfies readonly [string, string, boolean][])(
    "compares whole POSIX path components: %s under %s is %s",
    (path, root, contained) => {
      expect(isUnder(path, root)).toBe(contained);
    },
  );

  it("refuses filesystem roots, including roots that normalize to /", () => {
    expect(() => new DaytonaFilePolicy({ uploadRoots: ["/"] })).toThrow(/filesystem root/);
    expect(() => new DaytonaFilePolicy({ uploadRoots: ["////"] })).toThrow(/filesystem root/);
    expect(isUnder("/etc/passwd", "/")).toBe(false);
  });

  it("admits normalized upload paths under configured roots", async () => {
    const policy = new DaytonaFilePolicy({ uploadRoots: ["/task/uploads/"] });
    await expect(
      policy.resolveUploadPaths(context, ["/task/uploads/a.txt", "/task/uploads//b/c"]),
    ).resolves.toEqual(["/task/uploads/a.txt", "/task/uploads/b/c"]);
  });

  it.each(["/etc/passwd", "/task/uploads/../secret", "relative.txt", "/task/uploads-other/x"])(
    "refuses upload path %s outside the roots",
    async (path) => {
      const policy = new DaytonaFilePolicy({ uploadRoots: ["/task/uploads"] });
      await expect(policy.resolveUploadPaths(context, [path])).rejects.toThrow();
    },
  );

  it("refuses path uploads without roots and all Files API documents", async () => {
    await expect(new DaytonaFilePolicy().resolveUploadPaths(context, ["/x"])).rejects.toThrow();
    await expect(
      new DaytonaFilePolicy({ uploadRoots: ["/x"] }).resolveUploadDocuments(context, ["file_1"]),
    ).rejects.toThrow();
  });

  it("validates roots and download-directory overlap", () => {
    expect(() => new DaytonaFilePolicy({ uploadRoots: ["relative"] })).toThrow(/absolute path/);
    expect(() => new DaytonaFilePolicy({ uploadRoots: ["/task"] })).not.toThrow();
    expect(() => new DaytonaFilePolicy({ uploadRoots: ["/task"], downloadDir: "/task/downloads" })).toThrow(
      /outside every upload root/,
    );
    expect(() => new DaytonaFilePolicy({ uploadRoots: ["/safe/../private"] })).toThrow(/must not contain/);
    expect(() => new DaytonaFilePolicy({ downloadDir: "/safe/../private" })).toThrow(/must not contain/);
  });

  it("binds an unbound policy to a download directory and exposes only safe paths", async () => {
    const policy = new DaytonaFilePolicy({ uploadRoots: ["/uploads"], exposeDownloadPaths: true });
    const bound = DaytonaFilePolicy.forDownloadDir(policy, "/dl");
    const interfacePolicy: BetaFilePolicy = bound;
    expect(interfacePolicy).toBe(bound);
    await expect(bound.isPathVisible("/dl/x")).resolves.toBe(true);
    await expect(bound.isPathVisible("/dl/../etc/passwd")).resolves.toBe(false);
    await expect(bound.isPathVisible("/dl-other/x")).resolves.toBe(false);
    expect(DaytonaFilePolicy.forDownloadDir(bound, "/other")).toBe(bound);
  });

  it("refuses a filesystem-root download directory", () => {
    // `isUnder` refuses every filesystem-root argument, so "/" would pass the overlap check
    // vacuously and then make isPathVisible hide every download.
    expect(() => new DaytonaFilePolicy({ uploadRoots: ["/uploads"], downloadDir: "/" })).toThrow(RangeError);
    expect(() => new DaytonaFilePolicy({ downloadDir: "///" })).toThrow(/filesystem root/);
    expect(() => DaytonaFilePolicy.forDownloadDir(new DaytonaFilePolicy({ uploadRoots: ["/uploads"] }), "/")).toThrow(RangeError);
  });
});
