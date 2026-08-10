import { describe, expect, it } from 'vitest';
import type { DBTable } from '@/lib/domain/db-table';
import {
    cloneTablesForPaste,
    parseTables,
    serializeTables,
} from '@/lib/table-clipboard';

const table = (overrides: Partial<DBTable> = {}): DBTable =>
    ({
        id: 'source-table',
        name: 'orders',
        x: 100,
        y: 200,
        color: '#ff6b6b',
        isView: false,
        createdAt: 1700000000000,
        fields: [
            {
                id: 'field-1',
                name: 'id',
                type: { id: 'bigint', name: 'bigint' },
                primaryKey: true,
                unique: true,
                nullable: false,
                createdAt: 1700000000000,
            },
            {
                id: 'field-2',
                name: 'total',
                type: { id: 'int', name: 'int' },
                primaryKey: false,
                unique: false,
                nullable: true,
                createdAt: 1700000000000,
            },
        ],
        indexes: [
            {
                id: 'index-1',
                name: 'idx_total',
                unique: false,
                fieldIds: ['field-2'],
                createdAt: 1700000000000,
            },
        ],
        ...overrides,
    }) as DBTable;

describe('table clipboard payload', () => {
    it('round-trips tables', () => {
        const copied = parseTables(serializeTables([table()]));

        expect(copied).toHaveLength(1);
        expect(copied?.[0].name).toBe('orders');
    });

    // Pasting into the canvas must ignore whatever else is on the clipboard.
    it('ignores text that is not ours', () => {
        expect(parseTables('just some text')).toBeUndefined();
        expect(parseTables('{"tables":[]}')).toBeUndefined();
        expect(
            parseTables(JSON.stringify({ kind: 'other/app', tables: [] }))
        ).toBeUndefined();
    });
});

describe('cloneTablesForPaste', () => {
    it('gives the copy new ids so it cannot overwrite the original', () => {
        const source = table();
        const [copy] = cloneTablesForPaste([source], new Set());

        expect(copy.id).not.toBe(source.id);
        expect(copy.fields.map((field) => field.id)).not.toEqual(
            source.fields.map((field) => field.id)
        );
        expect(copy.indexes[0].id).not.toBe(source.indexes[0].id);
    });

    // An index pointing at the source table's field ids would silently break.
    it('repoints indexes at the copied fields', () => {
        const [copy] = cloneTablesForPaste([table()], new Set());

        expect(copy.indexes[0].fieldIds).toEqual([copy.fields[1].id]);
    });

    it('offsets the copy so it does not land exactly on the original', () => {
        const source = table();
        const [copy] = cloneTablesForPaste([source], new Set());

        expect(copy.x).toBeGreaterThan(source.x);
        expect(copy.y).toBeGreaterThan(source.y);
    });

    it('renames only when the name is already taken', () => {
        const [intoSameDiagram] = cloneTablesForPaste(
            [table()],
            new Set(['orders'])
        );
        const [intoOtherDiagram] = cloneTablesForPaste([table()], new Set());

        expect(intoSameDiagram.name).toBe('orders_copy');
        expect(intoOtherDiagram.name).toBe('orders');
    });

    it('keeps ids unique across a multi-table paste', () => {
        const copies = cloneTablesForPaste(
            [table({ id: 'a' }), table({ id: 'b', name: 'items' })],
            new Set()
        );

        expect(new Set(copies.map((copy) => copy.id)).size).toBe(2);
    });
});
