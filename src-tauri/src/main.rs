#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rally::commands;
use rally::config_ops;
use rally::pty_manager::{self, PtyManager};
use rally::ship_ops;
use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Show the native "Quit Rally?" confirmation dialog.
/// Uses `quit_showing` to prevent stacking. On confirm, exits the app.
/// The dialog is parented to the main window so it appears as a visible sheet.
fn show_quit_dialog(app: tauri::AppHandle, quit_showing: Arc<AtomicBool>) {
    // Don't stack dialogs
    if quit_showing.swap(true, Ordering::SeqCst) {
        return;
    }

    let s = quit_showing.clone();

    // Use the window's dialog so it appears as a sheet on the main window
    if let Some(win) = app.get_webview_window("main") {
        win.dialog()
            .message("Are you sure you want to quit Rally?")
            .title("Quit Rally")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Quit".into(),
                "Cancel".into(),
            ))
            .show(move |confirmed| {
                s.store(false, Ordering::SeqCst);
                if confirmed {
                    app.exit(0);
                }
            });
    } else {
        // No window found — just exit
        app.exit(0);
    }
}

fn main() {
    let pty_state: pty_manager::PtyState = Arc::new(Mutex::new(PtyManager::new()));
    // Guard to prevent stacking multiple quit dialogs
    let quit_showing = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty_state)
        .invoke_handler(tauri::generate_handler![
            commands::list_workspaces,
            commands::create_workspace,
            commands::remove_workspace,
            commands::add_workspace_path,
            commands::remove_workspace_path,
            commands::git_status,
            commands::git_sync,
            commands::git_rebase,
            commands::git_commit,
            commands::git_push,
            commands::git_create_pr,
            commands::git_pr_status,
            commands::git_merge_pr,
            commands::git_changes,
            commands::git_file_at_head,
            commands::git_stage_file,
            commands::git_unstage_file,
            commands::list_directory,
            commands::detect_git_info,
            commands::list_curated_files,
            commands::reveal_in_finder,
            commands::list_tasks,
            commands::sync_claude_commands,
            pty_manager::spawn_pty,
            pty_manager::write_pty,
            pty_manager::resize_pty,
            pty_manager::kill_pty,
            pty_manager::list_ptys,
            config_ops::read_file_content,
            config_ops::read_file_base64,
            config_ops::write_file_content,
            config_ops::list_claude_configs,
            config_ops::list_skills,
            ship_ops::check_ship_signal,
            ship_ops::clear_ship_signal,
            ship_ops::check_ship_trigger,
            ship_ops::post_merge_sync,
        ])
        // Intercept window close button (red X) — show quit dialog
        .on_window_event({
            let quit_showing = quit_showing.clone();
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    show_quit_dialog(
                        window.app_handle().clone(),
                        quit_showing.clone(),
                    );
                }
            }
        })
        // Intercept our custom "Quit Rally" menu item — shows confirmation dialog
        .on_menu_event({
            let quit_showing = quit_showing.clone();
            move |app, event| {
                if event.id() == "custom-quit" {
                    show_quit_dialog(app.clone(), quit_showing.clone());
                }
            }
        })
        .setup(|app| {
            // Install default commands (ship.md, review-pr.md) globally
            if let Err(e) = ship_ops::ensure_default_commands() {
                eprintln!("Warning: failed to install default commands: {}", e);
            }

            // Custom app menu: replaces the default Quit with our own that shows
            // a confirmation dialog. macOS Cmd+Q normally triggers RunEvent::Exit
            // directly (impossible to prevent), so we replace the Quit menu item
            // with a custom one bound to Cmd+Q that routes through on_menu_event.
            let app_submenu = SubmenuBuilder::new(app, "Rally")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(
                    &MenuItemBuilder::with_id("custom-quit", "Quit Rally")
                        .accelerator("CmdOrCtrl+Q")
                        .build(app)?,
                )
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let view_submenu = SubmenuBuilder::new(app, "View")
                .fullscreen()
                .build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .item(&PredefinedMenuItem::close_window(app, Some("Close Window"))?)
                .build()?;

            let menu = tauri::menu::Menu::with_items(
                app,
                &[&app_submenu, &edit_submenu, &view_submenu, &window_submenu],
            )?;
            app.set_menu(menu)?;

            let win = app.get_webview_window("main").unwrap();
            // Position window on the largest monitor's left half
            if let Ok(monitors) = win.available_monitors() {
                if let Some(monitor) = monitors.iter().max_by_key(|m| m.size().width) {
                    let pos = monitor.position();
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let half_w = (size.width as f64 / scale / 2.0) as f64;
                    let h = (size.height as f64 / scale) as f64;
                    let x = pos.x as f64 / scale;
                    let y = pos.y as f64 / scale;
                    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
                    let _ = win.set_size(tauri::LogicalSize::new(half_w, h));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            // Prevent the app from exiting when the last window is "closed"
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
