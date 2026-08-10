import { useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useChartDB } from '@/hooks/use-chartdb';
import {
    cloneTablesForPaste,
    parseTables,
    serializeTables,
} from '@/lib/table-clipboard';

// Native copy/paste events rather than a key binding: they carry the system
// clipboard with them, so a table can be pasted into another diagram or
// another browser tab, and the browser still handles text copy inside inputs.
const isTypingTarget = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;

    if (!element?.tagName) {
        return false;
    }

    return (
        element.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
    );
};

export const useTableClipboard = (): void => {
    const { tables, addTables } = useChartDB();
    const { getNodes } = useReactFlow();

    useEffect(() => {
        const onCopy = (event: ClipboardEvent) => {
            if (isTypingTarget(event.target)) {
                return;
            }

            // A text selection means the user is copying text they highlighted,
            // not the tables that happen to be selected on the canvas.
            if (window.getSelection()?.toString()) {
                return;
            }

            const selectedIds = new Set(
                getNodes()
                    .filter((node) => node.selected && node.type === 'table')
                    .map((node) => node.id)
            );

            const selected = tables.filter((table) =>
                selectedIds.has(table.id)
            );

            if (selected.length === 0) {
                return;
            }

            event.clipboardData?.setData(
                'text/plain',
                serializeTables(selected)
            );
            event.preventDefault();
        };

        const onPaste = (event: ClipboardEvent) => {
            if (isTypingTarget(event.target)) {
                return;
            }

            const copied = parseTables(
                event.clipboardData?.getData('text/plain') ?? ''
            );

            if (!copied?.length) {
                return;
            }

            event.preventDefault();

            const existingNames = new Set(tables.map((table) => table.name));

            addTables(cloneTablesForPaste(copied, existingNames)).catch(
                (error) => console.error('Paste tables failed', error)
            );
        };

        document.addEventListener('copy', onCopy);
        document.addEventListener('paste', onPaste);

        return () => {
            document.removeEventListener('copy', onCopy);
            document.removeEventListener('paste', onPaste);
        };
    }, [tables, addTables, getNodes]);
};
