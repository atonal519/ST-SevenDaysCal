import { createGenerationDiagnosticScope } from '../../api/diagnostics.js';

// A menu is a small, user-owned point-panel note. It is deliberately not a
// point event and is never included in point injection or schedule rendering.
export function buildDailyMenuPrompt({ storyDate = null, previousMenu = null } = {}) {
    const dateLine = storyDate ? `故事日期：${storyDate}。` : '故事日期未确认。';
    const previousNames = Array.isArray(previousMenu?.items)
        ? previousMenu.items.map(item => String(item?.name || '').trim()).filter(Boolean).slice(0, 6)
        : [];
    const repeatLine = previousNames.length
        ? `换一份，尽量避开上次：${previousNames.join('、')}。`
        : '';
    return [
        '请结合当前世界观、角色近况及当地可得食材拟合宜菜单，优先符合供餐条件；在设定内变化菜系、食材和做法，建议4–6道，语气轻松俏皮，菜单文字不用emoji。',
        '按格式回复：Title: 短主题；Intro: 一小段菜单介绍或选菜理由；每道一行 Dish: 菜名 | 类别 | 短说明。',
        dateLine + repeatLine,
    ].filter(Boolean).join('\n');
}

function cleanCell(value) {
    return String(value ?? '').replace(/<[^>]*>/g, '').trim();
}

export function parseDailyMenu(raw) {
    const result = { title: '', items: [] };
    const text = String(raw ?? '').replace(/\r/g, '');
    for (const original of text.split('\n')) {
        let line = original.trim();
        if (!line || /^```/.test(line)) continue;
        line = line.replace(/^(?:>\s*|#{1,6}\s*|[-*•]\s*|\d+[.、)）]\s*)+/, '').replace(/^`+|`+$/g, '').trim();
        if (!line) continue;
        const heading = line.match(/^(?:title|标题|今日菜单|菜单主题)\s*[:：]\s*(.+)$/i);
        if (heading && !result.title) {
            result.title = cleanCell(heading[1]);
            continue;
        }
        const intro = line.match(/^(?:intro|简介|介绍|说明|菜单介绍|选菜理由)\s*[:：]\s*(.*)$/i);
        if (intro) {
            const value = cleanCell(intro[1]);
            if (value && !result.intro) result.intro = value;
            continue;
        }
        const dish = line.match(/^(?:dish|菜品|餐品|菜)\s*[:：]\s*(.+)$/i);
        if (!dish) continue;
        const cells = dish[1].split(/[|｜]/).map(cleanCell);
        if (cells.length < 3 || !cells[0] || !cells[1] || !cells.slice(2).join(' | ')) continue;
        result.items.push({ name: cells[0], category: cells[1], description: cells.slice(2).join(' | ') });
    }
    result.title ||= '今日菜单';
    return result;
}

export function renderDailyMenuHtml(menu, { escapeHtml = value => String(value), busy = false } = {}) {
    const items = (Array.isArray(menu?.items) ? menu.items : []).filter(item => item && typeof item === 'object'
        && String(item.name || '').trim() && String(item.category || '').trim() && String(item.description || '').trim());
    const body = items.length
        ? `<div class="sp-daily-menu-items">${items.map(item => `<article class="sp-daily-menu-item"><strong>${escapeHtml(String(item.name))}</strong><span class="sp-daily-menu-category">${escapeHtml(String(item.category))}</span><p>${escapeHtml(String(item.description))}</p></article>`).join('')}</div>`
        : '<p class="sp-daily-menu-empty">还没有菜单</p>';
    const date = menu?.storyDate ? `<span class="sp-daily-menu-date">${escapeHtml(String(menu.storyDate))}</span>` : '';
    const intro = String(menu?.intro || '').trim();
    const introHtml = intro ? `<p class="sp-daily-menu-intro"><em>${escapeHtml(intro)}</em></p>` : '';
    const action = busy
        ? '<button class="sp-gen-btn sp-daily-menu-cancel" type="button">取消生成</button>'
        : `<button class="sp-gen-btn sp-daily-menu-generate" type="button">${items.length ? '换一份' : '生成菜单'}</button>`;
    return `<section class="sp-daily-menu-card" aria-label="今日菜单"><div class="sp-daily-menu-header"><strong>今日菜单</strong>${date}</div>${items.length ? `<h3>${escapeHtml(String(menu?.title || '今日菜单'))}</h3>${introHtml}` : ''}${body}${action}</section>`;
}

export function createDailyMenuController(env) {
    let activeOwner = null;
    let busy = false;
    const updateBusy = (value, redraw = true) => {
        busy = !!value;
        if (!redraw) return;
        try { env.render?.({ busy }); }
        catch { env.toast?.('界面刷新失败', null, true); }
    };
    async function run() {
        const owner = env.owners.create('point-daily-menu', { chatId: env.chatId() });
        activeOwner = owner;
        updateBusy(true);
        const diagnostic = createGenerationDiagnosticScope('point');
        let applied = false;
        let phase = 'request';
        try {
            const before = env.read();
            const storyDate = env.storyDate();
            const response = await env.generate(buildDailyMenuPrompt({ storyDate, previousMenu: before }), owner.controller.signal, diagnostic.sink);
            if (!env.owners.isCurrent(owner)) return { status: 'cancelled' };
            phase = 'parse';
            const menu = parseDailyMenu(response);
            if (!menu.items.length) {
                const error = new Error('menu-incomplete');
                error.dailyMenuIncomplete = true;
                throw error;
            }
            diagnostic.accepted({ phase: 'validation', reasonCode: 'daily-menu-valid' });
            menu.storyDate = storyDate || null;
            menu.generatedAt = Date.now();
            phase = 'save';
            const saved = await env.write(menu, { signal: owner.controller.signal, ownerGuard: () => env.owners.isCurrent(owner) });
            if (!(saved === true || saved?.ok === true)) throw new Error(saved?.reason || 'save-rejected');
            applied = true;
            if (saved?.commitState === 'local-applied') diagnostic.locallyApplied({ reasonCode: 'daily-menu-local-applied' });
            else diagnostic.committed({ reasonCode: 'daily-menu-saved' });
            if (activeOwner !== owner || !env.owners.isCurrent(owner)) return { status: 'cancelled', committed: true };
            updateBusy(false, false);
            phase = 'ui';
            try {
                env.render?.({ menu: env.read(), busy: false });
                env.toast?.('菜单已更新');
                diagnostic.uiDisplayed({ reasonCode: 'daily-menu-ui-applied' });
            } catch (error) {
                diagnostic.uiFailed(error, { reasonCode: 'daily-menu-ui-refresh-failed' });
                env.toast?.('内容已更新，界面刷新失败', null, true);
                return { status: 'updated', uiError: true };
            }
            return { status: 'updated', menu };
        } catch (error) {
            if (owner.controller.signal.aborted || !env.owners.isCurrent(owner)) return { status: 'cancelled', committed: applied };
            const message = error?.dailyMenuIncomplete ? '菜单内容不完整，请重试' : phase === 'save' ? '菜单保存失败，请重试' : '菜单生成失败，请重试';
            diagnostic.rejected(error, { phase, reasonCode: error?.dailyMenuIncomplete ? 'daily-menu-incomplete' : `daily-menu-${phase}-failed` });
            env.toast?.(message, null, true);
            return { status: 'failed', reason: error?.dailyMenuIncomplete ? 'incomplete' : phase, error };
        } finally {
            if (activeOwner === owner) {
                activeOwner = null;
                updateBusy(false, !applied);
            }
            env.owners.finish(owner);
        }
    }
    function cancel(reason = 'user-cancel') {
        if (!activeOwner) return false;
        const owner = activeOwner;
        activeOwner = null;
        owner.controller.abort(reason);
        env.owners.finish(owner);
        updateBusy(false);
        return true;
    }
    return { run, cancel, busy: () => busy };
}
