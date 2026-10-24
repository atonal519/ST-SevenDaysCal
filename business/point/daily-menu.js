import { createGenerationDiagnosticScope } from '../../api/diagnostics.js';

export const DEFAULT_DAILY_MENU_IMAGE_RULES = [
    "Image用中文说明最终可见的菜品构成，按『整体形态→可见主体、辅料和酱汁的加工后形状与状态→它们的组合和位置』连贯描述。区分各部分的形状厚薄、生熟及有辨识度的表面特征；写清拌合、覆盖、交叠、包裹、浸在汤汁中等实际关系。按菜品需要写充分，只写适用项，不为填项补食材。",
    "区分成品外表与内部组织，按正常成菜和盛放方式描述自然露出的主要部分。被完整外皮、不透明容器、浓汁或其他食材遮住的结构，不写成表面清晰可见；不为展示原料强行切开、透明化或拆散成品。",
    "食材、切法及生熟与Dish一致，汤汁、酱汁、外皮和馅料的颜色、透明度、稠度及形态不得改成另一种状态。已溶解、混合或加工成统一结构的材料，只描述最终结构，不还原成独立原料、颗粒或配菜；完整未切食物不强行展示内部或馅料。不擅加装饰或配菜，不统一要求油亮、软熟、切开或露馅。",
    "Image只写食物及盛放方式，不写食谱步骤、风味感受、画师、画风、画质、光照、背景、人物或文字。输出前逐菜核对可见配料、切法、加工状态及组合是否与该菜Dish和给定条件一致，删除无依据的新增部分，只输出菜单，不展示核对过程。",
    "Image以完整中文菜名开头。",
].join('\n');

// A menu is a small, user-owned point-panel note. It is deliberately not a
// point event and is never included in point injection or schedule rendering.
export function buildDailyMenuPrompt({ storyDate = null, previousMenu = null, imageRules = '' } = {}) {
    const dateLine = storyDate ? `故事日期：${storyDate}。` : '故事日期未确认。';
    const previousNames = Array.isArray(previousMenu?.items)
        ? previousMenu.items.map(item => String(item?.name || '').trim()).filter(Boolean).slice(0, 6)
        : [];
    const repeatLine = previousNames.length
        ? `换一份，尽量避开上次：${previousNames.join('、')}。`
        : '';
    return [
        "结合世界设定、角色近况、供餐条件和可得食材拟4–6道合宜菜单。优先选择自然有主辅搭配、结构或口感层次的菜，不为复杂凑配料；简单菜也可以保留。语气轻松俏皮，菜单文字不用emoji。",
        "已给定的菜品、食材和处理方式优先于菜名联想或常见配方；未给定的部分才自行设计，不添加与已知做法矛盾的新加工。",
        "逐道确定一份成菜方案，先写Dish，再紧接该菜的Image，写完一菜再写下一菜。Image只描述本菜已经确定的构成，不从库存、其他菜或常见摆盘另取配料。",
        "Dish用1–2句写清主要与辅助食材、可见调味、关键处理和烹调方式及成菜口感。凡会在Image中出现的配料、酱汁和点缀，都先在Dish交代。",
        String(imageRules || '').trim() ? imageRules : DEFAULT_DAILY_MENU_IMAGE_RULES,
        "严格沿用格式：",
        "Title: 短主题",
        "Intro: 一小段菜单介绍或选菜理由",
        "Dish: 菜名 | 类别 | 1–2句说明",
        "Image: 成菜构成描述",
        "每道Dish后立即跟一行Image，不使用JSON或额外字段。",
        dateLine + repeatLine,
    ].filter(Boolean).join('\n');
}

function cleanCell(value) {
    return String(value ?? '').replace(/<[^>]*>/g, '').trim();
}

export function parseDailyMenu(raw) {
    const result = { title: '', items: [] };
    const text = String(raw ?? '').replace(/\r/g, '');
    let imageFor = null;
    for (const original of text.split('\n')) {
        let line = original.trim();
        if (!line || /^```/.test(line)) continue;
        line = line.replace(/^(?:>\s*|#{1,6}\s*|[-*•]\s*|\d+[.、)）]\s*)+/, '').replace(/^`+|`+$/g, '').trim();
        if (!line) continue;
        const image = line.match(/^(?:image|imageprompt|image[ _-]description|绘图描述|配图描述|图像描述)\s*[:：]\s*(.*)$/i);
        if (image) {
            const value = cleanCell(image[1]);
            if (imageFor && value) imageFor.imagePrompt = value;
            imageFor = null;
            continue;
        }
        imageFor = null;
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
        imageFor = { name: cells[0], category: cells[1], description: cells.slice(2).join(' | ') };
        result.items.push(imageFor);
    }
    result.title ||= '今日菜单';
    return result;
}

export function renderDailyMenuHtml(menu, { escapeHtml = value => String(value), busy = false } = {}) {
    const items = (Array.isArray(menu?.items) ? menu.items : []).map((item, index) => ({ item, index })).filter(({ item }) => item && typeof item === 'object'
        && String(item.name || '').trim() && String(item.category || '').trim() && String(item.description || '').trim());
    const body = items.length
        ? `<div class="sp-daily-menu-items">${items.map(({ item, index }) => `<article class="sp-daily-menu-item sp-daily-menu-image" data-menu-image-index="${index}"><header class="sp-daily-menu-item-head"><div class="sp-daily-menu-item-title"><strong>${escapeHtml(String(item.name))}</strong><span class="sp-daily-menu-category">${escapeHtml(String(item.category))}</span></div><div class="sp-daily-menu-image-tools"><button type="button" class="sp-daily-menu-image-toggle sp-daily-menu-image-pill" aria-label="查看${escapeHtml(String(item.name))}的配图" title="查看配图" aria-expanded="false" aria-controls="sp-daily-menu-image-region-${index}">${item.image?.path ? '已生成' : '未生成'}</button><button type="button" class="sp-daily-menu-image-pill sp-daily-menu-image-action sp-daily-menu-image-generate" aria-label="${item.image?.path ? '重新生成' : '生成'}${escapeHtml(String(item.name))}的配图" title="${item.image?.path ? '重新生成' : '生成图片'}">生图</button></div></header><p class="sp-daily-menu-description">${escapeHtml(String(item.description))}</p><div class="sp-daily-menu-image-body" id="sp-daily-menu-image-region-${index}" role="region" aria-label="${escapeHtml(String(item.name))}的配图" aria-hidden="true" inert></div></article>`).join('')}</div>`
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
            const response = await env.generate(buildDailyMenuPrompt({ storyDate, previousMenu: before, imageRules: env.imageRules?.() }), owner.controller.signal, diagnostic.sink);
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
