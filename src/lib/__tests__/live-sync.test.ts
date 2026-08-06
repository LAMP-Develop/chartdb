import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncCollection } from '../live-sync';
import type { SyncOps } from '../live-sync';

interface Item {
    id: string;
    name: string;
    [key: string]: unknown;
}

const makeOps = () => {
    const ops = {
        add: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
    };

    return ops as SyncOps<Item> & typeof ops;
};

describe('syncCollection', () => {
    let ops: ReturnType<typeof makeOps>;

    beforeEach(() => {
        ops = makeOps();
    });

    it('adds items the remote has and the local one does not', async () => {
        await syncCollection(
            [{ id: 'a', name: 'a' }],
            [
                { id: 'a', name: 'a' },
                { id: 'b', name: 'b' },
            ],
            ops
        );

        expect(ops.add).toHaveBeenCalledWith([{ id: 'b', name: 'b' }], {
            updateHistory: false,
        });
        expect(ops.remove).not.toHaveBeenCalled();
        expect(ops.update).not.toHaveBeenCalled();
    });

    it('removes items the remote no longer has', async () => {
        await syncCollection(
            [
                { id: 'a', name: 'a' },
                { id: 'b', name: 'b' },
            ],
            [{ id: 'a', name: 'a' }],
            ops
        );

        expect(ops.remove).toHaveBeenCalledWith(['b'], {
            updateHistory: false,
        });
        expect(ops.add).not.toHaveBeenCalled();
        expect(ops.update).not.toHaveBeenCalled();
    });

    it('updates items whose values actually changed', async () => {
        await syncCollection(
            [{ id: 'a', name: 'before' }],
            [{ id: 'a', name: 'after' }],
            ops
        );

        expect(ops.update).toHaveBeenCalledTimes(1);
        expect(ops.update).toHaveBeenCalledWith(
            'a',
            { id: 'a', name: 'after' },
            { updateHistory: false }
        );
    });

    // Remote edits must not land in this browser's undo stack.
    it('never asks the mutators to record history', async () => {
        await syncCollection(
            [
                { id: 'a', name: 'before' },
                { id: 'gone', name: 'gone' },
            ],
            [
                { id: 'a', name: 'after' },
                { id: 'new', name: 'new' },
            ],
            ops
        );

        for (const call of [
            ...ops.add.mock.calls,
            ...ops.remove.mock.calls,
            ...ops.update.mock.calls,
        ]) {
            expect(call[call.length - 1]).toEqual({ updateHistory: false });
        }
    });

    describe('nothing to do', () => {
        it('touches nothing when both sides match', async () => {
            const items = [
                { id: 'a', name: 'a' },
                { id: 'b', name: 'b' },
            ];

            await syncCollection(items, structuredClone(items), ops);

            expect(ops.add).not.toHaveBeenCalled();
            expect(ops.remove).not.toHaveBeenCalled();
            expect(ops.update).not.toHaveBeenCalled();
        });

        // The storage layer stamps diagramId onto every stored item, and the
        // schema drops it on the way back from the sync server. Treating that
        // as a change marked every item dirty on every poll, which never
        // converged and buried real edits.
        it('ignores local-only bookkeeping keys such as diagramId', async () => {
            await syncCollection(
                [{ id: 'a', name: 'a', diagramId: 'takeeats' }],
                [{ id: 'a', name: 'a' }],
                ops
            );

            expect(ops.update).not.toHaveBeenCalled();
        });

        it('ignores key order at the top level', async () => {
            await syncCollection(
                [{ id: 'a', name: 'a', x: 1, y: 2 }],
                [{ y: 2, x: 1, name: 'a', id: 'a' }],
                ops
            );

            expect(ops.update).not.toHaveBeenCalled();
        });

        it('ignores key order inside nested values', async () => {
            await syncCollection(
                [
                    {
                        id: 'a',
                        name: 'a',
                        fields: [{ id: 'f1', name: 'col', nullable: true }],
                    },
                ],
                [
                    {
                        id: 'a',
                        name: 'a',
                        fields: [{ nullable: true, name: 'col', id: 'f1' }],
                    },
                ],
                ops
            );

            expect(ops.update).not.toHaveBeenCalled();
        });

        it('stays quiet across repeated polls of unchanged data', async () => {
            const local = [{ id: 'a', name: 'a', diagramId: 'takeeats' }];
            const remote = [{ name: 'a', id: 'a' }];

            for (let poll = 0; poll < 3; poll++) {
                await syncCollection(local, remote, ops);
            }

            expect(ops.update).not.toHaveBeenCalled();
        });
    });

    it('still detects a real change on an item carrying local-only keys', async () => {
        await syncCollection(
            [{ id: 'a', name: 'before', diagramId: 'takeeats' }],
            [{ id: 'a', name: 'after' }],
            ops
        );

        expect(ops.update).toHaveBeenCalledWith(
            'a',
            { id: 'a', name: 'after' },
            { updateHistory: false }
        );
    });
});
