//! End the call when the page that drives it is gone.
//!
//! The call runs here, not in the page: mute, leave and push-to-talk all
//! come from the page. When its web process ends (a crash, the out-of-memory
//! killer), nothing could stop the microphone any more, so the call, a
//! running mic test and the settings camera preview end with it.
use tauri::{AppHandle, Manager, Runtime};

use super::session::release_blocking;
use super::{mic_test, NativeVoiceState};

/// Close the live session and every out-of-call capture. Returns the id of
/// the session it closed, if any.
pub async fn end_for_dead_page<R: Runtime>(app: &AppHandle<R>) -> Option<u64> {
    let state = app.state::<NativeVoiceState>();
    // Quiet the microphone now and end a publish holding the lock.
    state.quick.begin_close(None);
    let (session, standalone, test) = {
        let mut inner = state.inner.lock().await;
        let session = inner.session.take();
        state.quick.remove(None);
        // A connect the dead page started is superseded, so it closes its
        // own room instead of taking the slot when it finishes.
        inner.next_id += 1;
        inner.clear_keys();
        (session, inner.clear_standalone(), inner.take_mic_test())
    };
    let closed = session.as_ref().map(|(id, _)| *id);
    if let Some((id, s)) = session {
        s.close().await;
        log::info!("[native_voice] session {id} closed: the page process ended");
    }
    release_blocking(standalone).await;
    mic_test::release(test.map(|(_, t)| t)).await;
    closed
}

#[cfg(test)]
mod tests {
    use super::super::{capture, playout, quick, session};
    use super::*;

    fn app_with_state() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(NativeVoiceState::new())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app")
    }

    #[tokio::test]
    async fn a_dead_page_ends_a_publish_holding_the_lock_and_clears_the_call() {
        let app = app_with_state();
        let handle = app.handle().clone();
        let state = handle.state::<NativeVoiceState>();
        let capture = capture::Capture::default();
        let playout = playout::Playout::default();
        state
            .quick
            .install(7, capture.controls(), playout.controls());
        state
            .inner
            .lock()
            .await
            .install_key(vec![1; 32], session::KEY_INDEX, false);
        // A publish of session 7 holds the lock while the SFU stays silent.
        let closing = state.quick.closing(7);
        let held = handle.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let publish = tokio::spawn(async move {
            let state = held.state::<NativeVoiceState>();
            quick::unless_closing(
                closing,
                async {
                    let _inner = state.inner.lock().await;
                    let _ = locked_tx.send(());
                    std::future::pending::<Result<(), String>>().await
                },
                || quick::closing_error(7),
            )
            .await
        });
        locked_rx.await.expect("the publish holds the lock");
        let ended = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            end_for_dead_page(&handle),
        )
        .await
        .expect("the teardown does not wait for the SFU");
        assert_eq!(ended, None, "no session object in this test");
        assert_eq!(publish.await.unwrap(), Err(quick::closing_error(7)));
        assert!(capture.held(), "the microphone is held silent");
        assert!(state.quick.get(7).is_err(), "the quick slot is cleared");
        assert!(
            state.inner.lock().await.key.is_none(),
            "the room key is wiped"
        );
    }
}
