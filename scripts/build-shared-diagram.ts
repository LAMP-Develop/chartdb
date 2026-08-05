import fs from 'node:fs';
import path from 'node:path';
import { sqlImportToDiagram } from '@/lib/data/sql-import';
import { DatabaseType } from '@/lib/domain/database-type';
import { diagramToJSONOutput } from '@/lib/export-import-utils';
import type { SharedDiagramEntry } from '@/lib/shared-diagrams';

// generateDiagramId() が localStorage を読むため、Node では最小の実装を渡す。
if (!globalThis.localStorage) {
    const store = new Map<string, string>();

    Object.defineProperty(globalThis, 'localStorage', {
        value: {
            length: 0,
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key),
            clear: () => store.clear(),
            key: () => null,
        },
    });
}

const args = process.argv.slice(2);

const option = (flag: string): string | undefined => {
    const index = args.indexOf(flag);

    return index === -1 ? undefined : args[index + 1];
};

const required = (flag: string): string => {
    const value = option(flag);

    if (!value) {
        throw new Error(
            `Usage: vite-node scripts/build-shared-diagram.ts -- --sql <dump.sql> --id <diagram-id> --name <diagram-name> [--source mysql] [--alias old-id,other-id] [--out shared] [--base-url /shared]`
        );
    }

    return value;
};

const sqlPath = required('--sql');
const id = required('--id');
const name = required('--name');
const outDir = option('--out') ?? 'shared';
const baseUrl = (option('--base-url') ?? '/shared').replace(/\/$/, '');
const sourceDatabaseType = (option('--source') ??
    DatabaseType.MYSQL) as DatabaseType;
const aliases = (option('--alias') ?? '')
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean);

// ダンプの mtime を updatedAt にする。実行時刻を使うと中身が同じでも
// クライアント側が毎回取り込み直すため。
const updatedAt = fs.statSync(sqlPath).mtime;

const diagram = await sqlImportToDiagram({
    sqlContent: fs.readFileSync(sqlPath, 'utf8'),
    sourceDatabaseType,
    targetDatabaseType: sourceDatabaseType,
});

diagram.id = id;
diagram.name = name;
diagram.createdAt = updatedAt;
diagram.updatedAt = updatedAt;

const entry: SharedDiagramEntry = {
    id,
    url: `${baseUrl}/${id}.json`,
    updatedAt: updatedAt.toISOString(),
    ...(aliases.length > 0 ? { aliases } : {}),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
    path.join(outDir, `${id}.json`),
    diagramToJSONOutput(diagram),
    'utf8'
);

const indexPath = path.join(outDir, 'index.json');
const existing: SharedDiagramEntry[] = fs.existsSync(indexPath)
    ? (JSON.parse(fs.readFileSync(indexPath, 'utf8')) as SharedDiagramEntry[])
    : [];

fs.writeFileSync(
    indexPath,
    JSON.stringify(
        [...existing.filter((other) => other.id !== id), entry],
        null,
        2
    ),
    'utf8'
);

console.log(
    `${outDir}/${id}.json (${diagram.tables?.length ?? 0} tables, updatedAt ${entry.updatedAt})`
);
