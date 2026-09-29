// Owner rule (09-29): no emojis anywhere on the site — preview cards and share text included. Token names/symbols come
// from their creators and can carry emojis or arrow/pictograph symbols; they render as emoji (or blank boxes in the card
// font). This strips pictographs, arrows, dingbats, variation selectors and zero-width joiners, then tidies the spaces.
const PICTO = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;
export const noEmoji = (s) => String(s == null ? '' : s).replace(PICTO, '').replace(/\s{2,}/g, ' ').trim();
