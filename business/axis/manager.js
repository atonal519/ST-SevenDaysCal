// Calendar manager boundary. The manager owns the public render/refresh
// contract; DOM-heavy form/template details are injected from the host so the
// business module has no dependency on index.js or Shadow DOM globals.
export function createCalendarManager(env) {
    return {
        renderCalendarManager: (...args) => env.renderLegacy(...args),
        refreshCalendarManager: (...args) => env.refreshLegacy(...args),
    };
}
