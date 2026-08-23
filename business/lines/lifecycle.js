export function createLinesLifecycle() {
    let lastSeenMaxMesId = -1;
    let pendingSwipeGen = null;
    let floorTextSig = Object.create(null);
    let pendingReroll = false;
    let rerollExcludedAssistant = null;
    let streamUntil = 0;
    let counter = 0;
    let lastDay = null;
    return {
        get lastSeenMaxMesId() { return lastSeenMaxMesId; },
        get pendingSwipeGen() { return pendingSwipeGen; },
        get floorTextSig() { return floorTextSig; },
        get pendingReroll() { return pendingReroll; },
        get rerollExcludedAssistant() { return rerollExcludedAssistant; },
        get streamUntil() { return streamUntil; },
        get counter() { return counter; },
        get lastDay() { return lastDay; },
        set lastSeenMaxMesId(value) { lastSeenMaxMesId = Number(value); },
        set pendingSwipeGen(value) { pendingSwipeGen = value; },
        set floorTextSig(value) { floorTextSig = value || Object.create(null); },
        set pendingReroll(value) { pendingReroll = !!value; },
        set rerollExcludedAssistant(value) { rerollExcludedAssistant = value; },
        set streamUntil(value) { streamUntil = Number(value) || 0; },
        set counter(value) { counter = Number(value) || 0; },
        set lastDay(value) { lastDay = value == null ? null : String(value); },
        detectInGameDayChange({ day, decide } = {}) {
            if (day == null || typeof decide !== 'function') return false;
            const normalized = String(day);
            const decision = decide({ mode: 'days', dayAnchor: normalized, previousDay: lastDay });
            lastDay = normalized;
            return !!decision?.shouldAdvance;
        },
        resetChat({ lastSeen = -1 } = {}) { lastSeenMaxMesId = Number(lastSeen); pendingSwipeGen = null; floorTextSig = Object.create(null); pendingReroll = false; rerollExcludedAssistant = null; streamUntil = 0; counter = 0; lastDay = null; },
        consumePendingReroll() { const value = pendingReroll; pendingReroll = false; return value; },
        markGenerationStarted({ reroll = false, excludedAssistant = null, now = Date.now() } = {}) { streamUntil = now + 3000; if (reroll) { pendingReroll = true; rerollExcludedAssistant = excludedAssistant; } },
        markToken({ now = Date.now() } = {}) { streamUntil = now + 1500; },
        endGeneration() { streamUntil = 0; pendingReroll = false; rerollExcludedAssistant = null; },
        markPendingSwipe(mesId) { pendingSwipeGen = { mesId: Number(mesId) }; },
        consumePendingSwipe(mesId) { if (!pendingSwipeGen || Number(pendingSwipeGen.mesId) !== Number(mesId)) return false; pendingSwipeGen = null; return true; },
        advanceCounter({ mode, interval } = {}) { if (mode === 'manual') return { shouldAdvance: false, counter }; const step = Number.isFinite(Number(interval)) && Number(interval) >= 1 ? Math.floor(Number(interval)) : 1; counter += 1; if (counter >= step) { counter = 0; return { shouldAdvance: true, counter }; } return { shouldAdvance: false, counter }; },
    };
}
