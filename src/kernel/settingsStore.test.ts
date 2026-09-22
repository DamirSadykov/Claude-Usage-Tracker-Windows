import { describe, it, expect, vi, beforeEach } from "vitest";

const reload = vi.fn(async () => {});
const get = vi.fn(async () => undefined);
const del = vi.fn(async () => false);
const save = vi.fn(async () => {});
const load = vi.fn(async () => ({ reload, get, delete: del, save }));

vi.mock("@tauri-apps/plugin-store", () => ({ load }));

import { loadSettingsStoreForWrite, readSettingsSnapshot } from "./settingsStore";

describe("settingsStore write/read split (t#733)", () => {
    beforeEach(() => {
        reload.mockClear();
        get.mockClear();
        del.mockClear();
        save.mockClear();
        load.mockClear();
    });

    it("loadSettingsStoreForWrite reloads the store before returning it", async () => {
        const store = await loadSettingsStoreForWrite();
        expect(load).toHaveBeenCalledWith("settings.json");
        expect(reload).toHaveBeenCalledTimes(1);
        expect(store.reload).toBe(reload);
    });

    it("readSettingsSnapshot does not reload the shared cache", async () => {
        await readSettingsSnapshot();
        expect(load).toHaveBeenCalledWith("settings.json");
        expect(reload).not.toHaveBeenCalled();
    });
});
