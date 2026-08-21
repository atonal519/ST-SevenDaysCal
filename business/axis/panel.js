// Axis sheet orchestrator. Rendering details are injected from the host while
// axis mode and sheet state stay in the axis state container. This keeps the
// axis/ledger boundary explicit and avoids importing index.js from business.
import { axisState } from './state.js';

const ledgerScrollState = { snapshot: null, generation: 0, pendingFrame: null, currentRenderedMode: 'unknown' };

function cancelLedgerScrollRestore() {
    if (ledgerScrollState.pendingFrame != null) {
        (globalThis.cancelAnimationFrame || clearTimeout)(ledgerScrollState.pendingFrame);
        ledgerScrollState.pendingFrame = null;
    }
    ledgerScrollState.generation++;
}

function captureLedgerScroll($wrap) {
    const body = $wrap.find('.sp-alm-body').first().get?.(0);
    if (!body) return null;
    const rows = [...body.querySelectorAll('.sp-ledger-row[data-id]')];
    const rect = body.getBoundingClientRect();
    const visible = rows.find(row => {
        const r = row.getBoundingClientRect();
        return r.bottom > rect.top && r.top < rect.bottom;
    });
    return {
        scrollTop: body.scrollTop,
        id: visible?.getAttribute('data-id') || null,
        nextId: visible?.nextElementSibling?.matches?.('.sp-ledger-row[data-id]') ? visible.nextElementSibling.getAttribute('data-id') : null,
        prevId: visible?.previousElementSibling?.matches?.('.sp-ledger-row[data-id]') ? visible.previousElementSibling.getAttribute('data-id') : null,
        offset: visible ? visible.getBoundingClientRect().top - rect.top : 0,
        sheet: 'ledger',
        generation: ledgerScrollState.generation,
    };
}

function scheduleLedgerScrollRestore($wrap, snapshot) {
    cancelLedgerScrollRestore();
    if (!snapshot || snapshot.sheet !== 'ledger') return;
    const generation = ledgerScrollState.generation;
    const apply = () => {
        ledgerScrollState.pendingFrame = null;
        if (generation !== ledgerScrollState.generation || axisState._almanacSheet !== 'ledger') return;
        const body = $wrap.find('.sp-alm-body').first().get?.(0);
        if (!body) return;
        const rows = [...body.querySelectorAll('.sp-ledger-row[data-id]')];
        const target = [snapshot.id, snapshot.nextId, snapshot.prevId]
            .filter(Boolean)
            .map(id => rows.find(row => row.getAttribute('data-id') === id))
            .find(Boolean);
        if (target) {
            const rect = body.getBoundingClientRect();
            body.scrollTop += target.getBoundingClientRect().top - rect.top - snapshot.offset;
        } else {
            const max = Math.max(0, body.scrollHeight - body.clientHeight);
            body.scrollTop = Math.min(Math.max(0, snapshot.scrollTop), max);
        }
        if (ledgerScrollState.snapshot?.generation === snapshot.generation) ledgerScrollState.snapshot = null;
    };
    ledgerScrollState.pendingFrame = (globalThis.requestAnimationFrame || (fn => setTimeout(fn, 0)))(apply);
}

export function createAxisPanel(env) {
    return function renderAlmanacPanel(options = {}) {
        if (!axisState.almanacMode) return;
        const $wrap = env.$in('#sp-almanac-wrap');
        const oldMode = ledgerScrollState.currentRenderedMode;
        if (oldMode === 'ledger-list' && ledgerScrollState.pendingFrame == null) {
            const current = captureLedgerScroll($wrap);
            if (current) ledgerScrollState.snapshot = { ...current, generation: ledgerScrollState.generation };
        }
        const ledgerEditor = env.getLedgerEditor();
        const targetMode = axisState._almanacManager ? 'calendar-manager'
            : axisState._almanacEditor ? 'almanac-editor'
            : ledgerEditor ? 'ledger-editor'
            : axisState.isGeneratingAlmanac ? 'ledger-loading'
            : axisState._almanacSheet === 'ledger' ? 'ledger-list'
            : axisState._almanacSheet === 'calendar' ? 'calendar'
            : 'upcoming';
        if (targetMode === 'ledger-list' && oldMode !== 'ledger-list' && oldMode !== 'ledger-editor') ledgerScrollState.snapshot = null;
        if (targetMode !== 'ledger-list') cancelLedgerScrollRestore();
        const finish = () => {
            ledgerScrollState.currentRenderedMode = targetMode;
            if (targetMode === 'ledger-list') scheduleLedgerScrollRestore($wrap, ledgerScrollState.snapshot);
        };
        if (axisState._almanacManager) {
            if (env.refreshCalendarManager(options)) { finish(); return; }
            $wrap.html(env.renderCalendarManager());
            finish();
            return;
        }
        if (axisState._almanacEditor) {
            $wrap.html(env.renderAlmanacEditor());
            env.almRenderWdHint();
            setTimeout(() => env.$in('#sp-alm-f-name').trigger('focus'), 30);
            finish();
            return;
        }
        if (ledgerEditor) {
            $wrap.html(env.renderLedgerEditor());
            setTimeout(() => env.$in('#sp-led-f-gist').trigger('focus'), 30);
            finish();
            return;
        }
        if (axisState.isGeneratingAlmanac) {
            $wrap.html(env.almToolbarHtml() + `<div class="sp-alm-body">${env.loadingHtml(env._almGenLabel(), 'sp-abort-almanac')}</div>`);
            finish();
            return;
        }
        const bodyHtml = axisState._almanacSheet === 'ledger' ? env.renderLedgerSheet()
                       : axisState._almanacSheet === 'calendar' ? env.renderAlmanacCalendar()
                       : env.renderAlmanacUpcoming();
        $wrap.html(env.almToolbarHtml() + env.almTodayBarHtml() + env.storyClockBarHtml() + `<div class="sp-alm-body">${bodyHtml}</div>`);
        finish();
    };
}
