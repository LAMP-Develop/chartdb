import { z } from 'zod';
import { dbTableSchema, type DBTable } from '@/lib/domain/db-table';
import { generateId } from '@/lib/utils';

// Marks a clipboard payload as ours, so pasting unrelated text (or JSON from
// somewhere else) is ignored instead of creating garbage tables.
const CLIPBOARD_KIND = 'chartdb/tables';

const PASTE_OFFSET = 40;

const payloadSchema = z.object({
    kind: z.literal(CLIPBOARD_KIND),
    tables: z.array(dbTableSchema),
});

export const serializeTables = (tables: DBTable[]): string =>
    JSON.stringify({ kind: CLIPBOARD_KIND, tables });

export const parseTables = (text: string): DBTable[] | undefined => {
    try {
        const payload = payloadSchema.parse(JSON.parse(text));

        return payload.tables;
    } catch {
        return undefined;
    }
};

// Every id has to be regenerated: pasted tables are new tables, and reusing
// the source ids would make the paste overwrite the original in storage.
// Index fieldIds point at the copies, not the source fields.
export const cloneTablesForPaste = (
    tables: DBTable[],
    existingNames: Set<string>
): DBTable[] =>
    tables.map((table) => {
        const fieldIds = new Map(
            table.fields.map((field) => [field.id, generateId()])
        );

        return {
            ...table,
            id: generateId(),
            name: existingNames.has(table.name)
                ? `${table.name}_copy`
                : table.name,
            x: table.x + PASTE_OFFSET,
            y: table.y + PASTE_OFFSET,
            createdAt: Date.now(),
            fields: table.fields.map((field) => ({
                ...field,
                id: fieldIds.get(field.id) ?? generateId(),
            })),
            indexes: table.indexes.map((index) => ({
                ...index,
                id: generateId(),
                fieldIds: index.fieldIds
                    .map((id) => fieldIds.get(id))
                    .filter((id): id is string => id !== undefined),
            })),
        };
    });
