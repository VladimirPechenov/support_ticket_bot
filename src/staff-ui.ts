import cache from './cache';

// Shared visual vocabulary for the operator interface.
const emojis = {
  menu: ['5237889385441037272', '🟥'],
  field: ['5237801025078858956', '◻️'],
  ticket: ['5886473311637999700', '🏷'],
  list: ['5766994197705921104', '🗂'],
  folder: ['5257969839313526622', '📂'],
  search: ['5429571366384842791', '🔎'],
  settings: ['5870982283724328568', '⚙️'],
  take: ['5323761960829862762', '⚡️'],
  done: ['5260726538302660868', '✅'],
  close: ['5260342697075416641', '❌'],
  back: ['6039539366177541657', '⬅️'],
  waiting: ['5237912908976920243', '❗️'],
} as const;

export type StaffEmoji = keyof typeof emojis;
export interface StaffButton {
  text: string;
  callback_data?: string;
  copy_text?: {text: string};
  icon_custom_emoji_id?: string;
  style?: 'primary' | 'success' | 'danger';
}

let customEmojiAvailable = true;

function useCustomEmoji(): boolean {
  return customEmojiAvailable && cache.config.support?.custom_emoji !== false;
}

export function staffEmoji(name: StaffEmoji): string {
  const [id, fallback] = emojis[name];
  return useCustomEmoji() ?
    `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : fallback;
}

export function staffButton(
  name: StaffEmoji,
  text: string,
  action: {callback_data: string} | {copy_text: {text: string}},
  style?: StaffButton['style'],
): StaffButton {
  const [id, fallback] = emojis[name];
  return {
    text: useCustomEmoji() ? text : `${fallback} ${text}`,
    ...action,
    ...(useCustomEmoji() ? {icon_custom_emoji_id: id} : {}),
    ...(style ? {style} : {}),
  };
}

export function escapeStaffHtml(value: unknown, limit = 1000): string {
  const chars = Array.from(String(value ?? ''));
  const text = chars.length > limit ?
    `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function staffHtmlSnippet(value: unknown, budget = 260): string {
  let escaped = '';
  for (const character of String(value ?? '')) {
    const encoded = escapeStaffHtml(character);
    if (escaped.length + encoded.length > budget - 1) return `${escaped}…`;
    escaped += encoded;
  }
  return escaped;
}

export function stripCustomEmoji(payload: any): any {
  const next = {...payload};
  for (const field of ['text', 'caption']) {
    if (typeof next[field] === 'string') {
      next[field] = next[field].replace(/<tg-emoji\b[^>]*>(.*?)<\/tg-emoji>/gs, '$1');
    }
  }
  for (const field of ['entities', 'caption_entities']) {
    if (Array.isArray(next[field])) {
      next[field] = next[field].filter((entity: any) => entity.type !== 'custom_emoji');
    }
  }
  if (next.reply_markup?.inline_keyboard) {
    next.reply_markup = {
      ...next.reply_markup,
      inline_keyboard: next.reply_markup.inline_keyboard.map((row: any[]) =>
        row.map(({icon_custom_emoji_id: icon, ...button}) => {
          const fallback = Object.values(emojis).find(([id]) => id === icon)?.[1];
          return fallback ? {...button, text: `${fallback} ${button.text}`} : button;
        }),
      ),
    };
  }
  return next;
}

// Retry only emoji permission/validation errors; never retry a successful send.
export async function withStaffEmojiFallback(
  previous: any, method: any, payload: any, signal: any,
): Promise<any> {
  const request = customEmojiAvailable ? payload : stripCustomEmoji(payload);
  const result = await previous(method, request, signal);
  if (!result.ok && result.error_code === 400 &&
    /CUSTOM_EMOJI|custom emoji|emoji.*(?:invalid|not allowed)|PREMIUM.*REQUIRED/i
      .test(result.description || '') &&
    JSON.stringify(stripCustomEmoji(request)) !== JSON.stringify(request)) {
    customEmojiAvailable = false;
    return previous(method, stripCustomEmoji(request), signal);
  }
  return result;
}
