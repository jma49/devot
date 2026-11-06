//! Which of a web view's subviews loses the bar above the keyboard (`native::ios::input_accessory`),
//! decided from class names alone so that any other WebKit is left as it is.

/// WebKit's content view, the first responder of the page's fields.
pub(crate) const CONTENT_VIEW: &str = "WKContentView";
/// Appended to the content view's class name for its subclass without an input accessory view.
pub(crate) const HIDDEN_SUFFIX: &str = "_DevotNoInputAccessory";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Plan {
    Swap,
    AlreadyHidden,
    LeaveAlone,
}

/// A class of another name (a renamed or observed content view) is left alone, and so is one that
/// does not answer `inputAccessoryView`.
pub(crate) fn plan(class_name: &str, answers_input_accessory: bool) -> Plan {
    if class_name == hidden_name(CONTENT_VIEW) {
        Plan::AlreadyHidden
    } else if class_name == CONTENT_VIEW && answers_input_accessory {
        Plan::Swap
    } else {
        Plan::LeaveAlone
    }
}

pub(crate) fn hidden_name(class_name: &str) -> String {
    format!("{class_name}{HIDDEN_SUFFIX}")
}

pub(crate) fn content_view<S: AsRef<str>>(subview_classes: &[S]) -> Option<usize> {
    subview_classes.iter().position(|name| {
        let name = name.as_ref();
        name == CONTENT_VIEW || name == hidden_name(CONTENT_VIEW)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webkits_content_view_that_answers_is_swapped() {
        assert_eq!(plan("WKContentView", true), Plan::Swap);
    }

    #[test]
    fn a_content_view_without_the_property_is_left_alone() {
        assert_eq!(plan("WKContentView", false), Plan::LeaveAlone);
    }

    #[test]
    fn any_other_class_is_left_alone() {
        for name in [
            "WKWebView",
            "UIView",
            "NSKVONotifying_WKContentView",
            "WKContentViewNext",
            "",
        ] {
            assert_eq!(plan(name, true), Plan::LeaveAlone, "{name}");
        }
    }

    #[test]
    fn a_swapped_view_is_not_swapped_again() {
        assert_eq!(
            plan("WKContentView_DevotNoInputAccessory", true),
            Plan::AlreadyHidden
        );
        assert_eq!(
            plan("WKContentView_DevotNoInputAccessory", false),
            Plan::AlreadyHidden
        );
    }

    #[test]
    fn the_subclass_is_named_after_its_class() {
        assert_eq!(
            hidden_name("WKContentView"),
            "WKContentView_DevotNoInputAccessory"
        );
    }

    #[test]
    fn the_content_view_is_found_among_the_scroll_views_subviews() {
        assert_eq!(content_view(&["UIImageView", "WKContentView"]), Some(1));
        assert_eq!(
            content_view(&["WKContentView_DevotNoInputAccessory", "UIView"]),
            Some(0)
        );
        assert_eq!(content_view(&["UIView", "WKCompositingView"]), None);
        assert_eq!(content_view::<&str>(&[]), None);
    }
}
