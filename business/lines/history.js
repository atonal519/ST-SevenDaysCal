// Select the ordinary chat history window. System messages are hidden transport
// records (for example external summary layers), not conversational turns.
// The caller supplies the final content sanitizer so this helper stays unaware
// of prompt formatting and variable substitution.
export function selectVisibleChatHistory(messages = [], historyLimit = 3, { excludedAssistant = null, mapMessage = message => message } = {}) {
    if (!(Number(historyLimit) > 0)) return [];
    const all = Array.isArray(messages) ? messages : [];
    const visible = all.map((message, mesId) => ({ message, mesId })).filter(({ message }) => {
        if (!message || message.is_user || message.is_system || String(message.role || '').toLowerCase() === 'system') return false;
        return String(message.mes ?? '').trim().length > 0;
    });
    let visibleAiCount = 0;
    let startIdx = 0;
    for (let i = visible.length - 1; i >= 0; i--) {
        visibleAiCount++;
        if (visibleAiCount >= Number(historyLimit)) {
            startIdx = i;
            break;
        }
    }
    return visible.slice(startIdx)
        .filter(({ message, mesId }) => {
            if (!excludedAssistant) return true;
            return !(mesId === Number(excludedAssistant.mesId) && String(message?.mes ?? '') === String(excludedAssistant.text ?? ''));
        })
        .map(({ message }) => mapMessage(message));
}
