import { createGenerationDiagnosticScope } from '../../api/diagnostics.js';

// Images belong to the text of one menu; adding a different dish's image does
// not change that ownership or prevent independent dish requests from merging.
export function dailyMenuContentKey(menu) {
    return JSON.stringify([menu?.generatedAt, menu?.storyDate, menu?.title, menu?.intro,
        (menu?.items || []).map(item => [item?.name, item?.category, item?.description, item?.imagePrompt])]);
}

function imageRequest(item, characterName = '未命名角色') {
    const description = `${item.name}。${item.description}`;
    const visual = String(item.imagePrompt || '').trim() || description;
    return {
        prompt: `food, still life, a single finished dish, ${visual}, plated food, no people, no text, no menu lettering`,
        save: true,
        character: characterName,
        size: 'landscape',
    };
}

const progressText = progress => ({ queued: '正在排队…', 'queued-remote': '正在排队…', generating: '正在绘制…', retrying: '柏宝绘正在重试…', saving: '正在保存到图库…' })[progress?.phase] || '正在绘制…';
function failureText(error) {
    if (error?.code === 'rate_limited') return '生图请求过于频繁，请稍后再试';
    if (error?.code === 'not_configured') return '请先在柏宝绘中配置生图渠道';
    return '图片生成失败，请检查柏宝绘后重试';
}

export function createDailyMenuImageController(env) {
    const states = new Map();
    let referenceSave = Promise.resolve();
    const stateKey = (menu, index) => `${dailyMenuContentKey(menu)}:${index}`;
    const state = (menu, index) => states.get(stateKey(menu, index)) || {};
    function redraw(index, menuKey, menu) { env.render?.({ index, menuKey, menu }); }
    async function run(index) {
        const target = env.capture();
        const menu = target?.read();
        const item = menu?.items?.[index];
        if (!item?.name || !item?.description) return { status: 'missing' };
        const key = stateKey(menu, index), menuKey = dailyMenuContentKey(menu);
        if (states.get(key)?.busy) return { status: 'busy' };
        // Keep only this menu's UI messages and requests still doing real work.
        for (const [oldKey, value] of states) if (!value.busy && !oldKey.startsWith(`${menuKey}:`)) states.delete(oldKey);
        const owner = env.owners.create(`point-daily-menu-image-${index}`);
        const diagnostic = createGenerationDiagnosticScope('menu-image');
        const current = { busy: true, message: '正在准备绘图…', owner };
        states.set(key, current);
        const update = message => { current.message = message; redraw(index, menuKey, menu); };
        const imageBefore = JSON.stringify(item.image || null);
        let phase = 'generate';
        try {
            redraw(index, menuKey, menu);
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
                diagnostic.rejected(new Error('gallery-save-failed'), { phase: 'save', reasonCode: 'menu-image-gallery-save-failed' });
                update('图片已生成，但未保存到柏宝绘图库，请检查图库后重新生成');
                return { status: 'failed', reason: 'gallery-save-failed' };
            }
            diagnostic.accepted({ reasonCode: 'menu-image-gallery-reference' });
            const image = { path, ...(Number.isFinite(result.seed) ? { seed: result.seed } : {}) };
            phase = 'save';
            // Merge each completed dish reference into the latest saved menu.
            const operation = referenceSave.then(async () => {
                const latest = target.read();
                if (dailyMenuContentKey(latest) !== menuKey || JSON.stringify(latest?.items?.[index]?.image || null) !== imageBefore) return { ok: false, reason: 'menu-changed' };
                const next = { ...latest, items: latest.items.map((dish, position) => position === index ? { ...dish, image } : dish) };
                return await target.write(next, { signal: owner.controller.signal, ownerGuard: () => env.owners.isCurrent(owner) });
            });
            referenceSave = operation.catch(() => {});
            const saved = await operation;
            if (saved?.reason === 'menu-changed') {
                env.toast?.('菜单或这道菜的配图已变化，本次图片仍保留在柏宝绘图库');
                return { status: 'changed' };
            }
            if (!(saved === true || saved?.ok === true)) {
                update('图片已保存在柏宝绘图库，但未能关联到菜单');
                return { status: 'failed', reason: 'save' };
            }
            if (saved?.commitState === 'local-applied') diagnostic.locallyApplied({ reasonCode: 'menu-image-local-applied' });
            else diagnostic.committed({ reasonCode: 'menu-image-reference-saved' });
            current.message = '';
            return { status: 'updated', image };
        } catch (error) {
            if (owner.controller.signal.aborted || error?.code === 'aborted') { current.message = '已取消本次操作'; return { status: 'cancelled' }; }
            diagnostic.rejected(error, { phase, reasonCode: `menu-image-${phase}-failed` });
            update(phase === 'save' ? '图片已保存在柏宝绘图库，但未能关联到菜单' : failureText(error));
            return { status: 'failed', reason: phase };
        } finally {
            current.busy = false;
            delete current.owner;
            env.owners.finish(owner);
            redraw(index, menuKey, menu);
        }
    }
    function cancel(menu, index) {
        const current = state(menu, index);
        if (!current.owner) return false;
        current.owner.controller.abort('user-cancel');
        return true;
    }
    return { run, state, cancel };
}
