import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StorageContext } from '@/context/storage-context/storage-context';
import type { Diagram } from '@/lib/domain/diagram';
import { DatabaseType } from '@/lib/domain/database-type';

vi.mock('@/lib/env', () => ({ LIVE_SYNC_URL: '/live-sync' }));

const { importLiveDiagram, pullDiagram, pushDiagram } =
    await import('../live-sync');

const remoteDiagram = {
    id: 'takeeats',
    name: 'takeeats',
    databaseType: DatabaseType.MYSQL,
    tables: [
        {
            id: 'tbl1',
            name: 'orders',
            x: 0,
            y: 0,
            fields: [],
            indexes: [],
            color: '#000000',
            isView: false,
            createdAt: 1700000000000,
        },
    ],
    relationships: [],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T01:00:00.000Z',
};

const respond = (status: number, body = '') =>
    ({
        status,
        ok: status >= 200 && status < 300,
        text: async () => body,
    }) as Response;

describe('live sync transport', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('pullDiagram', () => {
        it('keeps the ids the server sent so a later poll can diff by id', async () => {
            vi.mocked(fetch).mockResolvedValue(
                respond(200, JSON.stringify(remoteDiagram))
            );

            const diagram = await pullDiagram('takeeats');

            expect(diagram?.tables?.[0].id).toBe('tbl1');
            expect(diagram?.updatedAt).toBeInstanceOf(Date);
        });

        it('treats a missing diagram as nothing to apply', async () => {
            vi.mocked(fetch).mockResolvedValue(respond(404, 'not found'));

            await expect(pullDiagram('takeeats')).resolves.toBeUndefined();
        });

        it('raises other failures instead of silently discarding remote state', async () => {
            vi.mocked(fetch).mockResolvedValue(respond(500, 'boom'));

            await expect(pullDiagram('takeeats')).rejects.toThrow('500');
        });
    });

    describe('pushDiagram', () => {
        it('publishes the diagram under its own id', async () => {
            vi.mocked(fetch).mockResolvedValue(respond(204));

            await pushDiagram({
                id: 'takeeats',
                name: 'takeeats',
                databaseType: DatabaseType.MYSQL,
                createdAt: new Date(),
                updatedAt: new Date(),
            } as Diagram);

            const [url, init] = vi.mocked(fetch).mock.calls[0];
            expect(url).toBe('/live-sync/diagrams/takeeats');
            expect(init?.method).toBe('PUT');
        });
    });

    describe('importLiveDiagram', () => {
        // Without this a second person opening the shared URL gets an empty
        // editor: the diagram is not in their storage, so the editor never
        // settles on a diagramId and the sync loop never starts.
        it('seeds local storage so a fresh browser can join', async () => {
            vi.mocked(fetch).mockResolvedValue(
                respond(200, JSON.stringify(remoteDiagram))
            );
            const storage = {
                addDiagram: vi.fn().mockResolvedValue(undefined),
            } as unknown as StorageContext;

            await expect(importLiveDiagram(storage, 'takeeats')).resolves.toBe(
                true
            );

            const { diagram } = vi.mocked(storage.addDiagram).mock.calls[0][0];
            expect(diagram.id).toBe('takeeats');
            expect(diagram.tables?.[0].name).toBe('orders');
        });

        it('reports no diagram to import when the server has none', async () => {
            vi.mocked(fetch).mockResolvedValue(respond(404, 'not found'));
            const storage = {
                addDiagram: vi.fn().mockResolvedValue(undefined),
            } as unknown as StorageContext;

            await expect(importLiveDiagram(storage, 'takeeats')).resolves.toBe(
                false
            );
            expect(storage.addDiagram).not.toHaveBeenCalled();
        });
    });
});
