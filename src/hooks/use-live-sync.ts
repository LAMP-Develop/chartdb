import { useEffect, useRef } from 'react';
import { useChartDB } from '@/hooks/use-chartdb';
import { LIVE_SYNC_URL } from '@/lib/env';
import { pullDiagram, pushDiagram, syncCollection } from '@/lib/live-sync';

const POLL_INTERVAL_MS = 4000;
const PUSH_DEBOUNCE_MS = 1000;

// Polls a small server-side store for changes other browsers made to this
// diagram, and pushes local changes back (debounced). Conflicts resolve
// last-write-wins; there is no operational-transform/CRDT layer. No-op
// unless LIVE_SYNC_URL is configured, matching the opt-in shared-diagrams
// pattern.
export const useLiveSync = (): void => {
    const {
        diagramId,
        currentDiagram,
        tables,
        relationships,
        dependencies,
        areas,
        customTypes,
        notes,
        addTables,
        removeTables,
        updateTable,
        addRelationships,
        removeRelationships,
        updateRelationship,
        addDependencies,
        removeDependencies,
        updateDependency,
        addAreas,
        removeAreas,
        updateArea,
        addCustomTypes,
        removeCustomTypes,
        updateCustomType,
        addNotes,
        removeNotes,
        updateNote,
    } = useChartDB();

    // Guards against the push effect firing while we're mid-applying a
    // remote update (it would just echo the same content straight back).
    const applyingRemoteRef = useRef(false);
    // Guards against pushing a possibly-stale local diagram before the
    // first pull for this diagramId has established a baseline -- without
    // this, a slow first pull could let a stale local copy overwrite a
    // collaborator's newer edit on the server.
    const readyToPushRef = useRef(false);
    const pushTimerRef = useRef<ReturnType<typeof setTimeout>>();

    // The poll interval below is created once per diagramId and must not
    // restart on every local edit, so it can't list these in its dependency
    // array. This ref keeps the latest collections/mutators available to
    // that interval's closure without a restart.
    const latestRef = useRef({
        tables,
        relationships,
        dependencies,
        areas,
        customTypes,
        notes,
        addTables,
        removeTables,
        updateTable,
        addRelationships,
        removeRelationships,
        updateRelationship,
        addDependencies,
        removeDependencies,
        updateDependency,
        addAreas,
        removeAreas,
        updateArea,
        addCustomTypes,
        removeCustomTypes,
        updateCustomType,
        addNotes,
        removeNotes,
        updateNote,
    });
    latestRef.current = {
        tables,
        relationships,
        dependencies,
        areas,
        customTypes,
        notes,
        addTables,
        removeTables,
        updateTable,
        addRelationships,
        removeRelationships,
        updateRelationship,
        addDependencies,
        removeDependencies,
        updateDependency,
        addAreas,
        removeAreas,
        updateArea,
        addCustomTypes,
        removeCustomTypes,
        updateCustomType,
        addNotes,
        removeNotes,
        updateNote,
    };

    useEffect(() => {
        if (!LIVE_SYNC_URL || !diagramId) {
            return;
        }

        let cancelled = false;
        readyToPushRef.current = false;

        const pull = async () => {
            try {
                const remote = await pullDiagram(diagramId);

                if (!remote || cancelled) {
                    return;
                }

                const current = latestRef.current;

                applyingRemoteRef.current = true;

                await Promise.all([
                    syncCollection(current.tables, remote.tables ?? [], {
                        add: current.addTables,
                        remove: current.removeTables,
                        update: current.updateTable,
                    }),
                    syncCollection(
                        current.relationships,
                        remote.relationships ?? [],
                        {
                            add: current.addRelationships,
                            remove: current.removeRelationships,
                            update: current.updateRelationship,
                        }
                    ),
                    syncCollection(
                        current.dependencies,
                        remote.dependencies ?? [],
                        {
                            add: current.addDependencies,
                            remove: current.removeDependencies,
                            update: current.updateDependency,
                        }
                    ),
                    syncCollection(current.areas, remote.areas ?? [], {
                        add: current.addAreas,
                        remove: current.removeAreas,
                        update: current.updateArea,
                    }),
                    syncCollection(
                        current.customTypes,
                        remote.customTypes ?? [],
                        {
                            add: current.addCustomTypes,
                            remove: current.removeCustomTypes,
                            update: current.updateCustomType,
                        }
                    ),
                    syncCollection(current.notes, remote.notes ?? [], {
                        add: current.addNotes,
                        remove: current.removeNotes,
                        update: current.updateNote,
                    }),
                ]);
            } catch (error) {
                console.error('Live sync pull failed', error);
            } finally {
                applyingRemoteRef.current = false;
                readyToPushRef.current = true;
            }
        };

        const interval = setInterval(pull, POLL_INTERVAL_MS);
        pull();

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [diagramId]);

    useEffect(() => {
        if (
            !LIVE_SYNC_URL ||
            !diagramId ||
            !readyToPushRef.current ||
            applyingRemoteRef.current
        ) {
            return;
        }

        if (pushTimerRef.current) {
            clearTimeout(pushTimerRef.current);
        }

        pushTimerRef.current = setTimeout(() => {
            pushDiagram(currentDiagram).catch((error) => {
                console.error('Live sync push failed', error);
            });
        }, PUSH_DEBOUNCE_MS);

        return () => {
            if (pushTimerRef.current) {
                clearTimeout(pushTimerRef.current);
            }
        };
    }, [currentDiagram, diagramId]);
};
