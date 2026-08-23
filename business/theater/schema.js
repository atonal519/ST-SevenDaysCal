export function normalizeTheaterPiece(piece) {
    if (!piece || typeof piece !== 'object' || !piece.id) return null;
    return { ...piece, id: String(piece.id) };
}

export function normalizeTheaterList(value) {
    return Array.isArray(value) ? value.map(normalizeTheaterPiece).filter(Boolean) : [];
}
