//! How a push of many records is cut into modify operations (ADR 0015, Batches): at most 200
//! records, about 1.5 MB of inline bytes (under the 2 MB a request without assets may carry, as the
//! probe measured), and 16 MB of assets (not verified; #607 measures it). A record over a cap on
//! its own goes alone; CloudKit says `limitExceeded` if it cannot take it, and the batch is halved.

use std::ops::Range;

use super::encoding::Size;

pub(crate) const MAX_RECORDS: usize = 200;
pub(crate) const MAX_INLINE_BYTES: usize = 1_500_000;
pub(crate) const MAX_ASSET_BYTES: usize = 16_000_000;

/// Consecutive runs of `sizes`, in order, each within the caps unless it is one record.
pub(crate) fn plan(sizes: &[Size]) -> Vec<Range<usize>> {
    let mut runs = Vec::new();
    let mut start = 0;
    let mut inline = 0;
    let mut assets = 0;
    for (at, size) in sizes.iter().enumerate() {
        let fits = at - start < MAX_RECORDS
            && inline + size.inline <= MAX_INLINE_BYTES
            && assets + size.assets <= MAX_ASSET_BYTES;
        if !fits && at > start {
            runs.push(start..at);
            start = at;
            inline = 0;
            assets = 0;
        }
        inline += size.inline;
        assets += size.assets;
    }
    if start < sizes.len() {
        runs.push(start..sizes.len());
    }
    runs
}

/// A run CloudKit refused as too large, in two.
pub(crate) fn halve(run: Range<usize>) -> [Range<usize>; 2] {
    let middle = run.start + run.len().div_ceil(2);
    [run.start..middle, middle..run.end]
}
