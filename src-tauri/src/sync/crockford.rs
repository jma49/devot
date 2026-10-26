//! Crockford base32 for what people copy by hand: the recovery key and the pairing code. Reading
//! forgives case, spaces, hyphens and the look-alikes O (zero) and I, L (one).

use zeroize::Zeroizing;

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// `bytes` in groups of `group` characters joined by hyphens.
pub(super) fn encode(bytes: &[u8], group: usize) -> Zeroizing<String> {
    let chars = (bytes.len() * 8).div_ceil(5);
    let mut out = Zeroizing::new(String::with_capacity(chars + chars / group));
    let mut acc: u16 = 0;
    let mut bits = 0;
    let mut written = 0;
    let mut push = |value: u16, out: &mut String| {
        if written > 0 && written % group == 0 {
            out.push('-');
        }
        out.push(ALPHABET[usize::from(value & 0x1f)] as char);
        written += 1;
    };
    for &byte in bytes {
        acc = (acc << 8) | u16::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            push(acc >> bits, &mut out);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        push(acc << (5 - bits), &mut out);
    }
    out
}

/// The bytes of exactly `chars` symbols, or `None` for anything else (a stray character, another
/// length, padding bits that are not zero).
pub(super) fn decode(text: &str, chars: usize) -> Option<Zeroizing<Vec<u8>>> {
    let mut bytes = Zeroizing::new(Vec::with_capacity(chars * 5 / 8));
    let mut acc: u16 = 0;
    let mut bits = 0;
    let mut read = 0;
    for c in text.chars() {
        if c == '-' || c.is_whitespace() {
            continue;
        }
        let value = symbol(c)?;
        read += 1;
        if read > chars {
            return None;
        }
        acc = (acc << 5) | u16::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    (read == chars && acc == 0).then_some(bytes)
}

fn symbol(c: char) -> Option<u8> {
    let c = match c.to_ascii_uppercase() {
        'O' => '0',
        'I' | 'L' => '1',
        c => c,
    };
    ALPHABET
        .iter()
        .position(|&a| a as char == c)
        .map(|i| i as u8)
}
