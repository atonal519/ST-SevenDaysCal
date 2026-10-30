import { createGenerationDiagnosticScope } from '../../api/diagnostics.js';

// Images belong to the text of one wardrobe; adding a different person's image does
// not change that ownership or prevent independent person requests from merging.
export function wardrobeContentKey(wardrobe) {
    return JSON.stringify([wardrobe?.generatedAt, wardrobe?.storyDate, wardrobe?.title, wardrobe?.scene,
        (wardrobe?.items || []).map(item => [item?.name, item?.description, item?.imagePrompt])]);
}

function imageRequest(item, characterName = '未命名角色') {
    return {
        prompt: `solo, full body, ${item.imagePrompt || `${item.name}。${item.description}`}, no text`,
        save: true,
        character: characterName,
        size: 'portrait',
    };
}

const progressText = progress => ({ queued: '正在排队…', 'queued-remote': '正在排队…', generating: '正在绘制…', retrying: '柏宝绘正在重试…', saving: '正在保存到图库…' })[progress?.phase] || '正在绘制…';
function failureText(error) {
    if (error?.code === 'rate_limited') return '生图请求过于频繁，请稍后再试';
    if (error?.code === 'not_configured') return '请先在柏宝绘中配置生图渠道';
    return '图片生成失败，请检查柏宝绘后重试';
}

export function createWardrobeImageController(env) {
    const states = new Map();
    let referenceSave = Promise.resolve();
    const stateKey = (wardrobe, index) => `${wardrobeContentKey(wardrobe)}:${index}`;
    const state = (wardrobe, index) => states.get(stateKey(wardrobe, index)) || {};
    function redraw(index, wardrobeKey, wardrobe) { env.render?.({ index, wardrobeKey, wardrobe }); }
    async function run(index) {
        const target = env.capture();
        const wardrobe = target?.read();
        const item = wardrobe?.items?.[index];
        if (!item?.name || !item?.description) return { status: 'missing' };
        const key = stateKey(wardrobe, index), wardrobeKey = wardrobeContentKey(wardrobe);
        if (states.get(key)?.busy) return { status: 'busy' };
        // Keep only this wardrobe's UI messages and requests still doing real work.
        for (const [oldKey, value] of states) if (!value.busy && !oldKey.startsWith(`${wardrobeKey}:`)) states.delete(oldKey);
        const owner = env.owners.create(`point-wardrobe-image-${index}`);
        const diagnostic = createGenerationDiagnosticScope('wardrobe-image');
        const current = { busy: true, message: '正在准备绘图…', owner };
        states.set(key, current);
        const update = message => { current.message = message; redraw(index, wardrobeKey, wardrobe); };
        const imageBefore = JSON.stringify(item.image || null);
        let phase = 'generate';
        try {
            redraw(index, wardrobeKey, wardrobe);
            const api = env.api();
            if (!api || api.apiVersion !== 1 || typeof api.generate !== 'function') {
                update('请先启用或更新柏宝绘，再生成图片');
                return { status: 'failed', reason: 'provider-unavailable' };
            }
            if (!api.getBackendStatus?.()?.configured) {
                update('请先在柏宝绘中配置生图渠道');
                return { status: 'failed', reason: 'not-configured' };
            }
            const request = imageRequest(item, target.characterName);
            const result = await api.generate(request, {
                signal: owner.controller.signal,
                onProgress: progress => { if (env.owners.isCurrent(owner)) update(progressText(progress)); },
            });
            if (!env.owners.isCurrent(owner)) { current.message = '已取消本次操作'; return { status: 'cancelled' }; }
            // Pixels stay in BaiBai's gallery; diagnostics retain only returned reference fields.
            const path = typeof result?.path === 'string' ? result.path.trim() : '';
            if (!path) {
                diagnostic.rejected(new Error('gallery-save-failed'), { phase: 'save', reasonCode: 'wardrobe-image-gallery-save-failed' });
                update('图片已生成，但未保存到柏宝绘图库，请检查图库后重新生成');
                return { status: 'failed', reason: 'gallery-save-failed' };
            }
            diagnostic.accepted({ reasonCode: 'wardrobe-image-gallery-reference' });
            const image = { path, ...(Number.isFinite(result.seed) ? { seed: result.seed } : {}) };
            phase = 'save';
            // Merge each completed person reference into the latest saved wardrobe.
            const operation = referenceSave.then(async () => {
                const latest = target.read();
                if (wardrobeContentKey(latest) !== wardrobeKey || JSON.stringify(latest?.items?.[index]?.image || null) !== imageBefore) return { ok: false, reason: 'wardrobe-changed' };
                const next = { ...latest, items: latest.items.map((person, position) => position === index ? { ...person, image } : person) };
                return await target.write(next, { signal: owner.controller.signal, ownerGuard: () => env.owners.isCurrent(owner) });
            });
            referenceSave = operation.catch(() => {});
            const saved = await operation;
            if (saved?.reason === 'wardrobe-changed') {
                env.toast?.('衣橱方案或此人的配图已变化，本次图片仍保留在柏宝绘图库');
                return { status: 'changed' };
            }
            if (!(saved === true || saved?.ok === true)) {
                update('图片已保存在柏宝绘图库，但未能关联到衣橱');
                return { status: 'failed', reason: 'save' };
            }
            if (saved?.commitState === 'local-applied') diagnostic.locallyApplied({ reasonCode: 'wardrobe-image-local-applied' });
            else diagnostic.committed({ reasonCode: 'wardrobe-image-reference-saved' });
            current.message = '';
            return { status: 'updated', image };
        } catch (error) {
            if (owner.controller.signal.aborted || error?.code === 'aborted') { current.message = '已取消本次操作'; return { status: 'cancelled' }; }
            diagnostic.rejected(error, { phase, reasonCode: `wardrobe-image-${phase}-failed` });
            update(phase === 'save' ? '图片已保存在柏宝绘图库，但未能关联到衣橱' : failureText(error));
            return { status: 'failed', reason: phase };
        } finally {
            current.busy = false;
            delete current.owner;
            env.owners.finish(owner);
            redraw(index, wardrobeKey, wardrobe);
        }
    }
    function cancel(wardrobe, index) {
        const current = state(wardrobe, index);
        if (!current.owner) return false;
        current.owner.controller.abort('user-cancel');
        return true;
    }
    function cancelAll() {
        for (const current of states.values()) current.owner?.controller.abort('wardrobe-stopped');
    }
    return { run, state, cancel, cancelAll };
}
