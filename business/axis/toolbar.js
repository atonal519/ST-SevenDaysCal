import { axisState } from './state.js';

export function renderAxisToolbar(actionMenuHtml) {
    const onLedger = axisState._almanacSheet === 'ledger';
    return `<div class="sp-alm-toolbar">
        <div class="sp-alm-sheet-toggle">
            <button class="sp-alm-sheet-btn${axisState._almanacSheet === 'upcoming' ? ' sp-alm-sheet-active' : ''}" data-sheet="upcoming">即将到来</button>
            <button class="sp-alm-sheet-btn${axisState._almanacSheet === 'calendar' ? ' sp-alm-sheet-active' : ''}" data-sheet="calendar">日历</button>
            <button class="sp-alm-sheet-btn${onLedger ? ' sp-alm-sheet-active' : ''}" data-sheet="ledger">刻度</button>
        </div>
        ${onLedger ? `<div class="sp-alm-tools sp-alm-tools-placeholder" aria-hidden="true" inert>
            <button class="sp-icon-btn" tabindex="-1" aria-hidden="true"><i class="fa-solid fa-plus"></i></button>
            <div class="sp-alm-wide-tools"><button class="sp-icon-btn" tabindex="-1" aria-hidden="true"></button><button class="sp-icon-btn" tabindex="-1" aria-hidden="true"></button><button class="sp-icon-btn" tabindex="-1" aria-hidden="true"></button></div>
            <div class="sp-alm-narrow-tools"><button class="sp-icon-btn" tabindex="-1" aria-hidden="true"></button></div>
        </div>` : `<div class="sp-alm-tools">
            <button class="sp-icon-btn sp-alm-add" title="手动添加日期" aria-label="手动添加日期"><i class="fa-solid fa-plus"></i></button>
            <div class="sp-alm-wide-tools">
                <button class="sp-icon-btn sp-alm-gen" title="生成节日（AI 按世界观铺满一整年）" aria-label="生成节日"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
                <button class="sp-icon-btn sp-alm-supplement" title="补录纪念日（只增补新里程碑，不重铺、不动现有日历）" aria-label="补录纪念日"><i class="fa-solid fa-heart-circle-plus"></i></button>
                <button class="sp-icon-btn sp-alm-manage" title="历法管理" aria-label="历法管理"><i class="fa-solid fa-calendar-days"></i></button>
            </div>
            <div class="sp-alm-narrow-tools">${actionMenuHtml('almanac')}</div>
        </div>`}
    </div>`;
}
