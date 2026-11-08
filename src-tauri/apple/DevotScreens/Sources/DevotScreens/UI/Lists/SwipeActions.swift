import UIKit

/// A note row's swipe actions: Trash and the status trailing, Pin leading (design/phone.md, Note
/// list rows). Each goes through the gate; a locked one closes the row before the gate's surface rises.
@MainActor
struct SwipeActions {
    let gate: ProGate

    func trailing(_ row: NoteRow) -> UISwipeActionsConfiguration {
        var actions = [
            action(
                .destructive, L10n.phoneActionTrash(), "trash", Tokens.Color.phoneActionTrash,
                .batch(ids: [row.id], change: .trash))
        ]
        if row.status != NoteStatus.completed.rawValue {
            actions.append(
                action(
                    .normal, L10n.phoneActionComplete(), "checkmark.circle", Tokens.Color.phoneActionStatus,
                    .complete(id: row.id)))
        }
        let configuration = UISwipeActionsConfiguration(actions: actions)
        configuration.performsFirstActionWithFullSwipe = true
        return configuration
    }

    func leading(_ row: NoteRow) -> UISwipeActionsConfiguration {
        let pin = action(
            .normal, row.pinned ? L10n.noteUnpin() : L10n.phoneActionPin(), row.pinned ? "pin.slash" : "pin",
            Tokens.Color.phoneActionPin, .batch(ids: [row.id], change: .pinned(!row.pinned)))
        let configuration = UISwipeActionsConfiguration(actions: [pin])
        configuration.performsFirstActionWithFullSwipe = true
        return configuration
    }

    private func action(
        _ style: UIContextualAction.Style, _ title: String, _ symbol: String, _ color: UIColor, _ intent: WriteIntent
    ) -> UIContextualAction {
        let gate = gate
        let action = UIContextualAction(style: style, title: title) { _, _, completion in
            MainActor.assumeIsolated {
                completion(!gate.locked())
                gate.require(intent)
            }
        }
        action.image = UIImage(systemName: symbol)
        action.backgroundColor = color
        return action
    }
}
