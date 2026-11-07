import SwiftUI

/// Sync (`SyncSection.tsx`, phone layout): sync on or off, the relay, the status and what to do
/// about it, storage, setup or the devices, pairing, and leaving the vault. `SyncLayout` decides
/// the rows; this draws them. Opened for Pair a Device, it lands on the pairing without a scroll.
struct SyncPane: View {
    let store: SettingsStore
    @State var model: SyncPaneModel
    let anchor: PaneAnchor?
    let buy: () -> Void
    @State private var landed = false
    @FocusState private var focused: SyncLayout.Row.ID?

    private static let quietModules = 4
    private static let qrSide = Tokens.Space.space10 * 4

    var body: some View {
        let sections = model.layout
        ScrollViewReader { proxy in
            Form {
                if let problem = model.problem { ProblemRow(text: problem) }
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in self.row(row) }
                    } footer: {
                        if let footer = section.footer { Footer(footer) }
                    }
                    .id(section.id)
                }
            }
            .onAppear { land(sections, proxy) }
            .onChange(of: sections.map(\.id)) { land(sections, proxy) }
        }
        .settingsPage(store)
        .onAppear { model.appeared() }
        .onChange(of: store.sync) { old, _ in model.changed(from: old) }
        .onChange(of: store.pairingNudges) { model.checkPairing() }
        .onChange(of: model.announcement) { _, said in
            if let said { AccessibilityNotification.Announcement(said).post() }
        }
        .alert(confirmTitle, isPresented: confirming) {
            confirmButtons
        } message: {
            Text(confirmDetail)
        }
    }

    /// Lands once on the first section that pairs, as soon as it is drawn.
    private func land(_ sections: [SyncLayout.Section], _ proxy: ScrollViewProxy) {
        guard anchor == .pairing, !landed, store.sync != nil, let target = sections.first(where: \.pairing) else {
            return
        }
        landed = true
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) { proxy.scrollTo(target.id, anchor: .top) }
    }

    @ViewBuilder
    private func row(_ row: SyncLayout.Row) -> some View {
        if row.note {
            Text(row.text).settingsDetail().listRowBackground(Color(Tokens.Color.phoneCard))
        } else {
            switch row.control {
            case .toggle(let on, let disabled):
                ToggleRow(title: catalog(row.key), detail: row.text, isOn: on) { model.setEnabled($0) }
                    .disabled(disabled || model.busy)
            case .relayField:
                field(row, text: Binding(get: { model.url ?? model.snapshot.relayUrl }, set: { model.url = $0 }),
                    prompt: catalog("syncSettings.relayPlaceholder"), keyboard: .URL, submit: model.saveUrl)
                    .onChange(of: focused) { was, _ in if was == row.id { model.saveUrl() } }
            case .secret(let connect, let cancellable):
                field(row, text: $model.secret, secure: true, submit: model.create)
                if cancellable { ActionRow(title: L10n.dialogCancel(), action: model.backOut) }
                ActionRow(
                    title: catalog(connect ? "syncSettings.connect" : "syncSettings.createVault"), busy: model.busy,
                    action: model.create
                )
                .disabled(model.secret.trimmingCharacters(in: .whitespaces).isEmpty || model.locked)
            case .join(let recovery, let icloud):
                field(row, text: recovery ? $model.recovery : $model.code, characters: true) {
                    model.join(recovery: recovery, icloud: icloud)
                }
                ActionRow(title: catalog("syncSettings.join"), busy: model.busy) {
                    model.join(recovery: recovery, icloud: icloud)
                }
                .disabled((recovery ? model.recovery : model.code).trimmingCharacters(in: .whitespaces).isEmpty || model.locked)
                .accessibilityLabel(catalog(row.key))
            case .leaveICloudKey:
                field(row, text: $model.leaveKey, characters: true, submit: model.leaveICloud)
                ActionRow(title: L10n.dialogCancel(), action: model.cancelLeaveICloud)
                ActionRow(title: catalog("syncSettings.icloudLeaveButton"), destructive: true, busy: model.busy,
                    action: model.leaveICloud
                )
                .disabled(model.leaveKey.trimmingCharacters(in: .whitespaces).isEmpty)
            case .recoveryKey(let key):
                VStack(alignment: .leading, spacing: Tokens.Space.space4) {
                    RowText(title: catalog(row.key), detail: row.text)
                    Text(key).font(.body.monospaced()).textSelection(.enabled).accessibilityIdentifier("recovery-key")
                }
                .settingsRow(described: true)
                ActionRow(title: catalog("syncSettings.recoveryCopy"), action: model.copyRecoveryKey)
                ActionRow(title: catalog("syncSettings.recoverySaved"), busy: model.busy, action: model.recoverySaved)
            case .pairing:
                pairingRows(row)
            case .devices(let devices, let icloud):
                RowText(title: catalog(row.key), detail: row.text).settingsRow(described: true)
                ForEach(devices) { device in deviceRow(device, icloud: icloud) }
            default:
                RowText(title: catalog(row.key), detail: row.text).settingsRow(described: true)
                actions(row.control)
            }
        }
    }

    @ViewBuilder
    private func actions(_ control: SyncLayout.Row.Control) -> some View {
        switch control {
        case .buy:
            ActionRow(title: store.licence?.soldOnAppStore == true ? L10n.licenceSettingsBuyPro() : L10n.licenceSettingsBuy(),
                action: buy)
        case .useICloudInstead:
            ActionRow(title: catalog("syncSettings.useIcloudInstead")) { model.relayChosen = false }
        case .actions(let actions):
            ForEach(actions, id: \.self) { action in
                let confirmed = SyncPaneModel.confirmed.contains(action)
                ActionRow(title: catalog(Self.actionLabels[action]!) + (confirmed ? "\u{2026}" : ""), busy: model.busy) {
                    model.act(action)
                }
                .disabled(model.locked && action != .turnOff && action != .decline)
            }
        case .retryUsage:
            ActionRow(title: catalog("syncSettings.usage.retry"), action: model.readUsage)
        case .moveToICloud:
            ActionRow(title: catalog("syncSettings.switchTransport") + "\u{2026}", busy: model.busy) {
                model.confirm = .moveToICloud
            }
            .disabled(model.locked)
        case .setupChoice:
            ActionRow(title: catalog("syncSettings.setupFirst")) { model.choose(.first) }.disabled(model.locked)
            ActionRow(title: catalog("syncSettings.setupAnother")) { model.choose(.another) }.disabled(model.locked)
        case .changeSetup:
            ActionRow(title: catalog("syncSettings.setupChange"), action: model.backOut)
        case .relayAdvanced:
            ActionRow(title: catalog("syncSettings.transportRelayAdvanced")) { model.relayChosen = true }
                .disabled(model.locked)
        case .transportQuestion(let declined, let blocked):
            ActionRow(title: catalog(declined ? "syncSettings.icloudJoin" : "syncSettings.useIcloud"), busy: model.busy) {
                model.startICloud(declined: declined)
            }
            .disabled(model.locked || blocked)
            ActionRow(title: catalog("syncSettings.transportRelayAdvanced")) { model.relayChosen = true }
                .disabled(model.locked)
        case .retryDevices:
            ActionRow(title: catalog("syncSettings.devicesRetry"), action: model.readDevices)
        case .leaveVault:
            ActionRow(title: catalog("syncSettings.leave") + "\u{2026}", destructive: true, busy: model.busy) {
                model.confirm = .leaveVault
            }
        case .leaveICloud:
            ActionRow(title: catalog("syncSettings.icloudLeave") + "\u{2026}", destructive: true) {
                model.askingLeaveKey = true
            }
        default:
            EmptyView()
        }
    }

    private func field(
        _ row: SyncLayout.Row, text: Binding<String>, prompt: String? = nil, keyboard: UIKeyboardType = .default,
        secure: Bool = false, characters: Bool = false, submit: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Space.space4) {
            RowText(title: catalog(row.key), detail: row.text)
            Group {
                if secure {
                    SecureField(catalog(row.key), text: text)
                } else {
                    TextField(catalog(row.key), text: text, prompt: prompt.map { Text($0) })
                }
            }
            .keyboardType(keyboard)
            .autocorrectionDisabled()
            .textInputAutocapitalization(characters ? .characters : .never)
            .submitLabel(.done)
            .onSubmit(submit)
            .focused($focused, equals: row.id)
            .accessibilityIdentifier(row.id)
        }
        .settingsRow(described: true)
    }

    @ViewBuilder
    private func pairingRows(_ row: SyncLayout.Row) -> some View {
        if let shown = model.pairing {
            VStack(alignment: .center, spacing: Tokens.Space.space4) {
                RowText(title: catalog(row.key), detail: row.text).frame(maxWidth: .infinity, alignment: .leading)
                QrCode(pairing: shown, quiet: Self.quietModules)
                    .frame(width: Self.qrSide, height: Self.qrSide)
                    .accessibilityLabel(catalog("syncSettings.pairQr"))
                Text(shown.code).font(.callout.monospaced()).multilineTextAlignment(.center).textSelection(.enabled)
                Text(model.progressText).settingsDetail()
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let left = shown.expires - context.date.timeIntervalSince1970 * 1000
                    if left > 0 {
                        Text(L10n.fill(catalog("syncSettings.pairExpiresIn"), ["time": SyncText.countdown(left)]))
                            .settingsDetail().monospacedDigit()
                    }
                }
            }
            .settingsRow(described: true)
            ActionRow(title: L10n.dialogCancel(), action: model.cancelPairing)
        } else {
            RowText(title: catalog(row.key), detail: row.text).settingsRow(described: true)
            ActionRow(title: catalog("syncSettings.pairShow"), busy: model.busy, action: model.showPairing)
                .disabled(model.locked)
        }
    }

    private func deviceRow(_ device: SyncDevice, icloud: Bool) -> some View {
        HStack(spacing: Tokens.Size.phoneGroupedGap) {
            RowText(title: device.label, detail: SyncLayout.dated(device, icloud: icloud))
            Spacer(minLength: 0)
            if device.current {
                Text(catalog("phone.sync.you")).settingsDetail()
                    .padding(.horizontal, Tokens.Space.space4)
                    .padding(.vertical, Tokens.Space.space1)
                    .background(Capsule().fill(Color(Tokens.Color.phoneLens)))
            } else if !icloud {
                Button(catalog("syncSettings.deviceRemove"), role: .destructive) {
                    model.confirm = .removeDevice(device)
                }
                .buttonStyle(.borderless)
                .frame(minHeight: Tokens.Size.phoneTarget)
                .disabled(model.removing.contains(device.id))
                .accessibilityLabel(
                    L10n.fill(
                        catalog("syncSettings.deviceRemoveLabel"),
                        ["name": device.label, "date": SyncText.day(device.created)]))
            }
        }
        .settingsRow(described: true)
    }

    // MARK: confirmations

    private static let actionLabels: [ICloudAttention.Action: String] = [
        .moveHere: "syncSettings.icloudMoveToThisAccount",
        .uploadAgain: "syncSettings.icloudUploadAgain",
        .turnOff: "syncSettings.turnOff",
        .follow: "syncSettings.vaultMovedFollow",
        .finish: "syncSettings.vaultMovedFinish",
        .join: "syncSettings.icloudJoin",
        .decline: "syncSettings.icloudDecline",
    ]

    private var confirming: Binding<Bool> {
        Binding(get: { model.confirm != nil }, set: { if !$0 { model.confirm = nil } })
    }

    /// The title, detail and confirming button's keys of what is being confirmed.
    private var asked: (title: String, detail: String, button: String)? {
        switch model.confirm {
        case .icloud(.moveHere)?:
            (catalog("syncSettings.icloudMoveConfirm"), catalog("syncSettings.icloudMoveDetail"), catalog("syncSettings.icloudMoveButton"))
        case .icloud?:
            (catalog("syncSettings.icloudUploadConfirm"), catalog("syncSettings.icloudUploadDetail"), catalog("syncSettings.icloudUploadButton"))
        case .moveToICloud?:
            (catalog("syncSettings.switchTransportConfirm"), catalog("syncSettings.switchTransportDetail"), catalog("syncSettings.switchTransportButton"))
        case .leaveVault?:
            (catalog("syncSettings.leaveConfirm"), catalog("syncSettings.leaveDetail"), catalog("syncSettings.leaveButton"))
        case .removeDevice(let device)?:
            (
                L10n.fill(catalog("syncSettings.deviceRemoveConfirm"), ["name": device.label, "date": SyncText.day(device.created)]),
                catalog(device.unseen ? "syncSettings.deviceNotJoinedRemoveDetail" : "syncSettings.deviceRemoveDetail"),
                catalog("syncSettings.deviceRemoveButton")
            )
        case .linkRelay(let relay)?:
            (
                L10n.fill(catalog("syncSettings.linkRelayConfirm"), ["host": SyncLinks.host(relay)]),
                catalog("syncSettings.linkRelayDetail"), catalog("syncSettings.linkRelayButton")
            )
        case nil: nil
        }
    }

    private var confirmTitle: String { asked?.title ?? "" }
    private var confirmDetail: String { asked?.detail ?? "" }

    @ViewBuilder
    private var confirmButtons: some View {
        if let confirm = model.confirm, let asked {
            let destructive: Bool = {
                switch confirm {
                case .leaveVault, .removeDevice: true
                default: false
                }
            }()
            Button(asked.button, role: destructive ? .destructive : nil) { run(confirm) }
        }
        Button(L10n.dialogCancel(), role: .cancel) { model.confirm = nil }
    }

    private func run(_ confirm: SyncPaneModel.Confirm) {
        switch confirm {
        case .icloud(let action): model.perform(action)
        case .moveToICloud: model.moveToICloud()
        case .leaveVault: model.leaveVault()
        case .removeDevice(let device): model.remove(device)
        case .linkRelay(let relay):
            model.confirm = nil
            model.joinOnRelay(relay)
        }
    }
}

/// The pairing's QR code, drawn from its modules with a quiet margin round it.
struct QrCode: View {
    let pairing: ShownPairing
    let quiet: Int

    var body: some View {
        Canvas { context, size in
            let total = CGFloat(pairing.size + quiet * 2)
            let module = min(size.width, size.height) / total
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(Tokens.Color.qrGround)))
            var dark = Path()
            for y in 0..<pairing.size {
                for x in 0..<pairing.size where pairing.modules[y * pairing.size + x] {
                    dark.addRect(
                        CGRect(x: CGFloat(x + quiet) * module, y: CGFloat(y + quiet) * module, width: module, height: module))
                }
            }
            context.fill(dark, with: .color(Color(Tokens.Color.qrModule)))
        }
        .accessibilityElement()
        .accessibilityAddTraits(.isImage)
    }
}
