import { createGenerationDiagnosticScope } from '../../api/diagnostics.js';

export const DEFAULT_DAILY_MENU_IMAGE_RULES = [
    "以完整中文菜名开头，后接英文成菜描述。先用一句话写整道菜的共同形态、主体与盛放，再用两至四句写主要可见食材加工后的形状、相对大小、熟态和有辨识度的自然结构，组成连贯画面。保留Dish规定的切法与可见单位，薄片、小丁、碎末等不得改写为完整原料或泛称。颜色、纹理和位置紧贴对应食材，写清混合、覆盖、交叠、包裹、半浸等实际关系。通常100–160英文词，按菜品实际信息取舍，不凑字。",
    "以本菜应有的上桌状态描述食材，把烹调结果落实为对应食材可见的颜色、形变和表面质地，不只用cooked等泛词概括。需要煮、涮、炒等处理的部分应呈现处理后的外观；本就生食、半熟或脆嫩的部分按本菜保留，不统一褐变、软塌或煮老。熟度特征紧贴对应食材，不把一种状态套给整道菜。",
    "食材、做法、数量和加工状态以Dish及明确给定条件为准。已给定规格保留；没有精确尺寸时用自然的相对尺度，不自行编造厘米、毫米。只写该食材自然适用的可见结构，平滑表面保留平滑，不添加花纹。完整外皮和封口保留自然遮挡，不为展示原料强行切开、透明化或露馅；已混合、溶解或涂覆的材料只写最终结构。油脂和酱汁按本菜实际用量、浓度及附着或浸泡关系描述，不添加装饰、底料或配菜，不统一要求油亮、熟软、混合或切开。",
    "输出前核对：主体名词和切后形态是否对应Dish；描述是否足以区分主料与相似物；应熟制的食材是否呈现了本菜要求的熟度，而非下锅前的生料外观；是否用泛形容词代替了可见结构；少量配料或酱汁是否抢成主体；混合、包裹和遮挡关系是否保持。先修正发现的偏差，再用直接的画面描述输出最终Image，不输出核对过程或被排除的替代物。",
    "Image只写食物和盛放，不写制作步骤、风味感受、画师、画风、画质、灯光、背景、人物、文字或生成参数。专名英文不确定时保留中文原词，不换成相似食材。每道Dish后立即接对应Image，Image保持一行。",
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
