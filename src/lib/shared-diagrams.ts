import type { StorageContext } from '@/context/storage-context/storage-context';
import type { DBTable } from '@/lib/domain/db-table';
import type { Diagram } from '@/lib/domain/diagram';
import { SHARED_DIAGRAMS_URL } from '@/lib/env';
import { diagramFromJSONInput } from '@/lib/export-import-utils';

export interface SharedDiagramEntry {
    id: string;
    url: string;
    updatedAt: string;
    aliases?: string[];
}

const DIAGRAM_PARTS = {
    includeTables: true,
    includeRelationships: true,
    includeDependencies: true,
    includeAreas: true,
    includeCustomTypes: true,
    includeNotes: true,
};

const tableKey = (table: DBTable): string =>
    `${table.schema ?? ''}.${table.name}`;

const withPreservedLayout = (published: Diagram, current: Diagram): Diagram => {
    const placedTables = new Map(
        (current.tables ?? []).map((table) => [tableKey(table), table])
    );

    return {
        ...published,
        tables: published.tables?.map((table) => {
            const placed = placedTables.get(tableKey(table));

            if (!placed) {
                return table;
            }

            return {
                ...table,
                x: placed.x,
                y: placed.y,
                width: placed.width,
                color: placed.color,
                expanded: placed.expanded,
                parentAreaId: placed.parentAreaId,
            };
        }),
    };
};

// テーブルの内部 id は取り込みごとに振り直されるため、名前で突き合わせて
// 絞り込みの対象を新しい id に貼り替える。放置すると存在しない id を指したまま残る。
const remapFilter = async (
    storage: StorageContext,
    diagramId: string,
    previousTables: DBTable[],
    currentTables: DBTable[]
): Promise<void> => {
    const filter = await storage.getDiagramFilter(diagramId);

    if (!filter?.tableIds?.length) {
        return;
    }

    const keyByPreviousId = new Map(
        previousTables.map((table) => [table.id, tableKey(table)])
    );
    const idByKey = new Map(
        currentTables.map((table) => [tableKey(table), table.id])
    );

    await storage.updateDiagramFilter(diagramId, {
        ...filter,
        tableIds: filter.tableIds
            .map((tableId) => idByKey.get(keyByPreviousId.get(tableId) ?? ''))
            .filter((tableId): tableId is string => !!tableId),
    });
};

const fetchEntries = async (): Promise<SharedDiagramEntry[]> => {
    const response = await fetch(SHARED_DIAGRAMS_URL, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(`${SHARED_DIAGRAMS_URL}: ${response.status}`);
    }

    return (await response.json()) as SharedDiagramEntry[];
};

const importEntry = async (
    storage: StorageContext,
    entry: SharedDiagramEntry
): Promise<void> => {
    const current = await storage.getDiagram(entry.id, DIAGRAM_PARTS);
    const publishedAt = new Date(entry.updatedAt);

    if (current && current.updatedAt.getTime() >= publishedAt.getTime()) {
        return;
    }

    const response = await fetch(entry.url, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(`${entry.url}: ${response.status}`);
    }

    const published: Diagram = {
        ...diagramFromJSONInput(await response.text()),
        id: entry.id,
        updatedAt: publishedAt,
    };

    const diagram = current
        ? withPreservedLayout(published, current)
        : published;

    if (current) {
        await storage.deleteDiagram(entry.id);
    }

    await storage.addDiagram({ diagram });

    if (current) {
        await remapFilter(
            storage,
            entry.id,
            current.tables ?? [],
            diagram.tables ?? []
        );
    }
};

export const resolveSharedDiagramId = (
    entries: SharedDiagramEntry[],
    diagramId?: string
): string | undefined => {
    if (!diagramId || entries.some((entry) => entry.id === diagramId)) {
        return diagramId;
    }

    return (
        entries.find((entry) => entry.aliases?.includes(diagramId))?.id ??
        diagramId
    );
};

export const syncSharedDiagrams = async (
    storage: StorageContext,
    diagramId?: string
): Promise<string | undefined> => {
    if (!SHARED_DIAGRAMS_URL) {
        return diagramId;
    }

    let entries: SharedDiagramEntry[];

    try {
        entries = await fetchEntries();
    } catch (error) {
        console.error('Failed to read the shared diagram index', error);

        return diagramId;
    }

    for (const entry of entries) {
        try {
            await importEntry(storage, entry);
        } catch (error) {
            console.error(`Failed to import shared diagram ${entry.id}`, error);
        }
    }

    return resolveSharedDiagramId(entries, diagramId);
};

// 通常のsyncは current.updatedAt >= publishedAt なら何もしない(体裁保持)。
// ここでは手動編集を破棄してS3由来の正本に戻すため、そのガードとレイアウト引き継ぎを両方外す。
export const resetDiagramToPublished = async (
    storage: StorageContext,
    diagramId: string
): Promise<void> => {
    const entries = await fetchEntries();
    const entry = entries.find((candidate) => candidate.id === diagramId);

    if (!entry) {
        throw new Error(`No published entry for diagram "${diagramId}"`);
    }

    const response = await fetch(entry.url, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(`${entry.url}: ${response.status}`);
    }

    const published: Diagram = {
        ...diagramFromJSONInput(await response.text()),
        id: entry.id,
        updatedAt: new Date(entry.updatedAt),
    };

    await storage.deleteDiagram(entry.id);
    await storage.addDiagram({ diagram: published });
};
