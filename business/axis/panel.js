// Axis sheet orchestrator. Rendering details are injected from the host while
// axis mode and sheet state stay in the axis state container. This keeps the
// axis/ledger boundary explicit and avoids importing index.js from business.
import { axisState } from './state.js';

export function createAxisPanel(env) {
    return function renderAlmanacPanel(options = {}) {
        if (!axisState.almanacMode) return;
        const $wrap = env.$in('#sp-almanac-wrap');
        if (axisState._almanacManager) {
            if (env.refreshCalendarManager(options)) return;
            $wrap.html(env.renderCalendarManager());
            return;
        }
        if (axisState._almanacEditor) {
            $wrap.html(env.renderAlmanacEditor());
            env.almRenderWdHint();
            setTimeout(() => env.$in('#sp-alm-f-name').trigger('focus'), 30);
            return;
        }
        if (env.getLedgerEditor()) {
            $wrap.html(env.renderLedgerEditor());
            setTimeout(() => env.$in('#sp-led-f-gist').trigger('focus'), 30);
            return;
        }
        if (axisState.isGeneratingAlmanac) {
            $wrap.html(env.almToolbarHtml() + `<div class="sp-alm-body">${env.loadingHtml(env._almGenLabel(), 'sp-abort-almanac')}</div>`);
            return;
        }
        const bodyHtml = axisState._almanacSheet === 'ledger' ? env.renderLedgerSheet()
                       : axisState._almanacSheet === 'calendar' ? env.renderAlmanacCalendar()
                       : env.renderAlmanacUpcoming();
        $wrap.html(env.almToolbarHtml() + env.almTodayBarHtml() + env.storyClockBarHtml() + `<div class="sp-alm-body">${bodyHtml}</div>`);
    };
}
