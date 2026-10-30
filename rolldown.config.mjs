import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('.', import.meta.url));
// Interpret host-relative specifiers in the installed layout even when this
// repository is checked out outside a SillyTavern public directory.
const virtualPluginRoot = '/scripts/extensions/third-party/ST-SevenDaysCal/';
const hostModules = [
    '/lib.js',
    '/script.js',
    '/scripts/extensions.js',
    '/scripts/utils.js',
    '/scripts/world-info.js',
    '/scripts/slash-commands/SlashCommand.js',
    '/scripts/slash-commands/SlashCommandParser.js',
];

export default {
    input: path.join(pluginRoot, 'index.js'),
    transform: {
        define: {
            __GOUHUA_STYLESHEET_REVISION__: JSON.stringify(createHash('sha256').update(readFileSync(path.join(pluginRoot, 'style.css'))).digest('hex').slice(0, 12)),
        },
    },
    external: hostModules,
    makeAbsoluteExternalsRelative: false,
    plugins: [{
        name: 'gouhua-host-imports',
        resolveId(source, importer) {
            if (!importer || !source.startsWith('.')) return null;
            const relativeImporter = path.relative(pluginRoot, importer).split(path.sep).join('/');
            const resolved = path.posix.resolve(virtualPluginRoot, path.posix.dirname(relativeImporter), source);
            if (hostModules.includes(resolved)) return { id: resolved, external: true };
            if (!resolved.startsWith(virtualPluginRoot)) throw new Error(`Unexpected import outside the plugin: ${source} (${importer})`);
            return null;
        },
    }],
    output: {
        file: path.join(pluginRoot, 'gouhua-app.js'),
        format: 'es',
        // Rolldown keeps dynamic module initialization lazy in this single file.
        codeSplitting: false,
        sourcemap: false,
        minify: {
            mangle: { keepNames: true },
            compress: { keepNames: { function: true, class: true } },
            codegen: true,
        },
        banner: '/*! Includes fflate, Copyright (c) 2023 Arjun Barrett, MIT; see vendor/fflate-LICENSE.txt. */',
        comments: { legal: true },
    },
};
