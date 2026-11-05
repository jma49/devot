#[path = "build_commands.rs"]
mod build_commands;
#[path = "build_env.rs"]
mod build_env;

const ENV_FILE: &str = "../.env.local";

/// Crash reporting: a `DEVOT_SENTRY_DSN` in the environment wins (set it empty
/// to turn reporting off); otherwise the one in `.env.local` is compiled in.
fn sentry_dsn() {
    let text = std::fs::read_to_string(ENV_FILE).ok();
    for line in build_env::watch_lines(ENV_FILE, text.is_some()) {
        println!("{line}");
    }
    if let Some(text) = text
        && std::env::var_os("DEVOT_SENTRY_DSN").is_none()
        && let Some(dsn) = build_env::sentry_dsn(&text)
    {
        println!("cargo:rustc-env=DEVOT_SENTRY_DSN={dsn}");
    }
}

/// Read by `data_folder::Build::this`; a tag's release build without it stops here.
fn release_marker() {
    // xcodebuild gives an iPhone build no GITHUB_REF_TYPE; app-store.ts marker-check covers it.
    for key in ["DEVOT_RELEASE_BUILD", "GITHUB_REF_TYPE"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let ref_type = std::env::var("GITHUB_REF_TYPE").ok();
    let marker = std::env::var("DEVOT_RELEASE_BUILD").ok();
    if build_env::missing_release_marker(&profile, ref_type.as_deref(), marker.as_deref()) {
        panic!("E_RELEASE_BUILD_MARKER: a tag's release build needs DEVOT_RELEASE_BUILD=1");
    }
}

/// The StoreKit bridge's C functions (`native/ios.rs`), defined by the package in `apple/` that only
/// the iPhone app links.
const STORE_BRIDGE: &[&str] = &[
    "devot_store_products",
    "devot_store_purchase",
    "devot_store_restore",
    "devot_store_entitlements",
    "devot_store_finish",
    "devot_store_listen",
];

/// Xcode links the static library with that package. Cargo also links an iOS cdylib, which
/// nothing ships and which has no Swift, so there the bridge is left to be found at load.
fn store_bridge() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        for symbol in STORE_BRIDGE {
            println!("cargo:rustc-cdylib-link-arg=-Wl,-U,_{symbol}");
        }
    }
}

/// Read by `distribution::Distribution::this`; a value it would not read stops the build here.
fn distribution_marker() {
    println!("cargo:rerun-if-env-changed=DEVOT_DISTRIBUTION");
    let marker = std::env::var("DEVOT_DISTRIBUTION").ok();
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if let Some(code) = build_env::distribution_marker_error(marker.as_deref(), &target_os) {
        panic!("{code}: DEVOT_DISTRIBUTION is unset, or app-store for an iPhone build");
    }
}

fn main() {
    sentry_dsn();
    release_marker();
    distribution_marker();
    store_bridge();
    // Declaring the app's commands makes each one need an explicit
    // permission in a capability file, so no window gets a command by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(build_commands::AREAS.concat().leak()),
    ))
    .expect("E_TAURI_BUILD");
}
