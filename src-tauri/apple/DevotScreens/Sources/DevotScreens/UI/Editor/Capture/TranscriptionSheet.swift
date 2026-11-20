import SwiftUI
import UIKit

/// The transcription sheet: what is being said appears as it is heard, in the language picked
/// above it; Insert puts all of it in the note at the caret, Cancel drops it. A drag down does
/// not close it, so words are never lost to a stray swipe.
struct TranscriptionSheet: View {
    let model: TranscriptionModel
    let insert: (String) -> Void
    let close: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Tokens.Space.space6) {
                status
                ScrollViewReader { reader in
                    ScrollView {
                        Text(model.text.isEmpty ? L10n.phoneTranscribeHint() : model.text)
                            .font(.body)
                            .foregroundStyle(Color(model.text.isEmpty ? Tokens.Color.phoneTextSecondary : Tokens.Color.phoneText))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .id(Self.end)
                    }
                    .onChange(of: model.text) { reader.scrollTo(Self.end, anchor: .bottom) }
                }
            }
            .padding(.horizontal, Tokens.Size.phoneScreenEdge)
            .padding(.top, Tokens.Space.space4)
            .navigationTitle(L10n.phoneTranscribeTitle())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.phoneTranscribeCancel()) {
                        model.cancel()
                        close()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.phoneTranscribeInsert()) {
                        model.finish { text in insert(text) }
                    }
                    .disabled(!model.canInsert)
                }
            }
        }
        .onAppear { model.start() }
    }

    private static let end = "transcript.end"

    private var status: some View {
        HStack(spacing: Tokens.Space.space4) {
            Image(systemName: symbol)
                .foregroundStyle(Color(symbolColor))
                .accessibilityHidden(true)
            Text(statusText)
                .font(.subheadline)
                .foregroundStyle(Color(Tokens.Color.phoneTextSecondary))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Tokens.Space.space4)
            Menu {
                Picker(
                    L10n.phoneTranscribeLanguage(),
                    selection: Binding(get: { model.language }, set: { model.choose($0) })
                ) {
                    ForEach(TranscriptionLanguage.allCases, id: \.self) { language in
                        Text(language.name).tag(language)
                    }
                }
            } label: {
                Label(model.language.name, systemImage: "globe")
                    .font(.subheadline)
                    .lineLimit(1)
            }
            .accessibilityLabel(L10n.phoneTranscribeLanguage())
            .accessibilityValue(model.language.name)
            .disabled(model.phase == .finishing || model.phase == .ended)
        }
        .accessibilityElement(children: .contain)
    }

    private var statusText: String {
        switch model.phase {
        case .preparing: L10n.phoneTranscribePreparing()
        case .downloading: L10n.phoneTranscribeDownloading()
        case .listening: L10n.phoneTranscribeListening()
        case .finishing, .ended: L10n.phoneTranscribeFinishing()
        case .stopped(let failure): failure.message
        }
    }

    private var symbol: String {
        switch model.phase {
        case .listening: "mic.fill"
        case .stopped: "exclamationmark.circle"
        case .downloading: "arrow.down.circle"
        case .preparing, .finishing, .ended: "mic"
        }
    }

    private var symbolColor: UIColor {
        switch model.phase {
        case .listening: Tokens.Color.phoneDestructive
        default: Tokens.Color.phoneTextSecondary
        }
    }

    /// The sheet at medium height, growing to large, that only its buttons close.
    static func controller(model: TranscriptionModel, insert: @escaping (String) -> Void) -> UIViewController {
        weak var shown: UIViewController?
        let close = { shown?.dismiss(animated: true) }
        let hosting = UIHostingController(
            rootView: TranscriptionSheet(
                model: model,
                insert: { text in
                    close()
                    insert(text)
                }, close: close))
        hosting.view.backgroundColor = Tokens.Color.phoneSheet
        hosting.isModalInPresentation = true
        hosting.modalPresentationStyle = .pageSheet
        if let sheet = hosting.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        shown = hosting
        return hosting
    }
}
