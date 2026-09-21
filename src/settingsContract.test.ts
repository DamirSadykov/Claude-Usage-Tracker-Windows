import { describe, expect, it } from "vitest";
import {
    DIRECT_KEYS,
    SNAPSHOT_KEYS,
    defaultSettings,
    type SettingsSnapshot,
} from "./settingsStore";

type ContractKey = {
    key: string;
    scope: "ui" | "shared" | "hook";
    readers: string[];
    default?: unknown;
    defaultFrom?: string;
};

const contractModules = import.meta.glob<{ default: { keys: ContractKey[]; legacy: Array<{ key: string }> } }>(
    "../scripts/cli/settings-contract.json",
    { eager: true },
);
const contract = contractModules["../scripts/cli/settings-contract.json"].default;

const sorted = (keys: Iterable<string>) => [...keys].sort();
const UI_KEYS = new Set([...SNAPSHOT_KEYS, ...DIRECT_KEYS]);
const SNAPSHOT_FIELD_BY_KEY: Record<string, string> = {
    thresholdsSession: "sessionThresholds",
    thresholdsWeekly: "weeklyThresholds",
};

const AGENTS_STORE_KEYS = ["profiles", "hooks", "criticMode", "version", "duties"];
const MIGRATABLE_OR_REMOVED_KEYS = new Set([
    ...contract.legacy.map(({ key }) => key),
    ...AGENTS_STORE_KEYS,
]);

const sourceModules = import.meta.glob<string>("./**/*.{ts,vue}", {
    eager: true,
    query: "?raw",
    import: "default",
});

describe("settings.json UI contract", () => {
    it("lists exactly the contract keys read by the UI, with no hook key", () => {
        const contractUiKeys = contract.keys
            .filter(({ readers }) => readers.includes("ui"))
            .map(({ key }) => key);
        const hookKeys = contract.keys
            .filter(({ scope }) => scope === "hook")
            .map(({ key }) => key);

        expect(sorted(UI_KEYS)).toEqual(sorted(contractUiKeys));
        expect([...UI_KEYS].filter((key) => hookKeys.includes(key))).toEqual([]);
        expect(sorted(Object.keys(defaultSettings()))).toEqual(
            sorted(SNAPSHOT_KEYS.map((key) => SNAPSHOT_FIELD_BY_KEY[key] ?? key)),
        );
    });

    it("keeps snapshot defaults equal to recorded literal defaults", () => {
        const defaults = defaultSettings();
        for (const key of contract.keys.filter(({ key: name, default: value }) =>
            SNAPSHOT_KEYS.includes(name as typeof SNAPSHOT_KEYS[number]) && value !== undefined,
        )) {
            const field = SNAPSHOT_FIELD_BY_KEY[key.key] ?? key.key;
            expect(defaults[field as keyof SettingsSnapshot], key.key).toEqual(key.default);
        }
    });

    it("does not allow a literal settings-store read or write outside the contract", () => {
        const literals = new Set<string>();
        for (const source of Object.values(sourceModules)) {
            for (const match of source.matchAll(/(?:store\.(?:get|set|delete)(?:<[^()]*>)?|\bget<[^()]*>)\(\s*["']([^"']+)["']/g)) {
                literals.add(match[1]);
            }
        }

        const allowed = new Set([...UI_KEYS, ...MIGRATABLE_OR_REMOVED_KEYS]);
        expect(
            sorted([...literals].filter((key) => !allowed.has(key))),
            "uncontracted store key(s)",
        ).toEqual([]);
    });
});
