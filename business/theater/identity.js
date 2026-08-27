export function resolveTheaterRegen(piece, fallbackInput = '') {
    const input = String(piece?.request || piece?.templateSource?.input || fallbackInput || '').trim();
    return { input, templateSource: piece?.templateSource?.input ? { ...piece.templateSource, input: String(piece.templateSource.input).trim() } : null };
}
