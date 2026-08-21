export function createLinesState() {
    let owner = null; let busy = false; let revision = 0;
    return { get owner() { return owner; }, get busy() { return busy; }, get revision() { return revision; }, start(taskOwner) { owner = taskOwner; busy = true; revision += 1; return owner; }, finish(taskOwner) { if (owner !== taskOwner) return false; owner = null; busy = false; return true; }, invalidate() { owner?.controller?.abort(); owner = null; busy = false; } };
}
