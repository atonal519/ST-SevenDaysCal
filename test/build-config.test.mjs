import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('host imports resolve in an independent checkout without the installed ST directory depth', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gouhua-build-config-'));
    try {
        const filename = path.join(directory, 'rolldown.config.mjs');
        await fs.copyFile(new URL('../rolldown.config.mjs', import.meta.url), filename);
        const { default: config } = await import(pathToFileURL(filename));
        const resolve = config.plugins[0].resolveId;
        for (const [importer, source, expected] of [
            ['index.js', '../../../extensions.js', '/scripts/extensions.js'],
            ['runtime/settings.js', '../../../../extensions.js', '/scripts/extensions.js'],
            ['business/axis/data.js', '../../../../../../script.js', '/script.js'],
            ['index.js', '../../../utils.js', '/scripts/utils.js'],
            ['index.js', '../../../world-info.js', '/scripts/world-info.js'],
            ['index.js', '../../../slash-commands/SlashCommand.js', '/scripts/slash-commands/SlashCommand.js'],
            ['index.js', '../../../slash-commands/SlashCommandParser.js', '/scripts/slash-commands/SlashCommandParser.js'],
        ]) assert.deepEqual(resolve(source, path.join(directory, importer)), { id: expected, external: true });
        assert.ok(config.external.includes('/lib.js'));
        assert.equal(resolve('./business/axis/data.js', path.join(directory, 'index.js')), null);
        assert.throws(() => resolve('../../../unknown-host.js', path.join(directory, 'index.js')), /Unexpected import/);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
