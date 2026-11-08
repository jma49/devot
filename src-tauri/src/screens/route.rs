//! The phone router (docs/specs/iphone-screens.md, Routes): what a deep link shows on the iPhone's
//! native screens. A route names screens by kind and ID only; Swift builds them, and the page is
//! asked for nothing but today's note.

#[cfg(test)]
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::message::{Mode, ROUTE_NOTICE, VERSION};
use crate::commands::notes::valid_note_id;
use crate::deep_link::{LicenceKey, Link};

/// A tab a route can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(rename_all = "lowercase")]
pub enum Tab {
    Notes,
    Library,
}

/// A screen above a tab's root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Screen {
    Editor {
        #[serde(rename = "noteId")]
        note_id: String,
    },
    Trash {},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(Deserialize))]
#[serde(tag = "route", rename_all = "lowercase", deny_unknown_fields)]
pub enum Route {
    /// The tab, with these screens above its root and nothing else.
    Stack { tab: Tab, stack: Vec<Screen> },
    /// Today's note, which the page finds or makes (a write the gate holds), in the editor.
    Today {},
    /// Settings > License with the key filled in, waiting for the owner's Add; never submitted.
    Licence { prefill: Option<LicenceKey> },
    /// The editor's mode, when a note is on top; nothing otherwise.
    Mode { mode: Mode },
}

/// The route of a link Rust has parsed, or none for a link the phone does nothing with.
pub fn route(link: &Link) -> Option<Route> {
    match link {
        Link::Note { id } if valid_note_id(id) => Some(Route::Stack {
            tab: Tab::Notes,
            stack: vec![Screen::Editor {
                note_id: id.clone(),
            }],
        }),
        Link::Note { .. } | Link::Import { .. } => None,
        Link::Today => Some(Route::Today {}),
        Link::Licence { key, .. } => Some(Route::Licence {
            prefill: key.clone(),
        }),
        Link::Command { id } => command(id),
    }
}

/// The commands that only show something the phone has; the others do nothing there.
fn command(id: &str) -> Option<Route> {
    match id {
        "view.allNotes" => Some(Route::Stack {
            tab: Tab::Notes,
            stack: Vec::new(),
        }),
        "view.trash" => Some(Route::Stack {
            tab: Tab::Library,
            stack: vec![Screen::Trash {}],
        }),
        "view.edit" => Some(Route::Mode { mode: Mode::Edit }),
        "view.preview" => Some(Route::Mode {
            mode: Mode::Preview,
        }),
        _ => None,
    }
}

/// The `route` notice Rust sends Swift itself.
pub fn notice(route: &Route) -> Value {
    let mut message = Map::new();
    message.insert("v".into(), json!(VERSION));
    message.insert("notice".into(), json!(ROUTE_NOTICE));
    if let Ok(Value::Object(fields)) = serde_json::to_value(route) {
        message.extend(fields);
    }
    Value::Object(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deep_link::{SCHEME, URL_COMMANDS, parse};

    const ID: &str = "01890a5d-ac96-774b-bcce-b302099a8057";

    fn note_route(id: &str) -> Route {
        Route::Stack {
            tab: Tab::Notes,
            stack: vec![Screen::Editor {
                note_id: id.to_owned(),
            }],
        }
    }

    fn link(url: &str) -> Link {
        parse(&format!("{SCHEME}://{url}"), SCHEME).expect("a link")
    }

    #[test]
    fn every_link_has_one_route_or_none() {
        assert_eq!(route(&link(&format!("note/{ID}"))), Some(note_route(ID)));
        assert_eq!(route(&link("today")), Some(Route::Today {}));
        let licence = link("licence?key=devot1.abc.def");
        let Link::Licence { key, .. } = &licence else {
            panic!("a licence link")
        };
        assert_eq!(
            route(&licence),
            Some(Route::Licence {
                prefill: key.clone()
            })
        );
        let refused = Link::Licence {
            key: None,
            offer: None,
            code: Some("E_LICENCE_SIGNATURE"),
        };
        assert_eq!(route(&refused), Some(Route::Licence { prefill: None }));
        let import = Link::Import {
            scan: crate::import::Scan {
                id: 1,
                name: String::new(),
                kind: crate::import::Kind::Files,
                files: Vec::new(),
                images: Vec::new(),
                skipped: Vec::new(),
                destination: None,
            },
            notebook: None,
            first: None,
        };
        assert_eq!(route(&import), None);
        let shown: Vec<(&str, Option<Route>)> = URL_COMMANDS
            .iter()
            .map(|id| (*id, route(&Link::Command { id })))
            .collect();
        assert_eq!(
            shown,
            vec![
                ("palette.open", None),
                (
                    "view.allNotes",
                    Some(Route::Stack {
                        tab: Tab::Notes,
                        stack: vec![]
                    })
                ),
                (
                    "view.trash",
                    Some(Route::Stack {
                        tab: Tab::Library,
                        stack: vec![Screen::Trash {}]
                    })
                ),
                ("view.focus", None),
                ("view.togglePreview", None),
                ("view.split", None),
                ("view.write", None),
                ("view.edit", Some(Route::Mode { mode: Mode::Edit })),
                (
                    "view.preview",
                    Some(Route::Mode {
                        mode: Mode::Preview
                    })
                ),
                ("app.backups", None),
                ("app.checkForUpdates", None),
            ]
        );
    }

    #[test]
    fn a_note_whose_id_is_not_valid_has_no_route() {
        for id in [
            "",
            "inbox",
            &ID.to_uppercase(),
            "01890a5d-ac96-474b-bcce-b302099a8057",
        ] {
            let note = Link::Note { id: id.to_owned() };
            assert_eq!(route(&note), None, "{id}");
        }
    }

    #[test]
    fn a_route_reaches_swift_as_a_notice_of_kinds_and_ids() {
        assert_eq!(
            notice(&note_route(ID)),
            json!({ "v": 1, "notice": "route", "route": "stack", "tab": "notes",
                    "stack": [{ "kind": "editor", "noteId": ID }] })
        );
        assert_eq!(
            notice(&Route::Today {}),
            json!({ "v": 1, "notice": "route", "route": "today" })
        );
        assert_eq!(
            notice(&Route::Licence { prefill: None }),
            json!({ "v": 1, "notice": "route", "route": "licence", "prefill": null })
        );
        assert_eq!(
            notice(&Route::Mode {
                mode: Mode::Preview
            }),
            json!({ "v": 1, "notice": "route", "route": "mode", "mode": "preview" })
        );
    }

    #[test]
    fn a_licence_route_never_shows_its_key_when_debugged() {
        let Some(route) = route(&link("licence?key=devot1.abc.def")) else {
            panic!("a route")
        };
        assert!(!format!("{route:?}").contains("abc"));
        assert_eq!(notice(&route)["prefill"], json!("devot1.abc.def"));
    }
}
