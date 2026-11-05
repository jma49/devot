/** A price as text: a currency sign or code beside an amount, either way round, or an amount with cents. */
export const PRICE = /[$€£¥₩₹]\s?\d|\d\s?[$€£¥₩₹]|\b(?:USD|EUR|GBP|JPY|CNY)\b|\d+[.,]\d{2}\b/
