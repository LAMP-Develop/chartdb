import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogInternalContent,
    DialogTitle,
} from '@/components/dialog/dialog';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/table/table';
import { Alert, AlertDescription } from '@/components/alert/alert';
import { Button } from '@/components/button/button';
import { Spinner } from '@/components/spinner/spinner';
import { useChartDB } from '@/hooks/use-chartdb';
import { useDialog } from '@/hooks/use-dialog';
import type { DiagramSnapshot } from '@/lib/live-sync';
import { listSnapshots, restoreSnapshot } from '@/lib/live-sync';
import type { BaseDialogProps } from '../common/base-dialog-props';

export interface RestoreSnapshotDialogProps extends BaseDialogProps {}

export const RestoreSnapshotDialog: React.FC<RestoreSnapshotDialogProps> = ({
    dialog,
}) => {
    const { t } = useTranslation();
    const { diagramId } = useChartDB();
    const { closeRestoreSnapshotDialog } = useDialog();
    const [snapshots, setSnapshots] = useState<DiagramSnapshot[]>([]);
    const [selectedTS, setSelectedTS] = useState<string | undefined>();
    const [isLoading, setIsLoading] = useState(false);
    const [isRestoring, setIsRestoring] = useState(false);
    const [error, setError] = useState<string | undefined>();

    useEffect(() => {
        if (!dialog.open || !diagramId) {
            return;
        }

        let cancelled = false;
        setSelectedTS(undefined);
        setError(undefined);
        setIsLoading(true);

        listSnapshots(diagramId)
            .then((list) => {
                if (!cancelled) {
                    setSnapshots(list);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setError(t('restore_snapshot_dialog.error'));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [dialog.open, diagramId, t]);

    const handleRestore = useCallback(async () => {
        if (!selectedTS) {
            return;
        }

        setError(undefined);
        setIsRestoring(true);

        try {
            await restoreSnapshot(diagramId, selectedTS);
            // The local copy in IndexedDB is still the pre-restore one; a
            // reload lets the sync loop pull the restored diagram in as if a
            // collaborator had made the change.
            window.location.reload();
        } catch {
            setError(t('restore_snapshot_dialog.restore_error'));
            setIsRestoring(false);
        }
    }, [diagramId, selectedTS, t]);

    return (
        <Dialog
            {...dialog}
            onOpenChange={(open) => {
                if (!open) {
                    closeRestoreSnapshotDialog();
                }
            }}
        >
            <DialogContent
                className="flex h-[30rem] max-h-screen flex-col overflow-y-auto md:min-w-[60vw] xl:min-w-[45vw]"
                showClose
            >
                <DialogHeader>
                    <DialogTitle>
                        {t('restore_snapshot_dialog.title')}
                    </DialogTitle>
                    <DialogDescription>
                        {t('restore_snapshot_dialog.description')}
                    </DialogDescription>
                </DialogHeader>
                <DialogInternalContent>
                    {isLoading ? (
                        <div className="flex flex-1 items-center justify-center">
                            <Spinner className="size-6" />
                        </div>
                    ) : null}
                    {!isLoading && snapshots.length === 0 ? (
                        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                            {t('restore_snapshot_dialog.empty')}
                        </div>
                    ) : null}
                    {!isLoading && snapshots.length > 0 ? (
                        <Table>
                            <TableHeader className="sticky top-0 bg-background">
                                <TableRow>
                                    <TableHead>
                                        {t(
                                            'restore_snapshot_dialog.table_columns.saved_at'
                                        )}
                                    </TableHead>
                                    <TableHead className="text-center">
                                        {t(
                                            'restore_snapshot_dialog.table_columns.tables'
                                        )}
                                    </TableHead>
                                    <TableHead className="text-center">
                                        {t(
                                            'restore_snapshot_dialog.table_columns.areas'
                                        )}
                                    </TableHead>
                                    <TableHead className="text-center">
                                        {t(
                                            'restore_snapshot_dialog.table_columns.notes'
                                        )}
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {snapshots.map((snapshot) => (
                                    <TableRow
                                        key={snapshot.ts}
                                        data-state={
                                            selectedTS === snapshot.ts
                                                ? 'selected'
                                                : ''
                                        }
                                        tabIndex={0}
                                        className="cursor-pointer focus:bg-accent focus:outline-none"
                                        onClick={() =>
                                            setSelectedTS(snapshot.ts)
                                        }
                                        onFocus={() =>
                                            setSelectedTS(snapshot.ts)
                                        }
                                    >
                                        <TableCell>
                                            {new Date(
                                                snapshot.ts
                                            ).toLocaleString()}
                                        </TableCell>
                                        <TableCell className="text-center">
                                            {snapshot.tables}
                                        </TableCell>
                                        <TableCell className="text-center">
                                            {snapshot.areas}
                                        </TableCell>
                                        <TableCell className="text-center">
                                            {snapshot.notes}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    ) : null}
                </DialogInternalContent>
                {error ? (
                    <Alert variant="destructive">
                        <AlertCircle className="size-4" />
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                ) : null}
                <DialogFooter className="flex gap-1 md:justify-between">
                    <DialogClose asChild>
                        <Button variant="secondary">
                            {t('restore_snapshot_dialog.cancel')}
                        </Button>
                    </DialogClose>
                    <Button
                        onClick={handleRestore}
                        disabled={!selectedTS || isRestoring}
                    >
                        {isRestoring ? (
                            <Spinner className="mr-1 size-5 text-primary-foreground" />
                        ) : null}
                        {t('restore_snapshot_dialog.restore')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
