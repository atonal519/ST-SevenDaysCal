// 棱旧入口兼容层：生产宿主不再依赖本文件，也不在此保存可变状态。
// 新代码请直接使用 business/theater 的 feature/repository/templates/generation。
export { THEATER_KEY, THEATER_SCHEMA_VERSION, THEATER_DRAFT_CAP, THEATER_TEMPLATE_BOOK } from './business/theater/constants.js';
export { normalizeTheaterPiece, normalizeTheaterList, cloneTheaterPiece, cloneTheaterList, theaterPieceBaseline, sameTheaterPieceBaseline, theaterId } from './business/theater/schema.js';
export { resolveTheaterRegen } from './business/theater/identity.js';
export { sanitizeHtml, safePlainTextHtml } from './business/theater/html.js';
export { createTheaterGeneration } from './business/theater/generation.js';
export { createTheaterRepository } from './business/theater/repository.js';
export { createTheaterTemplates, parseTemplateText } from './business/theater/templates.js';
export { createTheaterFeature } from './business/theater/feature.js';
export { renderTheaterPieceHtml, renderTheaterSource } from './business/theater/render.js';
