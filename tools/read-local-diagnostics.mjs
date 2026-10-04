#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';

const userRoot = process.argv[2];
if (!userRoot || !isAbsolute(userRoot)) {
    process.stderr.write('Usage: node tools/read-local-diagnostics.mjs <absolute-sillytavern-user-root>\n');
    process.exitCode = 2;
} else {
    const file = join(resolve(userRoot), '.st-bainiaodata', 'storage-v1', 'records', 'st-sevendayscal', 'private-diagnostics', 'generation-live.json');
    try {
        const envelope = JSON.parse(await readFile(file, 'utf8'));
        process.stdout.write(`${JSON.stringify(envelope.data, null, 2)}\n`);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            process.stderr.write('No local generation diagnostics record exists yet.\n');
            process.exitCode = 1;
        } else throw error;
    }
}
