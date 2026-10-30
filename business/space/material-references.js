// Select concrete stored identifiers, without deciding what the user wants to do.
export function selectTheaterReference(message, pieces = [], templates = []) {
    const text = String(message || '');
    const quotes = [...text.matchAll(/[“「"]([^”」"]{1,100})[”」"]/gu)].map(match => match[1].trim());
    const seenPieces = new Set();
    const uniquePieces = pieces.filter(piece => {
        const id = String(piece.id ?? '').trim();
        if (!id || typeof piece.raw !== 'string') return true;
        const key = JSON.stringify([id, piece.title, piece.raw]);
        if (seenPieces.has(key)) return false;
        seenPieces.add(key);
        return true;
    });
    const matches = [
        ...uniquePieces.map(piece => ({ piece, template: null, title: String(piece.title || '').trim() })),
        ...templates.map(template => ({ piece: null, template, title: String(template.title || '').trim() })),
    ].filter(item => item.title && (quotes.includes(item.title) || item.title.length >= 3 && text.includes(item.title)));
    return matches.length === 1 ? { piece: matches[0].piece, template: matches[0].template } : { piece: null, template: null };
}

export function selectCoordinateReference(message, items = []) {
    const text = String(message || '');
    const floors = [...new Set([...text.matchAll(/(?:第\s*)?(\d+)\s*(?:楼|层)/gu)].map(match => Number(match[1])))];
    const quote = text.match(/[“「"]([^”」"]{3,100})[”」"]/u)?.[1]?.trim();
    let matches = [];
    if (floors.length && /收藏|坐标/u.test(text)) {
        if (floors.length !== 1) return null;
        matches = items.filter(item => Number(item.floorIndex ?? item.messageId) === floors[0]);
    } else if (quote) {
        matches = items.filter(item => String(item.textPreview || '').includes(quote));
    }
    return matches.length === 1 ? matches[0] : null;
}
