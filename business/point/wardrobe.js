import { createGenerationDiagnosticScope } from '../../api/diagnostics.js';
import { escapeHtml as escapeText } from '../../utils/dom.js';

export function buildWardrobePrompt({ storyDate = null, previousWardrobe = null } = {}) {
    return [
        '依据当前场景与最近正文，同一次判断当前在场且有依据的人物，并为每人整理一套今天穿点啥方案。人物可以是用户、当前角色或配角；数量由当前剧情决定，不固定我/TA两槽，不从点事件或重要角色名单筛人，也不把世界书里出现过的人都当作在场。不要把未来规划当作已经发生的情景。',
        '正文已写明的衣服、颜色、层次、穿着状态与配饰先准确还原；没有写明的部分结合世界设定、天气、活动和人物习惯自由补齐。不限外出或正装，不给所有人套同一模板。已知外貌保留，没有依据的外貌不伪装为已知设定。',
        'Person给人看的说明只写颜色、款式和主要单品的短关键词，用“·”分隔，适合一两行，不写穿搭缘由或剧情复述。Scene只用一句简短地点、天气和活动概述。每个人的短说明和对应Image在同一次回复确定；Image保留完整服装细节，不因短说明省略细节。Image只呈现该人的这套服装与有依据的外貌，写清款式、颜色、层次、鞋和必要配饰，是单人全身上身图，不是服装平铺。人物之间不得混用服装，不从旧角色固定着装另取衣服。Image结合当前场景与人物活动描述合适的自然动作、姿态，视角自然选择，避免统一默认站姿；不套固定动作或镜头模板，不另加背景、新画风、画师、画质或生成参数。Image用连贯英文画面描述，可保留中文专名。',
        '这只是独立衣橱推荐，不表示人物已换装，不修改真实剧情穿着、角色卡或角色库。不输出点事件或应用卡。',
        '格式：\nTitle: 短主题\nScene: 一句简短场景\nPerson: 人物姓名 | 颜色、款式和主要单品的短关键词\nImage: 紧邻此Person的英文上身图描述\n逐人重复Person与Image，每个字段占一行；无当前可识别人物时只在Title、Scene后写People: NONE，如实说明，不补造人物。',
        storyDate ? `故事日期：${storyDate}。以材料中的当前故事时点理解当下。` : '故事日期未确认，以最近正文的当前场景为准。',
        previousWardrobe?.items?.length ? `上次方案人物：${previousWardrobe.items.map(item => item.name).join('、')}。这只是上次参考；本次仍由当前剧情决定在场人物，正文已确定的着装保持。` : '',
    ].filter(Boolean).join('\n\n');
}

const clean = value => String(value ?? '').replace(/<[^>]*>/g, '').trim();
export function parseWardrobe(raw) {
    const result = { title: '', scene: '', items: [] };
    let pending = null, explicitEmpty = false, personRows = 0;
    for (const original of String(raw ?? '').replace(/\r/g, '').split('\n')) {
        const line = original.trim().replace(/^(?:>\s*|#{1,6}\s*|[-*•]\s*|\d+[.、)）]\s*)+/, '').replace(/^`+|`+$/g, '').trim();
        if (!line || /^```/.test(line)) continue;
        const image = line.match(/^(?:Image|ImagePrompt|配图描述)\s*[:：]\s*(.*)$/i);
        if (image) {
            const value = clean(image[1]);
            if (pending && value) { pending.imagePrompt = value; result.items.push(pending); }
            pending = null;
            continue;
        }
        pending = null;
        const person = line.match(/^(?:Person|人物)\s*[:：]\s*(.*)$/i);
        if (person) {
            personRows++;
            const [name, ...description] = person[1].split(/[|｜]/).map(clean);
            if (name && description.join(' | ')) pending = { name, description: description.join(' | ') };
            continue;
        }
        const title = line.match(/^(?:Title|标题)\s*[:：]\s*(.*)$/i);
        const scene = line.match(/^(?:Scene|场景)\s*[:：]\s*(.*)$/i);
        if (title && !result.title) result.title = clean(title[1]);
        if (scene && !result.scene) result.scene = clean(scene[1]);
        if (/^People\s*[:：]\s*NONE\s*$/i.test(line)) explicitEmpty = true;
    }
    result.title ||= '今天穿点啥';
    if (explicitEmpty && !personRows && result.scene) result.empty = true;
    return result;
}

export function formatWardrobeText(value) {
    if (!value || (!Array.isArray(value.items) && !value.empty)) return '';
    const items = Array.isArray(value.items) ? value.items : [];
    if (!items.length && !value.empty) return '';
    return [`【已存衣橱｜只读推荐】${value.title || '今天穿点啥'}${value.storyDate ? `｜${value.storyDate}` : ''}`, value.scene || '',
        ...items.map(item => `- ${item.name}：${item.description}`), value.empty ? '当前情景未识别可搭配人物。' : '',
    ].filter(Boolean).join('\n');
}

export function renderWardrobeHtml(wardrobe, { escapeHtml = escapeText, busy = false } = {}) {
    const items = (Array.isArray(wardrobe?.items) ? wardrobe.items : []).map((item,index)=>({item,index})).filter(({item})=>item?.name && item?.description);
    const body = items.length ? `<div class="sp-wardrobe-items">${items.map(({item,index})=>`<article class="sp-wardrobe-item sp-wardrobe-image" data-wardrobe-image-index="${index}"><header class="sp-wardrobe-item-head"><div class="sp-wardrobe-item-title"><strong>${escapeHtml(item.name)}</strong></div><div class="sp-wardrobe-image-tools"><button type="button" class="sp-wardrobe-image-toggle sp-wardrobe-image-pill" aria-expanded="false" aria-controls="sp-wardrobe-image-region-${index}" title="查看配图" aria-label="查看${escapeHtml(item.name)}的配图">${item.image?.path ? '已生成' : '未生成'}</button><button type="button" class="sp-wardrobe-image-pill sp-wardrobe-image-action sp-wardrobe-image-generate" title="生成图片" aria-label="生成${escapeHtml(item.name)}的配图">生图</button></div></header><p class="sp-wardrobe-description">${escapeHtml(item.description)}</p><div class="sp-wardrobe-image-body" id="sp-wardrobe-image-region-${index}" role="region" aria-label="${escapeHtml(item.name)}的配图" aria-hidden="true" inert></div></article>`).join('')}</div>` : `<p class="sp-wardrobe-empty">${wardrobe?.empty ? '当前情景未识别可搭配人物' : '还没有衣橱方案'}</p>`;
    const date = wardrobe?.storyDate ? `<span class="sp-wardrobe-date">${escapeHtml(wardrobe.storyDate)}</span>` : '';
    const title = wardrobe ? `<h3>${escapeHtml(wardrobe.title || '今天穿点啥')}</h3>${wardrobe.scene ? `<p class="sp-wardrobe-intro"><em>${escapeHtml(wardrobe.scene)}</em></p>` : ''}` : '';
    return `<section class="sp-wardrobe-card" aria-label="今天穿点啥"><div class="sp-wardrobe-header"><strong>今天穿点啥</strong>${date}</div>${title}${body}<button type="button" class="sp-gen-btn ${busy ? 'sp-wardrobe-cancel' : 'sp-wardrobe-generate'}">${busy ? '取消生成' : wardrobe ? '重新生成' : '生成方案'}</button></section>`;
}

export function createWardrobeController(env) {
    let activeOwner = null, busy = false;
    const render = () => { try { env.render?.({ busy }); } catch { env.toast?.('界面刷新失败', null, true); } };
    async function run() {
        const owner = env.owners.create('point-wardrobe', { chatId: env.chatId() });
        activeOwner = owner; busy = true; render();
        const diagnostic = createGenerationDiagnosticScope('wardrobe');
        let phase = 'request';
        try {
            const storyDate = env.storyDate();
            const response = await env.generate(buildWardrobePrompt({ storyDate, previousWardrobe: env.read() }), owner.controller.signal, diagnostic.sink);
            if (!env.owners.isCurrent(owner)) return { status: 'cancelled' };
            phase = 'parse';
            const value = parseWardrobe(response);
            if (!value.items.length && !value.empty) throw new Error('wardrobe-incomplete');
            diagnostic.accepted({ reasonCode: 'wardrobe-valid' });
            value.storyDate = storyDate || null; value.generatedAt = Date.now();
            phase = 'save';
            const saved = await env.write(value, { signal: owner.controller.signal, ownerGuard: () => env.owners.isCurrent(owner) });
            if (!(saved === true || saved?.ok)) throw new Error('save-rejected');
            if (saved?.commitState === 'local-applied') diagnostic.locallyApplied({ reasonCode: 'wardrobe-local-applied' });
            else diagnostic.committed({ reasonCode: 'wardrobe-saved' });
            env.toast?.('衣橱已更新');
            return { status: 'updated', wardrobe: value };
        } catch (error) {
            if (owner.controller.signal.aborted || !env.owners.isCurrent(owner)) return { status: 'cancelled' };
            diagnostic.rejected(error, { phase, reasonCode: `wardrobe-${phase}-failed` });
            env.toast?.(phase === 'parse' ? '衣橱内容不完整，请重试' : phase === 'save' ? '衣橱保存失败，请重试' : '衣橱生成失败，请重试', null, true);
            return { status: 'failed', reason: phase };
        } finally {
            if (activeOwner === owner) { activeOwner = null; busy = false; render(); }
            env.owners.finish(owner);
        }
    }
    function cancel(reason = 'user-cancel') {
        if (!activeOwner) return false;
        const owner = activeOwner; activeOwner = null; busy = false;
        owner.controller.abort(reason); env.owners.finish(owner); render();
        return true;
    }
    return { run, cancel, busy: () => busy };
}
