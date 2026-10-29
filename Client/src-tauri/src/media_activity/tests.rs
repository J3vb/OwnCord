//! Tests for the pure parts of the media reader. The OS calls (GSMTC, D-Bus)
//! need a desktop session and are not run here.

use super::*;

fn media(player_id: &str, title: &str) -> DetectedMedia {
    DetectedMedia {
        title: title.to_owned(),
        artist: "Artist".to_owned(),
        player: player_id.to_owned(),
        player_id: player_id.to_owned(),
        position_ms: 1_000,
        duration_ms: 200_000,
    }
}

fn playing(player_id: &str, title: &str) -> Candidate {
    Candidate {
        playing: true,
        media: media(player_id, title),
    }
}

fn paused(player_id: &str, title: &str) -> Candidate {
    Candidate {
        playing: false,
        media: media(player_id, title),
    }
}

fn choose(
    candidates: Vec<Candidate>,
    hidden: &[&str],
    last: &mut Option<String>,
) -> Option<String> {
    let prefs = MediaPrefs {
        hidden: hidden.iter().map(|s| (*s).to_owned()).collect(),
    };
    choose_media(candidates, &prefs, last).map(|m| m.player_id)
}

// -- filtering -------------------------------------------------------------------

#[test]
fn only_a_playing_session_counts() {
    let mut last = None;
    assert_eq!(
        choose(vec![paused("spotify", "Song")], &[], &mut last),
        None
    );
    assert_eq!(
        choose(
            vec![paused("a", "Song"), playing("b", "Song")],
            &[],
            &mut last
        ),
        Some("b".to_owned())
    );
}

#[test]
fn an_empty_title_is_none() {
    let mut last = None;
    assert_eq!(choose(vec![playing("spotify", "")], &[], &mut last), None);
    assert_eq!(
        choose(vec![playing("spotify", "   ")], &[], &mut last),
        None
    );
}

#[test]
fn title_and_artist_are_trimmed() {
    let mut candidate = playing("spotify", "  Song  ");
    candidate.media.artist = " Band ".to_owned();
    let got = choose_media(vec![candidate], &MediaPrefs::default(), &mut None).unwrap();
    assert_eq!(got.title, "Song");
    assert_eq!(got.artist, "Band");
}

#[test]
fn browsers_are_recognised_in_gsmtc_and_mpris_ids() {
    for id in [
        "chrome",
        "Chrome.exe",
        "MSEdge",
        "MicrosoftEdge_8wekyb3d8bbwe!MSEdge",
        "firefox",
        "firefox.instance4242",
        "Brave.exe",
        "BraveSoftware.Brave-Browser",
        "opera",
        "OperaGX.exe",
        "vivaldi",
        "chromium.instance9",
        "librewolf",
        "Waterfox.exe",
        "zen",
        "arc",
        "Yandex.exe",
        "floorp",
        "thorium",
        "plasma-browser-integration",
    ] {
        assert!(is_browser(id), "{id} should be a browser");
    }
}

#[test]
fn firefox_and_its_forks_are_known_by_their_windows_install_hash() {
    assert!(is_browser("308046B0AF4A39CB"));
    assert!(is_browser("308046b0af4a39cb"));
    // Not 16 characters, or not all hex.
    assert!(!is_browser("308046B0AF4A39C"));
    assert!(!is_browser("308046B0AF4A39CBA"));
    assert!(!is_browser("308046B0AF4A39CG"));
}

#[test]
fn yandex_music_is_not_a_browser_but_yandex_is() {
    assert!(!is_browser("Yandex.Music"));
    assert!(!is_browser("YandexMusic.exe"));
    assert!(is_browser("Yandex.exe"));
    assert!(is_browser("browser.exe"));
}

#[test]
fn more_browsers_are_recognised() {
    for id in [
        "qutebrowser",
        "org.qutebrowser.qutebrowser",
        "plasma-browser-integration",
        "torbrowser",
        "epiphany",
        "org.gnome.Epiphany",
        "falkon",
        "konqueror",
        "iridium",
        "duckduckgo",
        "ungoogled-chromium",
        "midori",
        "seamonkey",
        "palemoon",
    ] {
        assert!(is_browser(id), "{id} should be a browser");
    }
}

#[test]
fn music_players_are_not_browsers() {
    for id in [
        "Spotify.exe",
        "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify",
        "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic",
        "foobar2000.exe",
        "vlc",
        "rhythmbox",
        "strawberry",
        "org.gnome.Lollypop",
        "search-tool",
        "charcoal",
    ] {
        assert!(!is_browser(id), "{id} should not be a browser");
    }
}

#[test]
fn owncord_itself_is_skipped() {
    assert!(is_own_app("OwnCord.exe"));
    assert!(is_own_app("com.owncord.client"));
    assert!(is_own_app("owncord.instance7"));
    assert!(!is_own_app("spotify"));
    let mut last = None;
    assert_eq!(
        choose(vec![playing("OwnCord.exe", "Ring")], &[], &mut last),
        None
    );
}

#[test]
fn browser_sessions_never_win_even_when_alone() {
    let mut last = None;
    assert_eq!(
        choose(
            vec![playing("chrome", "Video"), playing("spotify", "Song")],
            &[],
            &mut last
        ),
        Some("spotify".to_owned())
    );
    assert_eq!(
        choose(vec![playing("msedge", "Video")], &[], &mut last),
        None
    );
}

#[test]
fn hidden_players_are_skipped_ignoring_case_and_spaces() {
    let mut last = None;
    assert_eq!(
        choose(
            vec![playing("Spotify.exe", "Song")],
            &[" spotify.EXE "],
            &mut last
        ),
        None
    );
    assert_eq!(
        choose(
            vec![playing("Spotify.exe", "Song"), playing("vlc", "Other")],
            &["spotify.exe"],
            &mut last
        ),
        Some("vlc".to_owned())
    );
}

// -- which player ----------------------------------------------------------------

#[test]
fn the_first_candidate_wins_when_nothing_was_shown_before() {
    let mut last = None;
    let got = choose(
        vec![playing("a", "One"), playing("b", "Two")],
        &[],
        &mut last,
    );
    assert_eq!(got, Some("a".to_owned()));
    assert_eq!(last.as_deref(), Some("a"));
}

#[test]
fn the_player_shown_last_time_stays_while_it_still_plays() {
    let mut last = Some("b".to_owned());
    // "a" is now first in the OS order, but "b" was shown and still plays.
    let got = choose(
        vec![playing("a", "One"), playing("b", "Two")],
        &[],
        &mut last,
    );
    assert_eq!(got, Some("b".to_owned()));
    // Its id is matched ignoring case.
    let mut last = Some("B".to_owned());
    let got = choose(
        vec![playing("a", "One"), playing("b", "Two")],
        &[],
        &mut last,
    );
    assert_eq!(got, Some("b".to_owned()));
}

#[test]
fn the_choice_moves_on_when_the_shown_player_pauses_or_is_hidden() {
    let mut last = Some("b".to_owned());
    let got = choose(
        vec![playing("a", "One"), paused("b", "Two")],
        &[],
        &mut last,
    );
    assert_eq!(got, Some("a".to_owned()));
    assert_eq!(last.as_deref(), Some("a"));

    let mut last = Some("b".to_owned());
    let got = choose(
        vec![playing("a", "One"), playing("b", "Two")],
        &["b"],
        &mut last,
    );
    assert_eq!(got, Some("a".to_owned()));
}

#[test]
fn nothing_playing_forgets_the_last_player() {
    let mut last = Some("b".to_owned());
    assert_eq!(choose(vec![paused("b", "Two")], &[], &mut last), None);
    assert_eq!(last, None);
    // Another player starting later is not held back by the old choice.
    let got = choose(
        vec![playing("a", "One"), playing("b", "Two")],
        &[],
        &mut last,
    );
    assert_eq!(got, Some("a".to_owned()));
}

#[test]
fn a_song_change_in_the_same_player_keeps_the_player() {
    let mut last = None;
    choose(
        vec![playing("a", "One"), playing("b", "Two")],
        &[],
        &mut last,
    );
    let got = choose(
        vec![playing("b", "Three"), playing("a", "Four")],
        &[],
        &mut last,
    );
    assert_eq!(got, Some("a".to_owned()));
}

// -- the answer's shape ----------------------------------------------------------

#[test]
fn an_unreadable_poll_is_unknown_and_keeps_the_last_player() {
    let mut last = Some("spotify".to_owned());
    let got = reading_from(None, &MediaPrefs::default(), &mut last);
    assert_eq!(got, MediaReading::Unknown);
    assert_eq!(last.as_deref(), Some("spotify"));
}

#[test]
fn an_empty_poll_is_none_and_forgets_the_last_player() {
    let mut last = Some("spotify".to_owned());
    let got = reading_from(Some(Vec::new()), &MediaPrefs::default(), &mut last);
    assert_eq!(got, MediaReading::None);
    assert_eq!(last, None);
}

#[test]
fn a_song_is_playing() {
    let got = reading_from(
        Some(vec![playing("spotify", "Song")]),
        &MediaPrefs::default(),
        &mut None,
    );
    assert_eq!(got, MediaReading::Playing(media("spotify", "Song")));
}

#[test]
fn the_three_states_serialise_with_a_state_tag() {
    let playing = serde_json::to_value(MediaReading::Playing(media("spotify", "Song"))).unwrap();
    assert_eq!(playing["state"], "playing");
    assert_eq!(playing["title"], "Song");
    assert_eq!(playing["playerId"], "spotify");
    assert_eq!(
        serde_json::to_value(MediaReading::None).unwrap(),
        serde_json::json!({ "state": "none" })
    );
    assert_eq!(
        serde_json::to_value(MediaReading::Unknown).unwrap(),
        serde_json::json!({ "state": "unknown" })
    );
}

#[test]
fn a_second_poll_while_one_runs_is_refused() {
    let flag = AtomicBool::new(false);
    let first = BusyGuard::acquire(&flag);
    assert!(first.is_some());
    assert!(BusyGuard::acquire(&flag).is_none());
    assert!(BusyGuard::acquire(&flag).is_none());
    assert!(flag.load(Ordering::Acquire));
    drop(first);
    assert!(BusyGuard::acquire(&flag).is_some());
}

// -- ids and names ---------------------------------------------------------------

#[test]
fn mpris_ids_lose_the_prefix_and_the_instance_tail() {
    assert_eq!(mpris_player_id("org.mpris.MediaPlayer2.spotify"), "spotify");
    assert_eq!(
        mpris_player_id("org.mpris.MediaPlayer2.vlc.instance12345"),
        "vlc"
    );
    assert_eq!(
        mpris_player_id("org.mpris.MediaPlayer2.org.gnome.Lollypop"),
        "org.gnome.Lollypop"
    );
    // Any tail after ".instance" goes.
    assert_eq!(
        mpris_player_id("org.mpris.MediaPlayer2.vlc.instance_1_123"),
        "vlc"
    );
    assert_eq!(
        mpris_player_id("org.mpris.MediaPlayer2.foo.instanceX"),
        "foo"
    );
    assert_eq!(
        mpris_player_id("org.mpris.MediaPlayer2.foo.instance"),
        "foo"
    );
}

#[test]
fn known_gsmtc_ids_get_their_proper_name() {
    for (id, name) in [
        ("Spotify.exe", "Spotify"),
        ("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "Spotify"),
        (
            "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic",
            "Media Player",
        ),
        ("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App", "Apple Music"),
        ("iTunes.exe", "iTunes"),
        ("foobar2000.exe", "foobar2000"),
        ("MusicBee.exe", "MusicBee"),
        ("AIMP.exe", "AIMP"),
        ("vlc.exe", "VLC"),
        ("TIDAL.exe", "TIDAL"),
        ("Deezer.exe", "Deezer"),
        ("AmazonMusic.exe", "Amazon Music"),
        ("th-ch.YouTube-Music", "YouTube Music"),
        ("wmplayer.exe", "Windows Media Player"),
        ("Winamp.exe", "Winamp"),
        ("Dopamine.exe", "Dopamine"),
        ("MediaMonkey.exe", "MediaMonkey"),
    ] {
        assert_eq!(gsmtc_display_name(id), name, "{id}");
    }
}

#[test]
fn unknown_gsmtc_ids_fall_back_to_a_cleaned_name() {
    assert_eq!(gsmtc_display_name("chrome"), "Chrome");
    assert_eq!(gsmtc_display_name("MSEdge"), "MSEdge");
    assert_eq!(gsmtc_display_name("CoolPlayer.exe"), "CoolPlayer");
    assert_eq!(gsmtc_display_name("coolplayer.EXE"), "Coolplayer");
    assert_eq!(gsmtc_display_name("C:\\Apps\\Cool.exe"), "Cool");
    assert_eq!(
        gsmtc_display_name("Vendor.CoolPlayer_abc123!App"),
        "CoolPlayer"
    );
    assert_eq!(gsmtc_display_name("  "), "");
}

// -- position --------------------------------------------------------------------

/// 100 ns ticks in a second.
const SEC: i64 = 10_000_000;
const BASE: i64 = 132_000_000_000_000_000;

#[test]
fn position_catches_up_with_the_time_since_the_update() {
    assert_eq!(
        caught_up_position_ms(10_000, 200_000, BASE, BASE + 3 * SEC),
        13_000
    );
    assert_eq!(caught_up_position_ms(10_000, 200_000, BASE, BASE), 10_000);
}

#[test]
fn position_is_clamped_to_the_length() {
    assert_eq!(
        caught_up_position_ms(190_000, 200_000, BASE, BASE + 60 * SEC),
        200_000
    );
    // A position already past the length (bad data) is clamped too.
    assert_eq!(caught_up_position_ms(250_000, 200_000, BASE, BASE), 200_000);
}

#[test]
fn position_without_a_length_is_not_clamped() {
    assert_eq!(
        caught_up_position_ms(10_000, 0, BASE, BASE + 5 * SEC),
        15_000
    );
}

#[test]
fn a_missing_or_future_update_time_adds_nothing() {
    assert_eq!(caught_up_position_ms(10_000, 200_000, 0, BASE), 10_000);
    assert_eq!(caught_up_position_ms(10_000, 200_000, -5, BASE), 10_000);
    assert_eq!(
        caught_up_position_ms(10_000, 200_000, BASE + 5 * SEC, BASE),
        10_000
    );
    assert_eq!(
        caught_up_position_ms(u64::MAX, 0, BASE, BASE + SEC),
        u64::MAX
    );
}

// -- prefs and wire shape --------------------------------------------------------

#[test]
fn prefs_and_answer_use_camel_case() {
    let prefs: MediaPrefs = serde_json::from_str(r#"{"hidden":["a","B"]}"#).unwrap();
    assert_eq!(prefs.hidden, ["a", "B"]);
    assert_eq!(
        serde_json::from_str::<MediaPrefs>("{}").unwrap(),
        MediaPrefs::default()
    );
    let json = serde_json::to_value(media("spotify", "Song")).unwrap();
    assert_eq!(json["playerId"], "spotify");
    assert_eq!(json["positionMs"], 1_000);
    assert_eq!(json["durationMs"], 200_000);
    assert_eq!(json["title"], "Song");
}

// -- MPRIS metadata (Linux only: the dbus crate is a Linux dependency) -----------

#[cfg(target_os = "linux")]
mod mpris {
    use dbus::arg::{PropMap, RefArg, Variant};

    use super::super::mpris_linux::{
        is_own_process, parse_metadata, parse_playing, parse_stat_ppid, Metadata,
    };

    fn put(map: &mut PropMap, key: &str, value: impl RefArg + 'static) {
        map.insert(key.to_owned(), Variant(Box::new(value)));
    }

    #[test]
    fn a_full_metadata_map_is_parsed() {
        let mut map = PropMap::new();
        put(&mut map, "xesam:title", "Song".to_owned());
        put(
            &mut map,
            "xesam:artist",
            vec!["Band".to_owned(), "Guest".to_owned()],
        );
        put(&mut map, "mpris:length", 215_500_000_i64);
        assert_eq!(
            parse_metadata(&map),
            Metadata {
                title: "Song".to_owned(),
                artist: "Band, Guest".to_owned(),
                duration_ms: 215_500,
            }
        );
    }

    #[test]
    fn a_missing_artist_and_length_are_empty_and_zero() {
        let mut map = PropMap::new();
        put(&mut map, "xesam:title", "Song".to_owned());
        assert_eq!(
            parse_metadata(&map),
            Metadata {
                title: "Song".to_owned(),
                artist: String::new(),
                duration_ms: 0,
            }
        );
        assert_eq!(parse_metadata(&PropMap::new()), Metadata::default());
    }

    #[test]
    fn players_that_get_the_types_wrong_are_still_read() {
        let mut map = PropMap::new();
        put(&mut map, "xesam:title", "Song".to_owned());
        // A bare string instead of an array, an unsigned length.
        put(&mut map, "xesam:artist", "Solo".to_owned());
        put(&mut map, "mpris:length", 90_000_000_u64);
        let got = parse_metadata(&map);
        assert_eq!(got.artist, "Solo");
        assert_eq!(got.duration_ms, 90_000);
        // A 32-bit length.
        let mut map = PropMap::new();
        put(&mut map, "mpris:length", 60_000_000_i32);
        assert_eq!(parse_metadata(&map).duration_ms, 60_000);
    }

    #[test]
    fn empty_and_negative_values_are_dropped() {
        let mut map = PropMap::new();
        put(
            &mut map,
            "xesam:artist",
            vec![String::new(), " Band ".to_owned()],
        );
        put(&mut map, "mpris:length", -1_i64);
        let got = parse_metadata(&map);
        assert_eq!(got.artist, "Band");
        assert_eq!(got.duration_ms, 0);
    }

    #[test]
    fn the_parent_pid_is_read_from_a_stat_line() {
        assert_eq!(
            parse_stat_ppid("4242 (WebKitWebProcess) S 4000 4242 4242 0 -1 4194560"),
            Some(4000)
        );
        // A program name with spaces and parentheses.
        assert_eq!(parse_stat_ppid("77 (my (odd) name) R 12 77 77 0"), Some(12));
        assert_eq!(parse_stat_ppid(""), None);
        assert_eq!(parse_stat_ppid("77 (x"), None);
        assert_eq!(parse_stat_ppid("77 (x) S"), None);
        assert_eq!(parse_stat_ppid("77 (x) S notanumber 1"), None);
    }

    #[test]
    fn our_own_process_and_its_children_are_ours() {
        assert!(is_own_process(100, 100, None));
        assert!(is_own_process(200, 100, Some(100)));
        assert!(!is_own_process(200, 100, Some(1)));
        assert!(!is_own_process(200, 100, None));
    }

    #[test]
    fn only_the_playing_status_counts() {
        assert!(parse_playing("Playing"));
        assert!(!parse_playing("Paused"));
        assert!(!parse_playing("Stopped"));
        assert!(!parse_playing(""));
    }
}
