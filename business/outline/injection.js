import { isCompleteOutlineBeat, parseOutline } from './schema.js';
import { buildOutlineInjectionText, OUTLINE_INJECT_DEPTH, OUTLINE_INJECT_KEY } from './prompts.js';

export function isOutlinePlanningEnabled(injectEnabled, settings) {
    return Boolean(injectEnabled?.() && settings?.().outlineInject === true);
}

export function projectOutlineBeats(beats, cursor, enabled = true) {
    const position = Number(cursor);
    if (!enabled || !Array.isArray(beats) || !beats.length || !Number.isInteger(position) || position < 1 || position > beats.length) {
        return Object.freeze({ beats: Object.freeze([]), cursor: 0, current: null, next: null });
    }
    const current = isCompleteOutlineBeat(beats[position - 1]) ? beats[position - 1] : null;
    if (!current) return Object.freeze({ beats: Object.freeze([]), cursor: 0, current: null, next: null });
    const next = position < beats.length && isCompleteOutlineBeat(beats[position]) ? beats[position] : null;
    // Keep the source slots so consumers never promote a later node when an earlier slot is incomplete.
    const projected = Array(position + (position < beats.length ? 1 : 0)).fill(null);
    projected[position - 1] = current;
    if (next) projected[position] = next;
    return Object.freeze({ beats: Object.freeze(projected), cursor: position, current, next });
}

export function formatOutlinePlanningProjection(projection, cleanText = value => String(value || '')) {
    if (!projection?.current) return '';
    const lines = ['【剧情规划参考｜尚未发生的推演，不替玩家决定未决事项】'];
    for (const [beat, label] of [[projection.current, '当前阶段'], [projection.next, '后续方向']]) {
        if (!beat) continue;
        lines.push(`${label}：${beat.time ? `${cleanText(beat.time)}·` : ''}《${cleanText(beat.title)}》${beat.type ? `·${cleanText(beat.type)}` : ''}`);
        if (beat.scene) lines.push(cleanText(beat.scene));
    }
    return lines.join('\n');
}

export function createOutlineInjection({ repository, context, settings, injectEnabled, cleanText, preferences } = {}) {
    const clear = () => {
        const ctx = context?.();
        if (typeof ctx?.setExtensionPrompt === 'function') ctx.setExtensionPrompt(OUTLINE_INJECT_KEY, '');
    };
    const refresh = (target = repository.capture()) => {
        const ctx = context?.();
        if (typeof ctx?.setExtensionPrompt !== 'function') return;
        if (!repository.isCurrent(target)) return;
        if (!isOutlinePlanningEnabled(injectEnabled, settings)) {
            clear();
            return;
        }
        let beats = [];
        let cursor = 0;
        try {
            const saved = repository.readOutline(target);
            if (saved?.raw) {
                beats = parseOutline(saved.raw);
                cursor = repository.cursor(target);
            }
        } catch {
            beats = [];
        }
        const projection = projectOutlineBeats(beats, cursor);
        if (!projection.beats.length) {
            clear();
            return;
        }
        const promptType = ctx.constants?.promptTypes?.IN_CHAT ?? 1;
        const promptRole = ctx.constants?.promptRoles?.SYSTEM ?? 0;
        ctx.setExtensionPrompt(
            OUTLINE_INJECT_KEY,
            buildOutlineInjectionText(projection.beats, projection.cursor, cleanText, preferences?.(ctx)),
            promptType,
            OUTLINE_INJECT_DEPTH,
            false,
            promptRole,
        );
    };
    return Object.freeze({ refresh, clear, key: OUTLINE_INJECT_KEY, depth: OUTLINE_INJECT_DEPTH });
}
