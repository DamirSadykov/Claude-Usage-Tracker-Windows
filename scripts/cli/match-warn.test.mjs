// Unit tests for the task-event notify (`notifyTaskEvent`, t#250) — the PUBLIC
// half of the preventive match-plan channel. The tracker's whole job here is the
// contract: hand the event to the configured kb-style CLI with the right argv,
// detached for add/queue, inline with stdout passthrough for in_progress, and
// never let a failure become a gate. Matching, dedup and comment posting are the
// configured CLI's business and are NOT tested here.

import { describe, it, expect } from "vitest";
import { notifyTaskEvent } from "./todos.mjs";

const todo = { id: "task-uuid", number: 7, subject: "s" };

describe("notifyTaskEvent", () => {
  it("does nothing when no match CLI is configured", () => {
    const boom = () => {
      throw new Error("must not be called");
    };
    notifyTaskEvent(todo, "add", { cli: "", exec: boom, spawner: boom });
  });

  it("spawns add/queue DETACHED with the contract argv", () => {
    for (const event of ["add", "queue"]) {
      let seen;
      notifyTaskEvent(todo, event, {
        cli: "/kb/kb.mjs",
        trackerCli: "/tracker/cli.mjs",
        exec: () => {
          throw new Error("inline exec must not be used");
        },
        spawner: (_exe, args, opts) => {
          seen = { args, opts };
          return { unref() {} };
        },
      });
      expect(seen.args[0]).toBe("/kb/kb.mjs");
      expect(seen.args).toContain("match-warn");
      expect(seen.args[seen.args.indexOf("--todo") + 1]).toBe("task-uuid");
      expect(seen.args[seen.args.indexOf("--event") + 1]).toBe(event);
      expect(seen.args[seen.args.indexOf("--tracker-cli") + 1]).toBe("/tracker/cli.mjs");
      expect(seen.opts.detached).toBe(true);
      expect(seen.opts.stdio).toBe("ignore");
    }
  });

  it("runs in_progress INLINE and passes the CLI's stdout through", () => {
    let seen;
    const writes = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => writes.push(s);
    try {
      notifyTaskEvent(todo, "in_progress", {
        cli: "/kb/kb.mjs",
        trackerCli: "/tracker/cli.mjs",
        spawner: () => {
          throw new Error("detached spawn must not be used");
        },
        exec: (_exe, args) => {
          seen = args;
          return "warn line 1\nwarn line 2\n";
        },
      });
    } finally {
      process.stdout.write = orig;
    }
    expect(seen[seen.indexOf("--event") + 1]).toBe("in_progress");
    expect(writes.join("")).toContain("warn line 1\nwarn line 2");
  });

  it("prints nothing when the inline run returns only whitespace", () => {
    const writes = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => writes.push(s);
    try {
      notifyTaskEvent(todo, "in_progress", {
        cli: "/kb/kb.mjs",
        exec: () => "  \n ",
      });
    } finally {
      process.stdout.write = orig;
    }
    expect(writes).toEqual([]);
  });

  it("swallows CLI failures — warnings are an extra, never a gate", () => {
    notifyTaskEvent(todo, "in_progress", {
      cli: "/kb/kb.mjs",
      exec: () => {
        throw new Error("timeout");
      },
    });
    notifyTaskEvent(todo, "add", {
      cli: "/kb/kb.mjs",
      spawner: () => {
        throw new Error("spawn failed");
      },
    });
  });
});
