export const THEATER_KEY = 'sp-theater';
export const THEATER_SCHEMA_VERSION = 1;
export const THEATER_DRAFT_CAP = 10;
export const THEATER_TEMPLATE_BOOK = '构画-棱-小剧场模板';
export const theaterDraftKey = chatId => `sp-cache-${String(chatId ?? '')}-theater-draft-user`;
