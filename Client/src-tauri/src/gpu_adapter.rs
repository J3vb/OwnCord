//! Graphics card for video (Windows).
//!
//! WebView2 picks its graphics card when it starts, so the choice is applied
//! at launch: before the main window is built, `--use-adapter-luid=<card>` is
//! added to the webview's start flags and the whole app (drawing, decode,
//! encode) follows that card. A card's LUID changes on every reboot, so the
//! saved choice is the card's identity (vendor id, device id, name) and the
//! LUID is looked up at each start.
//!
//! The decisions ([`resolve`], [`plan_startup`], [`luid_flag`]) are plain
//! functions over a card list, so they run and are tested on every platform.
//! Only [`enumerate`] talks to DXGI, and off Windows it finds no cards.
//!
//! Crash guard: a pending marker is set whenever a flag is applied and cleared
//! once the page has loaded (`diagnostics::frontend_ready`). A start that
//! finds the marker still set skips the flag and resets the choice to Auto.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::constants::SETTINGS_STORE;
use crate::json_store;

const CHOICE_KEY: &str = "owncord:video:gpuAdapter";
const PENDING_KEY: &str = "owncord:video:gpuAdapterPending";
/// Set when a start on the Auto pick never finished.
const AUTO_OFF_KEY: &str = "owncord:video:gpuAdapterAutoOff";
const AUTO: &str = "auto";
/// The longest choice string the command accepts.
const MAX_CHOICE_LEN: usize = 256;
/// Microsoft Basic Render Driver and other software adapters.
#[cfg_attr(not(windows), allow(dead_code))]
const SOFTWARE_VENDOR_ID: u32 = 0x1414;

/// One hardware graphics card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuCard {
    pub vendor_id: u32,
    pub device_id: u32,
    pub name: String,
    pub luid_high: i32,
    pub luid_low: u32,
    pub dedicated_mem: u64,
    /// Position in Windows' high-performance order; 0 is first.
    pub high_performance_rank: u32,
}

impl GpuCard {
    /// Stable across reboots: the LUID is left out on purpose.
    pub fn id(&self) -> String {
        format!(
            "{:04x}:{:04x}:{}",
            self.vendor_id, self.device_id, self.name
        )
    }

    fn luid(&self) -> Luid {
        Luid {
            high: self.luid_high,
            low: self.luid_low,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Luid {
    pub high: i32,
    pub low: u32,
}

/// What the user chose, as saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SavedChoice {
    Auto,
    #[serde(rename_all = "camelCase")]
    Card {
        vendor_id: u32,
        device_id: u32,
        name: String,
    },
}

impl SavedChoice {
    fn matches(&self, card: &GpuCard) -> bool {
        match self {
            Self::Auto => false,
            Self::Card {
                vendor_id,
                device_id,
                name,
            } => *vendor_id == card.vendor_id && *device_id == card.device_id && *name == card.name,
        }
    }

    fn of(card: &GpuCard) -> Self {
        Self::Card {
            vendor_id: card.vendor_id,
            device_id: card.device_id,
            name: card.name.clone(),
        }
    }
}

/// The card to start on, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    pub luid: Option<Luid>,
    /// Id of the card the flag points at.
    pub active: Option<String>,
    /// A saved card was not found, so Auto was used.
    pub fell_back: bool,
}

/// Auto picks only when there is a real choice: with fewer than two hardware
/// cards nothing is added and the webview behaves as before.
#[cfg(test)]
pub fn resolve(saved: &SavedChoice, cards: &[GpuCard]) -> Resolution {
    resolve_with(saved, cards, false)
}

/// `auto_off`: an earlier start on the Auto pick never finished, so Auto
/// leaves the card to Windows until the user picks again.
pub fn resolve_with(saved: &SavedChoice, cards: &[GpuCard], auto_off: bool) -> Resolution {
    let by_card = |card: &GpuCard, fell_back: bool| Resolution {
        luid: Some(card.luid()),
        active: Some(card.id()),
        fell_back,
    };
    let mut fell_back = false;
    if *saved != SavedChoice::Auto {
        if let Some(card) = cards.iter().find(|c| saved.matches(c)) {
            return by_card(card, false);
        }
        fell_back = true;
    }
    if !auto_off && cards.len() >= 2 {
        if let Some(card) = cards.iter().min_by_key(|c| c.high_performance_rank) {
            return by_card(card, fell_back);
        }
    }
    Resolution {
        luid: None,
        active: None,
        fell_back,
    }
}

/// The only place the flag text is built. Chromium reads the two LUID halves
/// as decimal numbers, `<high>,<low>`.
pub fn luid_flag(luid: Luid) -> String {
    format!("--use-adapter-luid={},{}", luid.high, luid.low)
}

/// Rank by dedicated memory, largest first. Used when Windows cannot say
/// which card it prefers.
#[cfg_attr(not(windows), allow(dead_code))]
fn rank_by_memory(cards: &mut [GpuCard]) {
    let mut order: Vec<usize> = (0..cards.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(cards[i].dedicated_mem));
    for (rank, i) in order.into_iter().enumerate() {
        cards[i].high_performance_rank = rank as u32;
    }
}

/// What `setup` does with the saved state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupPlan {
    pub resolution: Resolution,
    /// The previous start never finished loading with a flag applied.
    pub reset_after_crash: bool,
    /// Write the pending marker (a flag is being applied).
    pub set_pending: bool,
}

pub fn plan_startup(
    saved: &SavedChoice,
    cards: &[GpuCard],
    pending: bool,
    auto_off: bool,
) -> StartupPlan {
    let resolution = resolve_with(saved, cards, auto_off);
    if resolution.luid.is_some() && pending {
        return StartupPlan {
            resolution: Resolution {
                luid: None,
                active: None,
                fell_back: false,
            },
            reset_after_crash: true,
            set_pending: false,
        };
    }
    StartupPlan {
        set_pending: resolution.luid.is_some(),
        resolution,
        reset_after_crash: false,
    }
}

/// What this launch did, kept for the Settings row.
pub struct GpuAdapterState {
    active: Option<String>,
    not_found: bool,
    reset_after_crash: bool,
    auto_off: bool,
    cards: Mutex<Vec<GpuCard>>,
}

fn read_choice<R: Runtime>(app: &AppHandle<R>) -> SavedChoice {
    let Ok(store) = json_store::open(app, SETTINGS_STORE) else {
        return SavedChoice::Auto;
    };
    store
        .get(CHOICE_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or(SavedChoice::Auto)
}

fn write_choice<R: Runtime>(app: &AppHandle<R>, choice: &SavedChoice) -> Result<(), String> {
    let store = json_store::open(app, SETTINGS_STORE)?;
    let value = serde_json::to_value(choice).map_err(|e| e.to_string())?;
    store.set(CHOICE_KEY, value);
    store.save()
}

fn read_flag<R: Runtime>(app: &AppHandle<R>, key: &str) -> bool {
    json_store::open(app, SETTINGS_STORE)
        .ok()
        .and_then(|s| s.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn write_flag<R: Runtime>(app: &AppHandle<R>, key: &str, on: bool) {
    let Ok(store) = json_store::open(app, SETTINGS_STORE) else {
        return;
    };
    if on {
        store.set(key, serde_json::Value::Bool(true));
    } else if !store.delete(key) {
        return;
    }
    if let Err(e) = store.save() {
        log::warn!("[gpu] cannot save {key}: {e}");
    }
}

fn write_pending<R: Runtime>(app: &AppHandle<R>, on: bool) {
    write_flag(app, PENDING_KEY, on);
}

/// Run once in `setup`, before the main window exists. Manages the state and
/// returns the start flag to add, if any. Never fails: the app starts either
/// way.
pub fn prepare<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let cards = enumerate();
    let saved = read_choice(app);
    let pending = read_flag(app, PENDING_KEY);
    let mut auto_off = read_flag(app, AUTO_OFF_KEY);
    let plan = plan_startup(&saved, &cards, pending, auto_off);
    if plan.reset_after_crash {
        log::warn!("[gpu] the last start on a chosen card did not finish; back to Auto");
        if let Err(e) = write_choice(app, &SavedChoice::Auto) {
            log::warn!("[gpu] cannot reset the choice: {e}");
        }
        write_pending(app, false);
        // Auto would pick the same card again, so it stands down too.
        write_flag(app, AUTO_OFF_KEY, true);
        auto_off = true;
    } else if plan.set_pending {
        write_pending(app, true);
    } else if pending {
        write_pending(app, false);
    }
    let flag = plan.resolution.luid.map(luid_flag);
    if let Some(flag) = &flag {
        log::info!("[gpu] starting with {flag}");
    }
    app.manage(GpuAdapterState {
        active: plan.resolution.active,
        not_found: plan.resolution.fell_back,
        reset_after_crash: plan.reset_after_crash,
        auto_off,
        cards: Mutex::new(cards),
    });
    flag
}

/// The page loaded: the card works, so the marker goes.
pub fn clear_pending<R: Runtime>(app: &AppHandle<R>) {
    write_pending(app, false);
}

/// Append `flag` to the window's existing WebView2 start arguments.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn append_browser_arg(existing: Option<&str>, flag: &str) -> String {
    match existing {
        Some(args) if !args.trim().is_empty() => format!("{} {flag}", args.trim_end()),
        _ => flag.to_string(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuCardInfo {
    id: String,
    name: String,
    vendor_id: u32,
    device_id: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapters {
    cards: Vec<GpuCardInfo>,
    /// "auto" or a card id.
    saved: String,
    /// The card applied this launch.
    active: Option<String>,
    not_found: bool,
    reset_after_crash: bool,
    /// Auto leaves the card to Windows after a start that did not finish.
    auto_off: bool,
}

/// The cards, deduplicated by id (two identical cards cannot be told apart).
fn listed(cards: &[GpuCard]) -> Vec<GpuCardInfo> {
    let mut out: Vec<GpuCardInfo> = Vec::new();
    for card in cards {
        let id = card.id();
        if out.iter().all(|c| c.id != id) {
            out.push(GpuCardInfo {
                id,
                name: card.name.clone(),
                vendor_id: card.vendor_id,
                device_id: card.device_id,
            });
        }
    }
    out
}

fn saved_id(saved: &SavedChoice) -> String {
    match saved {
        SavedChoice::Auto => AUTO.to_string(),
        SavedChoice::Card {
            vendor_id,
            device_id,
            name,
        } => format!("{vendor_id:04x}:{device_id:04x}:{name}"),
    }
}

/// Turn a command argument into a choice: "auto" or the id of a listed card.
fn parse_choice(choice: &str, cards: &[GpuCard]) -> Result<SavedChoice, String> {
    if choice.len() > MAX_CHOICE_LEN {
        return Err("choice too long".to_string());
    }
    if choice == AUTO {
        return Ok(SavedChoice::Auto);
    }
    cards
        .iter()
        .find(|c| c.id() == choice)
        .map(SavedChoice::of)
        .ok_or_else(|| "unknown graphics card".to_string())
}

#[tauri::command]
pub fn get_gpu_adapters(app: AppHandle, state: State<'_, GpuAdapterState>) -> GpuAdapters {
    let cards = crate::sync::lock(&state.cards);
    GpuAdapters {
        cards: listed(&cards),
        saved: saved_id(&read_choice(&app)),
        active: state.active.clone(),
        not_found: state.not_found,
        reset_after_crash: state.reset_after_crash,
        auto_off: state.auto_off,
    }
}

#[tauri::command]
pub fn set_gpu_adapter(
    app: AppHandle,
    state: State<'_, GpuAdapterState>,
    choice: String,
) -> Result<(), String> {
    let choice = {
        let cards = crate::sync::lock(&state.cards);
        parse_choice(&choice, &cards)?
    };
    write_choice(&app, &choice)?;
    // A fresh pick, Auto included, gets a fresh try.
    write_flag(&app, AUTO_OFF_KEY, false);
    Ok(())
}

/// Hardware graphics cards, with Windows' high-performance order in
/// `high_performance_rank`. Empty off Windows or when DXGI fails.
pub fn enumerate() -> Vec<GpuCard> {
    #[cfg(windows)]
    {
        dxgi::enumerate()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
mod dxgi {
    use windows::core::Interface;
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIFactory6,
        DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
    };

    use super::{rank_by_memory, GpuCard, SOFTWARE_VENDOR_ID};

    fn card_of(adapter: &IDXGIAdapter1) -> Option<GpuCard> {
        // SAFETY: GetDesc1 only writes the returned description.
        let desc = unsafe { adapter.GetDesc1() }.ok()?;
        if desc.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0
            || desc.VendorId == SOFTWARE_VENDOR_ID
        {
            return None;
        }
        let len = desc
            .Description
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(desc.Description.len());
        Some(GpuCard {
            vendor_id: desc.VendorId,
            device_id: desc.DeviceId,
            name: String::from_utf16_lossy(&desc.Description[..len]),
            luid_high: desc.AdapterLuid.HighPart,
            luid_low: desc.AdapterLuid.LowPart,
            dedicated_mem: desc.DedicatedVideoMemory as u64,
            high_performance_rank: u32::MAX,
        })
    }

    /// The (high, low) LUIDs in Windows' high-performance order, or None when
    /// IDXGIFactory6 is not there (before Windows 10 1803).
    fn preference_order(factory: &IDXGIFactory1) -> Option<Vec<(i32, u32)>> {
        let factory6: IDXGIFactory6 = factory.cast().ok()?;
        let mut order = Vec::new();
        for index in 0.. {
            // SAFETY: plain COM call on a live factory; the index runs until
            // DXGI reports there are no more adapters.
            let adapter: IDXGIAdapter1 = match unsafe {
                factory6.EnumAdapterByGpuPreference(index, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
            } {
                Ok(a) => a,
                Err(_) => break,
            };
            // SAFETY: GetDesc1 only writes the returned description.
            if let Ok(desc) = unsafe { adapter.GetDesc1() } {
                order.push((desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart));
            }
        }
        Some(order)
    }

    pub fn enumerate() -> Vec<GpuCard> {
        // SAFETY: creating a factory has no preconditions.
        let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
            Ok(f) => f,
            Err(e) => {
                log::warn!("[gpu] cannot create the DXGI factory: {e}");
                return Vec::new();
            }
        };
        let mut cards = Vec::new();
        for index in 0.. {
            // SAFETY: plain COM call on a live factory; ends on the first error
            // (DXGI_ERROR_NOT_FOUND after the last adapter).
            match unsafe { factory.EnumAdapters1(index) } {
                Ok(adapter) => cards.extend(card_of(&adapter)),
                Err(_) => break,
            }
        }
        match preference_order(&factory) {
            Some(order) => {
                for card in &mut cards {
                    card.high_performance_rank = order
                        .iter()
                        .position(|&l| l == (card.luid_high, card.luid_low))
                        .map_or(u32::MAX, |p| p as u32);
                }
            }
            None => rank_by_memory(&mut cards),
        }
        cards
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(vendor: u32, name: &str, rank: u32, low: u32) -> GpuCard {
        GpuCard {
            vendor_id: vendor,
            device_id: 0x1234,
            name: name.to_string(),
            luid_high: 0,
            luid_low: low,
            dedicated_mem: 1 << 30,
            high_performance_rank: rank,
        }
    }

    fn two_cards() -> Vec<GpuCard> {
        vec![
            card(0x8086, "Intel(R) UHD Graphics", 1, 100),
            card(0x10de, "NVIDIA GeForce RTX", 0, 200),
        ]
    }

    #[test]
    fn auto_with_one_card_adds_no_flag() {
        let r = resolve(&SavedChoice::Auto, &[card(0x10de, "Only", 0, 1)]);
        assert_eq!(r.luid, None);
        assert!(!r.fell_back);
    }

    #[test]
    fn auto_with_two_cards_picks_high_performance() {
        let r = resolve(&SavedChoice::Auto, &two_cards());
        assert_eq!(r.luid, Some(Luid { high: 0, low: 200 }));
        assert_eq!(r.active.as_deref(), Some("10de:1234:NVIDIA GeForce RTX"));
    }

    #[test]
    fn saved_card_present_uses_its_luid() {
        let saved = SavedChoice::of(&two_cards()[0]);
        let r = resolve(&saved, &two_cards());
        assert_eq!(r.luid, Some(Luid { high: 0, low: 100 }));
        assert!(!r.fell_back);
    }

    #[test]
    fn saved_card_missing_falls_back_to_auto() {
        let saved = SavedChoice::Card {
            vendor_id: 0x1002,
            device_id: 1,
            name: "Gone".to_string(),
        };
        let r = resolve(&saved, &two_cards());
        assert!(r.fell_back);
        assert_eq!(r.luid, Some(Luid { high: 0, low: 200 }));
        let r = resolve(&saved, &[card(0x10de, "Only", 0, 1)]);
        assert!(r.fell_back);
        assert_eq!(r.luid, None);
    }

    #[test]
    fn crash_guard_skips_the_flag_and_resets() {
        let saved = SavedChoice::of(&two_cards()[0]);
        let plan = plan_startup(&saved, &two_cards(), true, false);
        assert!(plan.reset_after_crash);
        assert_eq!(plan.resolution.luid, None);
        assert!(!plan.set_pending);
    }

    #[test]
    fn auto_stands_down_after_a_crash_until_picked_again() {
        let plan = plan_startup(&SavedChoice::Auto, &two_cards(), true, false);
        assert!(plan.reset_after_crash);
        let plan = plan_startup(&SavedChoice::Auto, &two_cards(), false, true);
        assert_eq!(plan.resolution.luid, None);
        assert!(!plan.set_pending && !plan.reset_after_crash);
        // An explicit card still applies while Auto is off.
        let saved = SavedChoice::of(&two_cards()[0]);
        let plan = plan_startup(&saved, &two_cards(), false, true);
        assert!(plan.resolution.luid.is_some() && plan.set_pending);
    }

    #[test]
    fn marker_is_set_only_when_a_flag_is_applied() {
        let plan = plan_startup(&SavedChoice::Auto, &two_cards(), false, false);
        assert!(plan.set_pending && !plan.reset_after_crash);
        let plan = plan_startup(&SavedChoice::Auto, &[card(1, "One", 0, 1)], false, false);
        assert!(!plan.set_pending);
        // A stale marker with no flag to apply is not a crash.
        let plan = plan_startup(&SavedChoice::Auto, &[card(1, "One", 0, 1)], true, false);
        assert!(!plan.reset_after_crash);
    }

    #[test]
    fn luid_is_formatted_as_decimal_high_comma_low() {
        let flag = luid_flag(Luid {
            high: 0,
            low: 0xABCD,
        });
        assert_eq!(flag, "--use-adapter-luid=0,43981");
        let flag = luid_flag(Luid { high: -1, low: 7 });
        assert_eq!(flag, "--use-adapter-luid=-1,7");
    }

    #[test]
    fn flag_is_appended_to_existing_args() {
        assert_eq!(append_browser_arg(Some("--a --b"), "--c"), "--a --b --c");
        assert_eq!(append_browser_arg(None, "--c"), "--c");
    }

    #[test]
    fn memory_rank_puts_the_biggest_card_first() {
        let mut cards = two_cards();
        cards[1].dedicated_mem = 8 << 30;
        rank_by_memory(&mut cards);
        assert_eq!(cards[1].high_performance_rank, 0);
        assert_eq!(cards[0].high_performance_rank, 1);
    }

    #[test]
    fn choice_validation() {
        let cards = two_cards();
        assert_eq!(parse_choice("auto", &cards), Ok(SavedChoice::Auto));
        let id = cards[0].id();
        assert_eq!(parse_choice(&id, &cards), Ok(SavedChoice::of(&cards[0])));
        assert!(parse_choice("nope", &cards).is_err());
        assert!(parse_choice(&"x".repeat(MAX_CHOICE_LEN + 1), &cards).is_err());
        assert_eq!(saved_id(&SavedChoice::of(&cards[0])), id);
    }

    #[test]
    fn saved_choice_round_trips_through_json() {
        let saved = SavedChoice::of(&two_cards()[1]);
        let value = serde_json::to_value(&saved).unwrap();
        assert_eq!(serde_json::from_value::<SavedChoice>(value).unwrap(), saved);
    }
}
