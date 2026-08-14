import type { StorageContext } from '@/context/storage-context/storage-context';
import { diagramSchema } from '@/lib/domain/diagram';
import type { Diagram } from '@/lib/domain/diagram';
import { LIVE_SYNC_URL } from '@/lib/env';

const diagramUrl = (id: string): string =>
    `${LIVE_SYNC_URL.replace(/\/$/, '')}/diagrams/${id}`;

// Unlike diagramToJSONOutput/diagramFromJSONInput (built for user-facing
// import/export, which deliberately regenerate every id via
// cloneDiagramWithIds so pasted/imported diagrams never collide with what's
// already on the canvas), live sync needs the *same* ids to survive the
// round trip so a poll can diff "what changed" by id. A plain JSON
// round-trip does that; only the top-level Date fields need manual
// coercion, since DBTable/DBRelationship etc. store their own timestamps as
// epoch numbers, not Date.
const parseLiveDiagram = (json: string): Diagram => {
    const raw = JSON.parse(json);

    return diagramSchema.parse({
        ...raw,
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
    });
};

export const pushDiagram = async (diagram: Diagram): Promise<void> => {
    if (!LIVE_SYNC_URL) {
        return;
    }

    await fetch(diagramUrl(diagram.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(diagram),
    });
};

export const pullDiagram = async (
    diagramId: string
): Promise<Diagram | undefined> => {
    if (!LIVE_SYNC_URL) {
        return undefined;
    }

    const url = diagramUrl(diagramId);
    const response = await fetch(url, { cache: 'no-store' });

    if (response.status === 404) {
        return undefined;
    }

    if (!response.ok) {
        throw new Error(`${url}: ${response.status}`);
    }

    return parseLiveDiagram(await response.text());
};

// One saved generation of the shared diagram. The server keeps one per day
// and reports the counts so the picker can show what a generation holds
// without downloading every one of them.
export interface DiagramSnapshot {
    ts: string;
    tables: number;
    areas: number;
    notes: number;
    size: number;
}

export const listSnapshots = async (
    diagramId: string
): Promise<DiagramSnapshot[]> => {
    if (!LIVE_SYNC_URL) {
        return [];
    }

    const url = `${diagramUrl(diagramId)}/snapshots`;
    const response = await fetch(url, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(`${url}: ${response.status}`);
    }

    return (await response.json()) as DiagramSnapshot[];
};

// Restoring replaces the file every browser polls, so it reaches everyone on
// their next poll rather than only the person who asked for it.
export const restoreSnapshot = async (
    diagramId: string,
    ts: string
): Promise<void> => {
    if (!LIVE_SYNC_URL) {
        return;
    }

    const url = `${diagramUrl(diagramId)}/restore`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts }),
    });

    if (!response.ok) {
        throw new Error(`${url}: ${response.status}`);
    }
};

// A browser that has never opened this diagram has nothing in local storage
// for it, so the editor would give up before useLiveSync ever gets a
// diagramId to poll with. Seeding storage from the sync server is what lets
// a second person join by opening the same URL.
export const importLiveDiagram = async (
    storage: StorageContext,
    diagramId: string
): Promise<boolean> => {
    const remote = await pullDiagram(diagramId);

    if (!remote) {
        return false;
    }

    await storage.addDiagram({ diagram: remote });

    return true;
};

export interface SyncOps<T> {
    add: (items: T[], options: { updateHistory: boolean }) => Promise<void>;
    remove: (
        ids: string[],
        options: { updateHistory: boolean }
    ) => Promise<void>;
    update: (
        id: string,
        item: Partial<T>,
        options: { updateHistory: boolean }
    ) => Promise<void>;
}

// Key order is not stable between the in-memory objects and the ones that
// come back over the wire, so nested values have to be compared with sorted
// keys rather than a plain JSON.stringify.
const stableStringify = (value: unknown): string =>
    JSON.stringify(value, (_key, val) =>
        val && typeof val === 'object' && !Array.isArray(val)
            ? Object.fromEntries(
                  Object.entries(val as Record<string, unknown>).sort(
                      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
                  )
              )
            : val
    );

// Only the fields the remote item carries are compared. Locally stored items
// also hold bookkeeping the schema drops on the way back (diagramId, added by
// the storage layer), and counting that as a change marks every single item
// dirty on every poll -- which never converges and drowns real edits.
const hasChanged = <T extends object>(existing: T, item: T): boolean =>
    Object.keys(item).some(
        (key) =>
            stableStringify((existing as Record<string, unknown>)[key]) !==
            stableStringify((item as Record<string, unknown>)[key])
    );

// Diffs a remote collection against the current one and replays the
// difference through the same context mutators a manual edit would use
// (addTables/updateTable/... from useChartDB), so canvas re-rendering keeps
// working exactly like it does for a local edit. updateHistory:false keeps
// other people's edits out of this browser's own undo stack.
export const syncCollection = async <T extends { id: string }>(
    current: T[],
    remote: T[],
    ops: SyncOps<T>
): Promise<void> => {
    const currentById = new Map(current.map((item) => [item.id, item]));
    const remoteIds = new Set(remote.map((item) => item.id));

    const toAdd = remote.filter((item) => !currentById.has(item.id));
    const toRemoveIds = current
        .filter((item) => !remoteIds.has(item.id))
        .map((item) => item.id);
    const toUpdate = remote.filter((item) => {
        const existing = currentById.get(item.id);

        return existing !== undefined && hasChanged(existing, item);
    });

    if (toAdd.length > 0) {
        await ops.add(toAdd, { updateHistory: false });
    }

    if (toRemoveIds.length > 0) {
        await ops.remove(toRemoveIds, { updateHistory: false });
    }

    for (const item of toUpdate) {
        await ops.update(item.id, item, { updateHistory: false });
    }
};
