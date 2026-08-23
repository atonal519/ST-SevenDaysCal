const PREFIX = 'sp-lines-swipe-';

function normalizePart(value) {
    return String(value ?? '').replace(/[\u0000\n\r]/g, '');
}
export function swipeLinesKey(chatId, mesId) {
    const chat = normalizePart(chatId);
    const floor = normalizePart(mesId);
    return chat && floor ? `${PREFIX}${chat}-${floor}` : '';
}

export function createSwipeLinesStore({ storage = globalThis.localStorage } = {}) {
    const read = (chatId, mesId) => {
        const key = swipeLinesKey(chatId, mesId);
        if (!key || !storage?.getItem) return null;
        try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
    };
    const write = (chatId, mesId, value) => {
        const key = swipeLinesKey(chatId, mesId);
        if (!key || !storage?.setItem) return false;
        try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    };
    const clear = (chatId, mesId) => {
        const key = swipeLinesKey(chatId, mesId);
        if (!key || !storage?.removeItem) return false;
        try { storage.removeItem(key); return true; } catch { return false; }
    };
    const clearAll = chatId => {
        const prefix = `${PREFIX}${normalizePart(chatId)}-`;
        if (!prefix || prefix === PREFIX || !storage?.length || !storage?.key || !storage?.removeItem) return 0;
        const keys = [];
        try {
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key?.startsWith(prefix)) keys.push(key);
            }
            keys.forEach(key => storage.removeItem(key));
            return keys.length;
        } catch { return 0; }
    };
    return { key: swipeLinesKey, read, write, clear, clearAll };
}
