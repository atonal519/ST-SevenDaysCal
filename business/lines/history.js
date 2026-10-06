// Select the ordinary chat history window. System messages are hidden transport
// records (for example external summary layers), not conversational turns.
// The caller supplies the final content sanitizer so this helper stays unaware
// of prompt formatting and variable substitution.
export function selectVisibleChatHistory(messages = [], historyLimit = 3, { excludedAssistant = null, mapMessage = message => message } = {}) {
    if (!(Number(historyLimit) > 0)) return [];
    const all = Array.isArray(messages) ? messages : [];
    const visible = all.map((message, mesId) => ({ message, mesId })).filter(({ message }) => {
        if (!message || message.is_user || message.is_system || message.is_hidden || message?.extra?.is_hidden || String(message.role || '').toLowerCase() === 'system') return false;
        return String(message.mes ?? '').trim().length > 0;
    });
    return visible.filter(({ message, mesId }) => {
            if (!excludedAssistant) return true;
            return !(mesId === Number(excludedAssistant.mesId) && String(message?.mes ?? '') === String(excludedAssistant.text ?? ''));
        })
        .slice(-Math.floor(Number(historyLimit)))
        .map(({ message, mesId }) => mapMessage(message, mesId));
}
