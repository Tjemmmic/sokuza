export interface AssembledDiff {
    diff: string;
    source: 'file-patches' | 'summary';
    incompleteFiles: string[];
}

interface FileEntry {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null | undefined;
}

export function assembleDiffFromFiles(files: FileEntry[]): AssembledDiff {
    const patches: string[] = [];
    const incompleteFiles: string[] = [];

    for (const file of files) {
        if (file.patch) {
            patches.push(formatFilePatch(file.filename, file.status, file.patch));
        } else {
            incompleteFiles.push(file.filename);
        }
    }

    if (patches.length > 0) {
        return {
            diff: patches.join('\n'),
            source: 'file-patches',
            incompleteFiles,
        };
    }

    const summaryLines = files.map((f) =>
        `${f.status.padEnd(10)} ${f.filename} (+${f.additions} -${f.deletions})`,
    );

    return {
        diff: summaryLines.join('\n'),
        source: 'summary',
        incompleteFiles: files.map((f) => f.filename),
    };
}

function formatFilePatch(filename: string, status: string, patch: string): string {
    const header = `diff --git a/${filename} b/${filename}`;
    const metaLines: string[] = [];

    if (status === 'added') {
        metaLines.push('new file mode 100644');
    } else if (status === 'removed') {
        metaLines.push('deleted file mode 100644');
    }

    metaLines.push(status === 'added' ? '--- /dev/null' : `--- a/${filename}`);
    metaLines.push(status === 'removed' ? '+++ /dev/null' : `+++ b/${filename}`);

    return `${header}\n${metaLines.join('\n')}\n${patch}`;
}
