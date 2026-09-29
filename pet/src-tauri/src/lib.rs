use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, Wry};

#[tauri::command]
fn read_pet_token() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    std::fs::read_to_string(format!("{home}/.kitsune/pet-token"))
        .map(|s| s.trim().to_string())
        .map_err(|_| "No encuentro ~/.kitsune/pet-token (¿Kitsune está corriendo?)".to_string())
}

#[tauri::command]
fn set_click_through(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
fn cursor_in_window(window: WebviewWindow) -> Result<Option<(f64, f64)>, String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let (x, y) = (cursor.x - pos.x as f64, cursor.y - pos.y as f64);
    if x < 0.0 || y < 0.0 || x > size.width as f64 || y > size.height as f64 { return Ok(None); }
    Ok(Some((x / scale, y / scale)))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let size = SubmenuBuilder::new(app, "Tamaño")
        .item(&MenuItemBuilder::with_id("size_2", "2×").build(app)?)
        .item(&MenuItemBuilder::with_id("size_3", "3×").build(app)?)
        .item(&MenuItemBuilder::with_id("size_4", "4×").build(app)?)
        .build()?;
    MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("toggle", "Ocultar / Mostrar").build(app)?)
        .item(&CheckMenuItemBuilder::with_id("dnd", "No molestar").build(app)?)
        .item(&MenuItemBuilder::with_id("open_ronin", "Abrir Ronin").build(app)?)
        .item(&size)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Salir").build(app)?)
        .build()
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => app.exit(0),
        "toggle" => {
            if let Some(w) = app.get_webview_window("pet") {
                if w.is_visible().unwrap_or(true) { let _ = w.hide(); } else { let _ = w.show(); }
            }
        }
        "open_ronin" => { let _ = std::process::Command::new("open").args(["-a", "Ronin"]).spawn(); }
        other => { let _ = app.emit("pet-menu", other.to_string()); }
    }
}

#[tauri::command]
fn show_context_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let menu = build_menu(&app).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![read_pet_token, set_click_through, cursor_in_window, show_context_menu])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let menu = build_menu(app.handle())?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("ícono"))
                .menu(&menu)
                .show_menu_on_left_click(true)
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al iniciar la mascota");
}
