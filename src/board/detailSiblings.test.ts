import { describe, expect, it } from "vitest";
import { createDetailSiblingPager, detailSiblingPages } from "./detailSiblings";

const row = (id: string, status: string, project: string | null = "app") => ({ id, status, project });

describe("detailSiblingPages", () => {
  it("shows all open siblings but pages completed siblings", () => {
    const pages = detailSiblingPages([row("b", "queue"), row("a", "backlog"), row("d1", "done"), row("d2", "done"), row("else", "done", "other")], "app", null, 1);
    expect(pages.open.map((item) => item.id)).toEqual(["a", "b"]);
    expect(pages.visible.map((item) => item.id)).toEqual(["a", "b", "d1"]);
    expect(pages.hasMoreDone).toBe(true);
  });

  it("keeps the active completed sibling visible outside the current page", () => {
    const pages = detailSiblingPages([row("d1", "done"), row("d2", "done")], "app", "d2", 1);
    expect(pages.visible.map((item) => item.id)).toEqual(["d1", "d2"]);
  });

  it("keeps sorted ids while display-only row data changes", () => {
    const pager = createDetailSiblingPager<{ id: string; status: string; project: string | null; subject: string }>();
    const first = { ...row("b", "queue"), subject: "before" };
    const second = { ...row("a", "backlog"), subject: "first" };
    expect(pager.pages([first, second], "app", null).open.map((item) => item.subject)).toEqual(["first", "before"]);
    expect(pager.pages([{ ...first, subject: "after" }, second], "app", null).open.map((item) => item.subject)).toEqual(["first", "after"]);
  });

  it("can page siblings within one change instead of the whole project", () => {
    const rows = [
      { ...row("a", "backlog"), change_id: "c1" },
      { ...row("b", "queue"), change_id: "c1" },
      { ...row("outside", "in_progress"), change_id: "c2" },
      { ...row("none", "review"), change_id: undefined },
    ];
    const pages = detailSiblingPages(rows, "c1", "a", 50, "change");
    expect(pages.visible.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
