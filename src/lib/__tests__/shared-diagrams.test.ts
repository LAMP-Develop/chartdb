import { describe, expect, it } from 'vitest';
import type { Diagram } from '@/lib/domain/diagram';
import { DatabaseType } from '@/lib/domain/database-type';
import { withPreservedLocalEdits } from '@/lib/shared-diagrams';

const diagram = (overrides: Partial<Diagram> = {}): Diagram => ({
    id: 'takeeats',
    name: 'takeeats',
    databaseType: DatabaseType.MYSQL,
    createdAt: new Date(1700000000000),
    updatedAt: new Date(1700000000000),
    tables: [],
    relationships: [],
    ...overrides,
});

const table = (name: string, overrides = {}) =>
    ({
        id: `id-${name}`,
        name,
        schema: 'takeeats',
        x: 0,
        y: 0,
        color: '#ff6b6b',
        isView: false,
        createdAt: 1700000000000,
        fields: [],
        indexes: [],
        ...overrides,
    }) as NonNullable<Diagram['tables']>[number];

const area = (id: string) =>
    ({
        id,
        name: 'ordering',
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        color: '#4ecdc4',
        createdAt: 1700000000000,
    }) as NonNullable<Diagram['areas']>[number];

const note = (id: string) =>
    ({
        id,
        content: 'ここは触らない',
        x: 5,
        y: 6,
        width: 200,
        height: 100,
        color: '#ffe066',
        createdAt: 1700000000000,
    }) as NonNullable<Diagram['notes']>[number];

describe('withPreservedLocalEdits', () => {
    // The daily publish regenerates the diagram from a schema dump, which has
    // no areas or notes. Losing them would wipe everyone's annotations for a
    // reason that has nothing to do with them.
    it('keeps local areas and notes when the published diagram has none', () => {
        const merged = withPreservedLocalEdits(
            diagram({ tables: [table('orders')] }),
            diagram({
                tables: [table('orders')],
                areas: [area('area-1')],
                notes: [note('note-1')],
            })
        );

        expect(merged.areas?.map((a) => a.id)).toEqual(['area-1']);
        expect(merged.notes?.map((n) => n.id)).toEqual(['note-1']);
    });

    it('takes the published areas and notes when the publish carries them', () => {
        const merged = withPreservedLocalEdits(
            diagram({
                areas: [area('published-area')],
                notes: [note('published-note')],
            }),
            diagram({
                areas: [area('local-area')],
                notes: [note('local-note')],
            })
        );

        expect(merged.areas?.map((a) => a.id)).toEqual(['published-area']);
        expect(merged.notes?.map((n) => n.id)).toEqual(['published-note']);
    });

    // A table kept inside an area would otherwise point at an area that the
    // import just deleted.
    it('keeps the area a table was placed in', () => {
        const merged = withPreservedLocalEdits(
            diagram({ tables: [table('orders')] }),
            diagram({
                tables: [table('orders', { parentAreaId: 'area-1' })],
                areas: [area('area-1')],
            })
        );

        expect(merged.tables?.[0].parentAreaId).toBe('area-1');
        expect(merged.areas?.some((a) => a.id === 'area-1')).toBe(true);
    });

    it('keeps where each table was dragged to', () => {
        const merged = withPreservedLocalEdits(
            diagram({ tables: [table('orders')] }),
            diagram({
                tables: [
                    table('orders', {
                        x: 900,
                        y: 700,
                        width: 320,
                        color: '#123456',
                        expanded: true,
                    }),
                ],
            })
        );

        expect(merged.tables?.[0]).toMatchObject({
            x: 900,
            y: 700,
            width: 320,
            color: '#123456',
            expanded: true,
        });
    });

    it('still takes new tables from the publish', () => {
        const merged = withPreservedLocalEdits(
            diagram({ tables: [table('orders'), table('coupons')] }),
            diagram({ tables: [table('orders')] })
        );

        expect(merged.tables?.map((t) => t.name)).toEqual([
            'orders',
            'coupons',
        ]);
    });
});
