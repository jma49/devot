import Foundation

/// What the Sync pane shows, row by row, for a snapshot and the pane's own state: the page's phone
/// layout (`SyncSection.tsx`), kept apart from SwiftUI so tests read it.
enum SyncLayout {
    enum Path: Equatable {
        case first, another
    }

    enum Usage: Equatable {
        case reading
        case ready(StorageView)
        case failed(code: String)
    }

    enum Stored: Equatable {
        case reading
        case ready(Int)
        case failed(code: String)
    }

    struct Input: Equatable {
        var snapshot: SyncSnapshot
        var icloud = ICloudStatus.none
        /// Why sync is locked, while it is.
        var locked: String?
        var now = Date()
        var recoveryKey: String?
        var path: Path?
        var relayChosen: Bool?
        var usage = Usage.reading
        var stored = Stored.reading
        var devices: [SyncDevice]?
        var devicesProblem: String?
        var pairingEnded: String?
        var askingLeaveKey = false
    }

    struct Row: Equatable, Identifiable {
        enum Control: Equatable {
            case none
            case buy
            case toggle(on: Bool, disabled: Bool)
            case useICloudInstead
            case relayField
            case actions([ICloudAttention.Action])
            case retryUsage
            case moveToICloud
            case recoveryKey(String)
            case setupChoice
            case changeSetup
            case secret(connect: Bool, cancellable: Bool)
            case join(recovery: Bool, icloud: Bool)
            case relayAdvanced
            case transportQuestion(declined: Bool, blocked: Bool)
            case retryDevices
            case devices([SyncDevice], icloud: Bool)
            case pairing
            case leaveVault
            case leaveICloud
            case leaveICloudKey
        }

        /// The catalog key of the row's label, or of a note's text.
        let key: String
        let text: String
        var control = Control.none
        var note = false

        var id: String { "\(key)|\(note)|\(controlName)" }

        private var controlName: String {
            switch control {
            case .join(let recovery, _): recovery ? "recovery" : "code"
            case .devices: "devices"
            default: ""
            }
        }
    }

    struct Section: Equatable, Identifiable {
        let id: String
        var rows: [Row]
        var footer: String?
        /// Where Pair a Device lands.
        var pairing = false
    }

    private static func note(_ key: String, _ text: String? = nil) -> Row {
        Row(key: key, text: text ?? catalog(key), note: true)
    }

    static func sections(_ input: Input) -> [Section] {
        let snapshot = input.snapshot
        let status = snapshot.status
        let onICloud = snapshot.onICloud
        let inVault = snapshot.inVault
        let locked = input.locked != nil
        let attention = ICloudAttention.of(snapshot)
        let line = attention.map { SyncText.icloudLine($0, snapshot, input.icloud, now: input.now) }
        let statusLine = attention.map(\.outsideStatus) == false ? line : nil

        var main: [Row] = []
        if let why = input.locked { main.append(Row(key: "licenceSettings.title", text: why, control: .buy)) }
        if attention == .joined, let line { main.append(note("syncSettings.icloudJoined", line.text)) }
        main.append(
            Row(
                key: "syncSettings.enabled", text: catalog("phone.sync.hint"),
                control: .toggle(on: snapshot.enabled, disabled: !onICloud && snapshot.relayUrl.isEmpty)))
        if onICloud || (snapshot.enrolled && input.icloud.available) { main.append(transport(snapshot, offer: false)) }
        let held = !snapshot.enrolled && snapshot.vault && !onICloud
        if (snapshot.enrolled || held) && !onICloud { main.append(relay("phone.sync.relayHint")) }
        let shown = snapshot.shownState
        if statusLine != nil || !(shown == "idle" || shown == "off") {
            let text =
                statusLine.map { line in
                    snapshot.enabled ? ([line.text] + SyncText.details(snapshot)).joined(separator: " ") : line.text
                } ?? SyncText.status(snapshot, input.now)
            main.append(Row(key: "syncSettings.status", text: text, control: .actions(statusLine?.actions ?? [])))
        }
        main += stateNotes(snapshot)
        let footer =
            !snapshot.enabled
            ? catalog("phone.sync.notesStay")
            : status.lastSync.map { L10n.fill(catalog("phone.sync.lastSynced"), ["time": SyncText.shortTime($0)]) }
                ?? catalog("syncSettings.neverSynced")
        var sections = [Section(id: "main", rows: main, footer: footer)]

        if onICloud {
            sections.append(
                Section(
                    id: "storage", rows: [Row(key: "syncSettings.icloudStorage", text: storedText(input.stored))],
                    footer: catalog("syncSettings.icloudStorageManaged")))
        } else if snapshot.enrolled {
            sections.append(Section(id: "usage", rows: usageRows(input.usage, snapshot)))
        }
        if snapshot.enrolled, !onICloud, input.icloud.account == "available", attention != .moved,
            attention != .movedHere
        {
            sections.append(
                Section(
                    id: "move",
                    rows: [
                        Row(
                            key: "syncSettings.switchTransport", text: catalog("syncSettings.switchTransportHint"),
                            control: .moveToICloud)
                    ]))
        }
        if let key = input.recoveryKey {
            sections.append(
                Section(
                    id: "recovery",
                    rows: [
                        Row(
                            key: "syncSettings.recovery",
                            text: catalog(onICloud ? "syncSettings.recoveryHintIcloud" : "syncSettings.recoveryHint"),
                            control: .recoveryKey(key))
                    ]))
        }
        if !inVault {
            sections.append(Section(id: "setup", rows: setupRows(input, attention: attention, line: line), pairing: true))
        } else {
            sections.append(Section(id: "devices", rows: devicesRows(input)))
        }
        if snapshot.rotatedAway {
            let rows =
                onICloud
                ? [note("syncSettings.rotatedAwayIcloud")] + joinRows(icloud: true)
                : [note("syncSettings.rotatedAway")] + joinRows(icloud: false)
            sections.append(Section(id: "rotated", rows: rows))
        }
        if inVault, !snapshot.rotatedAway {
            let hint = input.pairingEnded ?? (onICloud ? "syncSettings.pairHintIcloud" : "syncSettings.pairHint")
            sections.append(
                Section(
                    id: "pairing", rows: [Row(key: "syncSettings.pair", text: catalog(hint), control: .pairing)],
                    pairing: true))
        }
        if onICloud {
            let row =
                input.askingLeaveKey
                ? Row(key: "syncSettings.icloudLeaveKey", text: catalog("syncSettings.icloudLeaveKeyHint"), control: .leaveICloudKey)
                : Row(key: "syncSettings.icloudLeave", text: catalog("syncSettings.icloudLeaveHint"), control: .leaveICloud)
            sections.append(Section(id: "leave", rows: [row]))
        } else if snapshot.vault {
            sections.append(
                Section(
                    id: "leave",
                    rows: [Row(key: "syncSettings.leave", text: catalog("syncSettings.leaveHint"), control: .leaveVault)]))
        }
        return sections
    }

    private static func transport(_ snapshot: SyncSnapshot, offer: Bool) -> Row {
        Row(
            key: "syncSettings.transport",
            text: catalog(snapshot.onICloud ? "syncSettings.transportIcloud" : "syncSettings.transportRelay"),
            control: offer ? .useICloudInstead : .none)
    }

    private static func relay(_ hint: String) -> Row {
        Row(key: "syncSettings.relay", text: catalog(hint), control: .relayField)
    }

    private static func stateNotes(_ snapshot: SyncSnapshot) -> [Row] {
        guard snapshot.enabled else { return [] }
        let status = snapshot.status
        var notes: [Row] = []
        if status.relayOutdated { notes.append(note("syncSettings.relayOutdated")) }
        if let files = status.unsyncedFiles, !(status.relayOutdated && files.code == "E_SYNC_RELAY_OUTDATED") {
            let (one, other) =
                files.code == "E_SYNC_RELAY_OUTDATED"
                ? ("syncSettings.filesOutdatedOne", "syncSettings.filesOutdatedOther")
                : ("syncSettings.filesFullOne", "syncSettings.filesFullOther")
            notes.append(note(files.count == 1 ? one : other, SyncText.count(files.count, one, other)))
        }
        for (count, one, other) in [
            (status.tooLarge, "syncSettings.tooLargeOne", "syncSettings.tooLargeOther"),
            (status.skipped, "syncSettings.skippedOne", "syncSettings.skippedOther"),
        ] where count > 0 {
            notes.append(note(count == 1 ? one : other, SyncText.count(count, one, other)))
        }
        return notes
    }

    private static func storedText(_ stored: Stored) -> String {
        switch stored {
        case .reading: catalog("syncSettings.icloudStorageReading")
        case .ready(let bytes): L10n.fill(catalog("syncSettings.icloudStorageValue"), ["size": SyncText.fileSize(bytes)])
        case .failed(let code): SyncText.failure("syncSettings.icloudStorageFailed", code)
        }
    }

    private static let usageNotices = [
        "storageWarn": "sync.notice.usage.storageWarn",
        "storageFull": "sync.notice.usage.storageFull",
        "imagesWarn": "sync.notice.usage.imagesWarn",
        "imagesFull": "sync.notice.usage.imagesFull",
    ]

    private static func usageRows(_ usage: Usage, _ snapshot: SyncSnapshot) -> [Row] {
        let view: StorageView
        switch usage {
        case .reading: return [Row(key: "syncSettings.usage.title", text: catalog("syncSettings.usage.reading"))]
        case .failed(let code):
            let offline = ["E_SYNC_OFFLINE", "E_SYNC_RELAY_FAILED"].contains(code)
            let old = code == "E_SYNC_BAD_MESSAGE"
            let text =
                offline
                ? catalog("syncSettings.usage.offline")
                : old ? catalog("syncSettings.usage.old") : SyncText.failure("syncSettings.usage.failed", code)
            return [Row(key: "syncSettings.usage.title", text: text, control: old ? .none : .retryUsage)]
        case .ready(let ready): view = ready
        }
        let of = { (used: Int, limit: Int?) in
            limit.map {
                L10n.fill(catalog("syncSettings.usage.of"), ["used": SyncText.fileSize(used), "limit": SyncText.fileSize($0)])
            } ?? SyncText.fileSize(used)
        }
        var limit: Int?
        var imageLimit: Int?
        if case .set(let total, let images) = view.cap {
            limit = total
            imageLimit = images
        }
        let room: String
        switch view.cap {
        case .unknown: room = catalog("syncSettings.usage.unknownCap")
        case .none: room = catalog("syncSettings.usage.noCap")
        case .set:
            let left = view.room ?? 0
            if left == 0 {
                room = catalog("syncSettings.usage.roomNone")
            } else if let images = view.imageRoom {
                room =
                    images == 0
                    ? L10n.fill(catalog("syncSettings.usage.roomImagesUsed"), ["room": SyncText.fileSize(left)])
                    : L10n.fill(
                        catalog("syncSettings.usage.roomImages"),
                        ["room": SyncText.fileSize(left), "images": SyncText.fileSize(images)])
            } else {
                room = SyncText.fileSize(left)
            }
        }
        var rows = [
            Row(key: "syncSettings.usage.records", text: SyncText.fileSize(view.recordBytes)),
            Row(key: "syncSettings.usage.images", text: of(view.fileBytes, imageLimit)),
            Row(key: "syncSettings.usage.total", text: of(view.storedBytes, limit)),
            Row(key: "syncSettings.usage.room", text: room),
        ]
        var warned = false
        if let notice = view.notice,
            !(notice == "storageFull" && snapshot.status.code == SyncText.storageFull),
            !(notice == "imagesFull" && snapshot.status.unsyncedFiles?.code == "E_SYNC_ATTACHMENTS_FULL"),
            let key = usageNotices[notice]
        {
            rows.append(note(key))
            warned = true
        }
        if !warned, let limit {
            if let imageLimit {
                rows.append(
                    note(
                        "syncSettings.usage.capNote",
                        L10n.fill(
                            catalog("syncSettings.usage.capNote"),
                            ["limit": SyncText.fileSize(limit), "images": SyncText.fileSize(imageLimit)])))
            } else {
                rows.append(
                    note(
                        "syncSettings.usage.capNoteTotal",
                        L10n.fill(catalog("syncSettings.usage.capNoteTotal"), ["limit": SyncText.fileSize(limit)])))
            }
        }
        return rows
    }

    private static func joinRows(icloud: Bool) -> [Row] {
        [
            Row(
                key: "syncSettings.joinCode",
                text: catalog(icloud ? "syncSettings.joinCodeIcloudHint" : "syncSettings.joinCodeHint"),
                control: .join(recovery: false, icloud: icloud)),
            Row(
                key: "syncSettings.joinRecovery",
                text: catalog(icloud ? "syncSettings.joinRecoveryIcloudHint" : "syncSettings.joinRecoveryHint"),
                control: .join(recovery: true, icloud: icloud)),
        ]
    }

    private static let accountLines = [
        "noAccount": "syncSettings.icloudSignedOut",
        "restricted": "syncSettings.icloudRestricted",
        "temporarilyUnavailable": "syncSettings.icloudTemporarilyUnavailable",
    ]

    private static func setupRows(
        _ input: Input, attention: ICloudAttention?, line: (text: String, actions: [ICloudAttention.Action])?
    ) -> [Row] {
        let snapshot = input.snapshot
        let onRelayPath = input.relayChosen ?? !snapshot.relayUrl.isEmpty
        if input.icloud.available, !snapshot.vault, !onRelayPath {
            if case .ask? = attention, let line {
                return [Row(key: "syncSettings.setup", text: line.text, control: .actions(line.actions))]
            }
            if case .fallback? = attention, let line {
                return [Row(key: "syncSettings.setup", text: line.text, control: .relayAdvanced)] + joinRows(icloud: true)
            }
            let blocked = input.icloud.account == "available" ? nil : input.icloud.account
            let declined = snapshot.icloudJoin?.state == "declined"
            let hint =
                blocked.flatMap { accountLines[$0] }
                ?? (declined ? "syncSettings.icloudDeclined" : "syncSettings.transportQuestionHint")
            return [
                Row(
                    key: "syncSettings.setup", text: catalog(hint),
                    control: .transportQuestion(declined: declined, blocked: blocked != nil))
            ]
        }
        let relayRows = relaySetupRows(input)
        if input.icloud.available, !snapshot.vault { return [transport(snapshot, offer: true)] + relayRows }
        return relayRows
    }

    private static func relaySetupRows(_ input: Input) -> [Row] {
        let snapshot = input.snapshot
        if snapshot.enrolled { return [] }
        let held = snapshot.vault && !snapshot.onICloud
        let asksSecret = !snapshot.relayUrl.isEmpty && (held || input.path == .first)
        let secretHint =
            !snapshot.vault
            ? "syncSettings.secretHint"
            : snapshot.status.code == "E_SYNC_REVOKED" ? "syncSettings.secretRevokedHint" : "syncSettings.secretAgainHint"
        let secret = Row(
            key: "syncSettings.secret", text: catalog(secretHint),
            control: .secret(connect: snapshot.vault, cancellable: !snapshot.vault))
        let change = { (hint: String) in Row(key: "syncSettings.setup", text: catalog(hint), control: .changeSetup) }
        if held { return joinRows(icloud: false) + (asksSecret ? [secret] : []) }
        switch input.path {
        case .first?: return [change("syncSettings.firstHint"), relay("syncSettings.relayHint")] + (asksSecret ? [secret] : [])
        case .another?: return [change("syncSettings.anotherHint")] + joinRows(icloud: false) + [relay("syncSettings.relayJoinHint")]
        case nil: return [Row(key: "syncSettings.setup", text: catalog("syncSettings.setupHint"), control: .setupChoice)]
        }
    }

    private static func devicesRows(_ input: Input) -> [Row] {
        let icloud = input.snapshot.onICloud
        if let problem = input.devicesProblem {
            return [Row(key: "syncSettings.devices", text: problem, control: .retryDevices)]
        }
        let devices = input.devices ?? []
        let hint =
            devices.contains(where: \.unseen)
            ? (icloud ? "syncSettings.icloudDevicesUnseenHint" : "syncSettings.devicesNotJoinedHint")
            : (icloud ? "syncSettings.icloudDevicesHint" : "phone.sync.devicesHint")
        return [
            Row(
                key: "syncSettings.devices", text: catalog(hint),
                control: devices.isEmpty ? .none : .devices(devices, icloud: icloud))
        ]
    }

    /// How a device's date reads: added or seen, or not joined yet.
    static func dated(_ device: SyncDevice, icloud: Bool) -> String {
        let key =
            device.unseen
            ? (icloud ? "syncSettings.deviceUnseen" : "syncSettings.deviceNotJoined")
            : (icloud ? "syncSettings.deviceSeen" : "syncSettings.deviceAdded")
        return L10n.fill(catalog(key), ["date": SyncText.day(device.created)])
    }
}
