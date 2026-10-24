pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("coaster-mobile")
        .setup(|_, api| {
            api.register_android_plugin("com.watercompanion.mobile", "MobilePlugin")?;
            Ok(())
        })
        .build()
}
