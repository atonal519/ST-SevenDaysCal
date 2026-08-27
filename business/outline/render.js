import { parseOutline } from './schema.js';
import { renderActionMenu } from '../utils/action-menu.js';

export function createOutlineRenderer({ escapeHtml, cleanText, makeInjectButton, makeCopyButton, beginRender } = {}) {
    const esc = value => escapeHtml?.(String(value ?? '')) ?? String(value ?? '');
    const clean = value => cleanText?.(value) ?? String(value ?? '');
    const empty = () => {
        beginRender?.();
        return `<div class="sp-empty"><i class="fa-solid fa-scroll"></i><p>当前还没有面，可以先直接聊天讨论，也可以生成一版面作为起点</p><button class="sp-gen-btn sp-outline-gen-btn" id="sp-gen-outline-now">生成面</button></div>`;
    };
    const render = (raw, cursor = 0) => {
        beginRender?.();
        const beats = parseOutline(raw);
        const toolbar = `<div class="sp-panel-toolbar"><button class="sp-panel-refresh sp-refresh-outline" title="重新生成面"><i class="fa-solid fa-rotate-right"></i></button></div>`;
        if (!beats.length) return toolbar + `<div class="sp-raw">${esc(raw).replace(/\n/g, '<br>')}</div>`;
        const cards = beats.map((beat, index) => {
            const injectParts = [
                '【剧情节点参考】',
                `${beat.time}·《${beat.title}》${beat.type ? '·' + beat.type : ''}${beat.line ? '（' + beat.line + '）' : ''}`,
            ];
            if (beat.scene) injectParts.push(beat.scene);
            if (beat.outcome) injectParts.push(`结果：${beat.outcome}`);
            const injectId = makeInjectButton?.(injectParts.join('\n')) || '';
            const copyId = makeCopyButton?.([
                `${beat.time}·《${beat.title}》${beat.type ? '·' + beat.type : ''}${beat.line ? '（' + beat.line + '）' : ''}`,
                beat.outcome ? `结果：${clean(beat.outcome)}` : '',
                beat.scene ? clean(beat.scene) : '',
                beat.subtext ? `"${clean(beat.subtext)}"` : '',
            ].filter(Boolean).join('\n')) || '';
            const current = cursor >= 1 && index + 1 === cursor;
            const next = cursor >= 1 && index + 1 === cursor + 1;
            const highlight = current ? ' sp-beat-current' : (next ? ' sp-beat-next' : '');
            const badge = current
                ? `<span class="sp-beat-badge sp-beat-badge-cur">进行中</span>`
                : next ? `<span class="sp-beat-badge sp-beat-badge-next">预计下一步</span>` : '';
            const actions = renderActionMenu('outline', [
                { action: 'outline-edit', icon: 'fa-pen', label: '编辑', title: '编辑这个面' },
                { action: 'outline-current', icon: current ? 'fa-location-dot' : 'fa-location-crosshairs', label: current ? '取消当前' : '设为当前', title: current ? '取消当前剧情点' : '设为当前剧情点' },
                { action: 'outline-inject', icon: 'fa-arrow-right-to-bracket', label: '注入', title: '注入到输入框' },
                { action: 'outline-copy', icon: 'fa-copy', label: '复制', title: '复制这一步' },
                { action: 'outline-delete', icon: 'fa-trash', label: '删除', title: '删除这个面' },
            ], escapeHtml, value => String(value ?? '')).replace('data-menu-id="outline"', `data-menu-id="outline" data-idx="${index + 1}" data-iid="${injectId}" data-cid="${copyId}"`);
            return `
        <div class="sp-beat${highlight}">
            <div class="sp-beat-head">
                <span class="sp-beat-index">${index + 1}</span>
                ${badge}
                <span class="sp-beat-meta">
                    <span class="sp-beat-time">${esc(beat.time)}</span>
                    ${beat.type ? `<span class="sp-beat-type">${esc(beat.type)}</span>` : ''}
                </span>
                <span class="sp-beat-actions">${actions}</span>
            </div>
            ${beat.line ? `<span class="sp-beat-linerow">${esc(beat.line)}</span>` : ''}
            <div class="sp-beat-title">${esc(beat.title)}</div>
            ${beat.outcome ? `<div class="sp-beat-outcome">${esc(clean(beat.outcome))}</div>` : ''}
            ${beat.scene ? `<div class="sp-beat-scene">${esc(clean(beat.scene))}</div>` : ''}
            ${beat.subtext ? `<div class="sp-beat-subtext">"${esc(clean(beat.subtext))}"</div>` : ''}
            ${beat.think ? `<details class="sp-beat-think"><summary>创作思考</summary><p>${esc(clean(beat.think))}</p></details>` : ''}
        </div>`;
        }).join('');
        const rawDebug = beats.length < 3
            ? `<details class="sp-debug"><summary>⚠ 仅解析到 ${beats.length} 个节点</summary><pre class="sp-debug-raw">${esc(raw)}</pre></details>`
            : '';
        return toolbar + cards + rawDebug;
    };
    return Object.freeze({ render, empty });
}
