//! Android's default-network cost. No network or server state is persisted.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginApi, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct MeteredNetworkHandle(PluginHandle<Wry>);

pub(crate) fn init() -> TauriPlugin<Wry> {
    Builder::new("owncord-metered-network")
        .setup(|app, api: PluginApi<Wry, ()>| {
            let handle =
                api.register_android_plugin("com.owncord.client", "MeteredNetworkPlugin")?;
            app.manage(MeteredNetworkHandle(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize, Serialize)]
pub(crate) struct MeteredState {
    metered: bool,
}

#[tauri::command]
pub async fn is_metered(app: AppHandle) -> Result<MeteredState, String> {
    app.state::<MeteredNetworkHandle>()
        .0
        .run_mobile_plugin_async("isMetered", ())
        .await
        .map_err(|error| format!("network cost: {error}"))
}
