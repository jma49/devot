use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use zeroize::Zeroizing;

use super::super::client;
use super::super::cloudkit;
use super::super::{MAX_RECORD_BYTES, file_record};
use super::{LiveRef, MAX_SAFE, PullDto, PulledDto, PushDto, PushItemDto, SyncService};

/// Most records one batched push takes: the engine sends at most 100.
const MAX_BATCH: usize = 200;

/// A record to push, checked as the command's arguments: its plaintext.
fn checked_item(
    id: &str,
    base: u64,
    data: &str,
    kind: &str,
) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    if !matches!(kind, "record" | "file") {
        return Err("E_SYNC_KIND_INVALID");
    }
    if !crate::commands::notes::valid_note_id(id) {
        return Err("E_SYNC_ID_INVALID");
    }
    if base >= MAX_SAFE {
        return Err("E_SYNC_VERSION_INVALID");
    }
    if data.len() > MAX_RECORD_BYTES.div_ceil(3) * 4 {
        return Err("E_SYNC_TOO_LARGE");
    }
    let plaintext = Zeroizing::new(
        STANDARD
            .decode(data.as_bytes())
            .map_err(|_| "E_SYNC_RECORD_INVALID")?,
    );
    if plaintext.is_empty() {
        return Err("E_SYNC_RECORD_INVALID");
    }
    if kind == "file" {
        file_record::check(id, &plaintext).inspect_err(|code| {
            log::warn!("W_SYNC_FILE_REFUSED {code} id={id}");
        })?;
    }
    Ok(plaintext)
}

/// A pulled record for the engine. An attachment is checked as a paste is, before the web view sees it.
fn pulled(
    id: String,
    name: String,
    version: u64,
    seq: Option<u64>,
    tag: String,
    kind: String,
    plaintext: Result<Zeroizing<Vec<u8>>, &'static str>,
) -> PulledDto {
    let opened = plaintext.and_then(|bytes| {
        if kind == "file" {
            file_record::check(&id, &bytes)?;
        }
        Ok(bytes)
    });
    let (data, error) = match opened {
        Ok(bytes) => (Some(STANDARD.encode(bytes.as_slice())), None),
        Err(code) => {
            if kind == "record" {
                log::warn!("W_SYNC_RECORD_UNREADABLE {code} id={id}");
            } else if kind == "file" {
                log::warn!("W_SYNC_FILE_REFUSED {code} id={id}");
            }
            (None, Some(code))
        }
    };
    PulledDto {
        id,
        name,
        version,
        seq,
        tag,
        kind,
        data,
        error,
    }
}

fn push_dto(answer: cloudkit::PushAnswer) -> PushDto {
    match answer {
        cloudkit::PushAnswer::Pushed { version, tag } => PushDto::Pushed {
            version,
            seq: None,
            tag,
        },
        cloudkit::PushAnswer::Rejected { version, tag } => PushDto::Rejected { version, tag },
        cloudkit::PushAnswer::Paused { until, code } => {
            log::info!("I_SYNC_ICLOUD_PAUSED {code} until={}", until.unwrap_or(0));
            PushDto::Paused {
                until,
                limit: None,
                code: Some(code),
            }
        }
        cloudkit::PushAnswer::Failed(code) => PushDto::Failed { code },
    }
}

impl SyncService {
    pub(crate) fn pull(&self, since: &str) -> Result<PullDto, &'static str> {
        match self.live()? {
            LiveRef::Relay(connection, vault) => {
                let page = client::pull(&connection, &vault, client::seq_of(since)?)?;
                Ok(PullDto {
                    records: page
                        .records
                        .into_iter()
                        .map(|r| {
                            pulled(
                                r.id,
                                r.name,
                                r.version,
                                Some(r.seq),
                                String::new(),
                                r.kind,
                                r.plaintext,
                            )
                        })
                        .collect(),
                    next: client::cursor_of(page.next),
                    more: page.more,
                })
            }
            LiveRef::ICloud(icloud) => {
                let page = icloud.pull(since)?;
                Ok(PullDto {
                    records: page
                        .records
                        .into_iter()
                        .map(|r| pulled(r.id, r.name, r.version, None, r.tag, r.kind, r.plaintext))
                        .collect(),
                    next: page.next,
                    more: page.more,
                })
            }
        }
    }

    pub(crate) fn push(
        &self,
        id: &str,
        base: u64,
        data: &str,
        kind: &str,
        tag: &str,
    ) -> Result<PushDto, &'static str> {
        let plaintext = checked_item(id, base, data, kind)?;
        let (connection, vault) = match self.live()? {
            LiveRef::Relay(connection, vault) => (connection, vault),
            LiveRef::ICloud(icloud) => {
                let item = cloudkit::Item {
                    id,
                    base,
                    tag,
                    plaintext: &plaintext,
                    kind,
                };
                return match icloud.push_many(&[item], self.now()).pop() {
                    Some(cloudkit::PushAnswer::Failed(code)) => Err(code),
                    Some(answer) => Ok(push_dto(answer)),
                    None => Err("E_SYNC_INTERNAL"),
                };
            }
        };
        match client::push(&connection, &vault, id, base, &plaintext, kind) {
            Ok(client::PushReply::Pushed { version, seq }) => Ok(PushDto::Pushed {
                version,
                seq: Some(seq),
                tag: String::new(),
            }),
            Ok(client::PushReply::Rejected { version }) => Ok(PushDto::Rejected {
                version,
                tag: String::new(),
            }),
            Ok(client::PushReply::Full) => {
                log::info!("I_SYNC_ATTACHMENTS_FULL id={id}");
                Ok(PushDto::Full)
            }
            Ok(client::PushReply::Paused { until, limit }) => {
                log::info!(
                    "I_SYNC_QUOTA_PAUSED until={} limit={}",
                    until.unwrap_or(0),
                    limit.unwrap_or("unknown")
                );
                Ok(PushDto::Paused {
                    until,
                    limit,
                    code: None,
                })
            }
            Err("E_SYNC_TOO_LARGE") => {
                log::warn!("W_SYNC_TOO_LARGE id={id}");
                Err("E_SYNC_TOO_LARGE")
            }
            Err(code) => Err(code),
        }
    }

    /// A batch on iCloud, in modify operations within its caps; one answer per item, in order. The
    /// relay takes one push at a time, which the engine runs itself (`pushOneByOne`).
    pub(crate) fn push_many(&self, items: &[PushItemDto]) -> Result<Vec<PushDto>, &'static str> {
        if items.len() > MAX_BATCH {
            return Err("E_SYNC_BATCH_TOO_LARGE");
        }
        let total: usize = items.iter().map(|i| i.data.len()).sum();
        if total > MAX_RECORD_BYTES.div_ceil(3) * 4 {
            return Err("E_SYNC_BATCH_TOO_LARGE");
        }
        let LiveRef::ICloud(icloud) = self.live()? else {
            return Err("E_SYNC_BATCH_UNSUPPORTED");
        };
        // A tag that is not one (one kept from before a switch, say) fails its item alone.
        let checked: Vec<Result<Zeroizing<Vec<u8>>, &'static str>> = items
            .iter()
            .map(|i| {
                if crate::commands::sync::valid_tag(&i.tag) {
                    checked_item(&i.id, i.base, &i.data, &i.kind)
                } else {
                    Err(cloudkit::error::TAG_INVALID)
                }
            })
            .collect();
        let ready: Vec<cloudkit::Item<'_>> = items
            .iter()
            .zip(&checked)
            .filter_map(|(item, plaintext)| {
                Some(cloudkit::Item {
                    id: &item.id,
                    base: item.base,
                    tag: &item.tag,
                    plaintext: plaintext.as_ref().ok()?,
                    kind: &item.kind,
                })
            })
            .collect();
        let mut answers = icloud.push_many(&ready, self.now()).into_iter();
        Ok(checked
            .iter()
            .map(|plaintext| match plaintext {
                Err(code) => PushDto::Failed { code },
                Ok(_) => answers.next().map_or(
                    PushDto::Failed {
                        code: "E_SYNC_INTERNAL",
                    },
                    push_dto,
                ),
            })
            .collect())
    }
}
