import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shellCommandArgv,
  shellArgvCandidates,
  execMessageLooksLikeMissingExecutable,
} from "../src/commands/pod-console.js";

describe("pod-console shell argv", () => {
  describe("shellCommandArgv", () => {
    it("defaults empty to bash", () => {
      assert.deepEqual(shellCommandArgv(""), ["/bin/bash"]);
      assert.deepEqual(shellCommandArgv("   "), ["/bin/bash"]);
    });

    it("maps named shells", () => {
      assert.deepEqual(shellCommandArgv("bash"), ["/bin/bash"]);
      assert.deepEqual(shellCommandArgv("BASH"), ["/bin/bash"]);
      assert.deepEqual(shellCommandArgv("sh"), ["/bin/sh"]);
      assert.deepEqual(shellCommandArgv("ash"), ["/bin/sh"]);
      assert.deepEqual(shellCommandArgv("auto"), ["/bin/sh"]);
    });

    it("uses absolute paths as a single argv entry", () => {
      assert.deepEqual(shellCommandArgv("/usr/bin/zsh"), ["/usr/bin/zsh"]);
      assert.deepEqual(shellCommandArgv("/bin/busybox"), ["/bin/busybox"]);
    });

    it("maps unknown short names under /bin/", () => {
      assert.deepEqual(shellCommandArgv("zsh"), ["/bin/zsh"]);
    });
  });

  describe("shellArgvCandidates (bash default → fallback chain)", () => {
    it("uses bash, ash, sh when shell is default bash", () => {
      assert.deepEqual(shellArgvCandidates("bash"), [
        ["/bin/bash"],
        ["/bin/ash"],
        ["/bin/sh"],
      ]);
      assert.deepEqual(shellArgvCandidates(""), [
        ["/bin/bash"],
        ["/bin/ash"],
        ["/bin/sh"],
      ]);
    });

    it("uses a single argv for non-bash explicit shells", () => {
      assert.deepEqual(shellArgvCandidates("sh"), [["/bin/sh"]]);
      assert.deepEqual(shellArgvCandidates("auto"), [["/bin/sh"]]);
      assert.deepEqual(shellArgvCandidates("zsh"), [["/bin/zsh"]]);
    });
  });
});

describe("execMessageLooksLikeMissingExecutable", () => {
  it("detects missing binary from apiserver message", () => {
    assert.equal(
      execMessageLooksLikeMissingExecutable(
        'exec: "/bin/bash": stat /bin/bash: no such file or directory',
      ),
      true,
    );
    assert.equal(
      execMessageLooksLikeMissingExecutable(
        "executable file not found in $PATH",
      ),
      true,
    );
  });

  it("does not treat unrelated failures as missing binary", () => {
    assert.equal(execMessageLooksLikeMissingExecutable("connection refused"), false);
    assert.equal(execMessageLooksLikeMissingExecutable(undefined), false);
    assert.equal(execMessageLooksLikeMissingExecutable(""), false);
  });
});
