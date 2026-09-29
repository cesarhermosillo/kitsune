use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, Wry};
use tauri_plugin_window_state::StateFlags;
use std::sync::atomic::{AtomicBool, Ordering};

const TRAY_ID: &str = "main";

/// m1: "No molestar" vive en Rust para que la bandeja y el menú contextual muestren la marca
/// correcta; el webview lo persiste en localStorage y lo envía al arrancar con `set_dnd`.
#[derive(Default)]
struct Dnd(AtomicBool);

/// Evento explícito que recibe el webview cuando cambia "No molestar".
fn dnd_payload(on: bool) -> &'static str {
    if on { "dnd_on" } else { "dnd_off" }
}

/// Spec §4: clicking the "Ver en Ronin" link in the expanded bubble, and the
/// tray/context menu's "Abrir Ronin" item, must run the exact same command —
/// no duplicated `open -a Ronin` logic.
fn spawn_open_ronin() {
    let _ = std::process::Command::new("open").args(["-a", "Ronin"]).spawn();
}

/// Only `https://` URLs may be opened via the ClickUp links in the expanded
/// bubble (they come from the daemon over the local API, not from the user).
fn is_allowed_url(url: &str) -> bool {
    url.starts_with("https://")
}

/// Spec §4: default window position is the bottom-right corner of the
/// primary monitor's work area, with a margin. Pure so it's unit-testable
/// without a real monitor/window.
fn bottom_right(
    monitor_pos: (i32, i32),
    monitor_size: (u32, u32),
    window_size: (u32, u32),
    margin: i32,
) -> (i32, i32) {
    let x = monitor_pos.0 + monitor_size.0 as i32 - window_size.0 as i32 - margin;
    let y = monitor_pos.1 + monitor_size.1 as i32 - window_size.1 as i32 - margin;
    (x, y)
}

const INITIAL_POSITION_MARGIN: i32 = 16;

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

/// Spec §4: clicking a ClickUp link in the expanded bubble. Only accepts
/// `https://` URLs (see `is_allowed_url`); anything else is rejected instead
/// of shelling out.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !is_allowed_url(&url) {
        return Err("Solo se permiten URLs https://".to_string());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Spec §4: clicking "Ver en Ronin" in the expanded bubble. Reuses the same
/// logic as the tray/context menu's "Abrir Ronin" item.
#[tauri::command]
fn open_ronin() {
    spawn_open_ronin();
}

fn build_menu(app: &AppHandle, dnd: bool) -> tauri::Result<Menu<Wry>> {
    let size = SubmenuBuilder::new(app, "Tamaño")
        .item(&MenuItemBuilder::with_id("size_2", "2×").build(app)?)
        .item(&MenuItemBuilder::with_id("size_3", "3×").build(app)?)
        .item(&MenuItemBuilder::with_id("size_4", "4×").build(app)?)
        .build()?;
    MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("toggle", "Ocultar / Mostrar").build(app)?)
        .item(&CheckMenuItemBuilder::with_id("dnd", "No molestar").checked(dnd).build(app)?)
        .item(&MenuItemBuilder::with_id("open_ronin", "Abrir Ronin").build(app)?)
        .item(&size)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Salir").build(app)?)
        .build()
}

fn current_dnd(app: &AppHandle) -> bool {
    app.state::<Dnd>().0.load(Ordering::SeqCst)
}

/// Reconstruye el menú de la bandeja para que la marca de "No molestar" refleje el estado.
fn refresh_tray_menu(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app, current_dnd(app))) {
        let _ = tray.set_menu(Some(menu));
    }
}

#[tauri::command]
fn set_dnd(app: AppHandle, dnd: State<'_, Dnd>, on: bool) {
    dnd.0.store(on, Ordering::SeqCst);
    refresh_tray_menu(&app);
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => app.exit(0),
        "toggle" => {
            if let Some(w) = app.get_webview_window("pet") {
                // m2: el webview deja de sondear el cursor mientras la ventana está oculta.
                let visible = !w.is_visible().unwrap_or(true);
                if visible { let _ = w.show(); } else { let _ = w.hide(); }
                let _ = app.emit("pet-visible", visible);
            }
        }
        "dnd" => {
            let on = !app.state::<Dnd>().0.fetch_xor(true, Ordering::SeqCst);
            refresh_tray_menu(app);
            let _ = app.emit("pet-menu", dnd_payload(on).to_string());
        }
        "open_ronin" => spawn_open_ronin(),
        other => { let _ = app.emit("pet-menu", other.to_string()); }
    }
}

#[tauri::command]
fn show_context_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let menu = build_menu(&app, current_dnd(&app)).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// Spec §4: "Posición: por defecto en la esquina inferior derecha." Only on
/// first launch (no saved window-state yet) — a marker file records that the
/// initial placement already happened, so a user's subsequent drag (saved by
/// `tauri-plugin-window-state`) is never overridden on later launches.
fn position_at_bottom_right_on_first_launch(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else { return };
    let marker = data_dir.join("positioned");
    if marker.exists() {
        return;
    }
    if let Some(window) = app.get_webview_window("pet") {
        if let (Ok(Some(monitor)), Ok(window_size)) = (window.current_monitor(), window.outer_size()) {
            let work_area = monitor.work_area();
            let (x, y) = bottom_right(
                (work_area.position.x, work_area.position.y),
                (work_area.size.width, work_area.size.height),
                (window_size.width, window_size.height),
                INITIAL_POSITION_MARGIN,
            );
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }
    let _ = std::fs::create_dir_all(&data_dir);
    let _ = std::fs::write(&marker, b"");
}

pub fn run() {
    tauri::Builder::default()
        // El tamaño lo fija tauri.conf.json (220×300); solo se recuerda la posición y demás, no el tamaño.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::SIZE)
                .build(),
        )
        .manage(Dnd::default())
        .invoke_handler(tauri::generate_handler![read_pet_token, set_click_through, cursor_in_window, show_context_menu, open_url, open_ronin, set_dnd])
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            position_at_bottom_right_on_first_launch(app.handle());
            let menu = build_menu(app.handle(), current_dnd(app.handle()))?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().cloned().expect("ícono"))
                .menu(&menu)
                .show_menu_on_left_click(true)
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al iniciar la mascota");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dnd_payload_is_explicit() {
        assert_eq!(dnd_payload(true), "dnd_on");
        assert_eq!(dnd_payload(false), "dnd_off");
    }

    #[test]
    fn dnd_toggle_flips_the_atomic_state() {
        let dnd = Dnd::default();
        assert!(!dnd.0.fetch_xor(true, Ordering::SeqCst));
        assert!(dnd.0.load(Ordering::SeqCst));
        assert!(dnd.0.fetch_xor(true, Ordering::SeqCst));
        assert!(!dnd.0.load(Ordering::SeqCst));
    }

    #[test]
    fn is_allowed_url_accepts_https() {
        assert!(is_allowed_url("https://app.clickup.com/t/abc123"));
    }

    #[test]
    fn is_allowed_url_rejects_http() {
        assert!(!is_allowed_url("http://app.clickup.com/t/abc123"));
    }

    #[test]
    fn is_allowed_url_rejects_non_http_schemes() {
        assert!(!is_allowed_url("javascript:alert(1)"));
        assert!(!is_allowed_url("file:///etc/passwd"));
        assert!(!is_allowed_url("ftp://example.com"));
    }

    #[test]
    fn is_allowed_url_rejects_empty_and_garbage() {
        assert!(!is_allowed_url(""));
        assert!(!is_allowed_url("not a url"));
    }

    #[test]
    fn bottom_right_places_window_flush_with_monitor_corner_minus_margin() {
        assert_eq!(
            bottom_right((0, 0), (1920, 1080), (220, 220), 16),
            (1920 - 220 - 16, 1080 - 220 - 16)
        );
    }

    #[test]
    fn bottom_right_accounts_for_monitor_offset() {
        // A secondary monitor positioned to the right of the primary one.
        assert_eq!(
            bottom_right((1920, 0), (1440, 900), (220, 220), 16),
            (1920 + 1440 - 220 - 16, 900 - 220 - 16)
        );
    }

    #[test]
    fn bottom_right_zero_margin_touches_the_corner() {
        assert_eq!(
            bottom_right((0, 0), (1000, 800), (220, 220), 0),
            (780, 580)
        );
    }
}
