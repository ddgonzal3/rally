#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rally::commands;
use rally::config_ops;
use rally::git_watch::GitWatchState;
use rally::pty_manager::{self, PtyManager};
use rally::ship_ops;
use tauri::menu::{MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Show the native "Close Window?" confirmation dialog for secondary windows.
fn show_close_window_dialog(
    window: tauri::Window,
    close_window_showing: Arc<AtomicBool>,
    bypass_close_confirm: Arc<Mutex<HashSet<String>>>,
) {
    if close_window_showing.swap(true, Ordering::SeqCst) {
        return;
    }

    let s = close_window_showing.clone();
    let label = window.label().to_string();
    window
        .dialog()
        .message("Are you sure you want to close this window?")
        .title("Close Window")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close".into(),
            "Cancel".into(),
        ))
        .show(move |confirmed| {
            s.store(false, Ordering::SeqCst);
            if !confirmed {
                return;
            }

            if let Ok(mut bypass) = bypass_close_confirm.lock() {
                bypass.insert(label.clone());
            } else {
                eprintln!("Failed to lock close-window bypass set");
                return;
            }

            if let Err(e) = window.close() {
                eprintln!("Failed to close window {}: {}", label, e);
                if let Ok(mut bypass) = bypass_close_confirm.lock() {
                    bypass.remove(&label);
                }
            }
        });
}

/// Show the native "Quit Rally?" confirmation dialog on a best-effort parent window.
fn show_quit_dialog(app: tauri::AppHandle, quit_showing: Arc<AtomicBool>) {
    // Don't stack dialogs
    if quit_showing.swap(true, Ordering::SeqCst) {
        return;
    }

    let s = quit_showing.clone();
    let parent_window = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next());

    if let Some(window) = parent_window {
        window
            .dialog()
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
        s.store(false, Ordering::SeqCst);
        app.exit(0);
    }
}

/// Emit an app event to the focused window only (falls back to app-wide emit
/// if focus can't be resolved).
fn emit_to_focused_window(app: &tauri::AppHandle, event: &str) {
    let focused = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));

    if let Some(win) = focused {
        if let Err(e) = win.emit(event, ()) {
            eprintln!("Failed to emit {} to focused window: {}", event, e);
        }
    } else if let Err(e) = app.emit(event, ()) {
        eprintln!("Failed to emit {} app-wide: {}", event, e);
    }
}

fn main() {
    let pty_state: pty_manager::PtyState = Arc::new(Mutex::new(PtyManager::new()));
    let git_watch_state = GitWatchState::default();
    // Guard to prevent stacking multiple quit dialogs
    let quit_showing = Arc::new(AtomicBool::new(false));
    // Guard to prevent stacking close-window dialogs
    let close_window_showing = Arc::new(AtomicBool::new(false));
    // Window labels that are allowed to bypass close confirmation once.
    let bypass_close_confirm: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty_state)
        .manage(git_watch_state)
        .invoke_handler(tauri::generate_handler![
            commands::list_workspaces,
            commands::update_git_watch_roots,
            commands::create_workspace,
            commands::remove_workspace,
            commands::rename_workspace,
            commands::add_workspace_path,
            commands::remove_workspace_path,
            commands::git_status,
            commands::git_pr_status,
            commands::git_pr_details,
            commands::git_pr_diff,
            commands::git_edit_pr_title,
            commands::git_merge_pr,
            commands::git_changes,
            commands::git_file_at_head,
            commands::git_stage_file,
            commands::git_unstage_file,
            commands::git_discard_file,
            commands::git_diff,
            commands::git_apply_patch,
            commands::git_commit_staged,
            commands::git_push,
            commands::git_create_pr,
            commands::git_commit_log,
            commands::git_diff_stat,
            commands::git_fetch,
            commands::git_rebase_on_main,
            commands::list_directory,
            commands::detect_git_info,
            commands::trash_file,
            commands::rename_file,
            commands::reveal_in_finder,
            commands::list_scripts,
            pty_manager::spawn_pty,
            pty_manager::write_pty,
            pty_manager::resize_pty,
            pty_manager::kill_pty,
            pty_manager::list_ptys,
            config_ops::read_file_content,
            config_ops::read_file_base64,
            config_ops::write_file_content,
            config_ops::create_directory,
            config_ops::path_status,
            config_ops::list_claude_configs,
            config_ops::list_skills,
            ship_ops::check_ship_signal,
            ship_ops::clear_ship_signal,
            ship_ops::check_ship_trigger,
            ship_ops::post_merge_sync,
            ship_ops::list_rally_scripts,
            ship_ops::restore_rally_script,
        ])
        // Intercept window close button (red X):
        // - if more than one window exists: confirm closing only this window
        // - if this is the last window: confirm quitting Rally
        .on_window_event({
            let quit_showing = quit_showing.clone();
            let close_window_showing = close_window_showing.clone();
            let bypass_close_confirm = bypass_close_confirm.clone();
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let label = window.label().to_string();

                    if let Ok(mut bypass) = bypass_close_confirm.lock() {
                        if bypass.remove(&label) {
                            return;
                        }
                    } else {
                        eprintln!("Failed to lock close-window bypass set");
                    }

                    api.prevent_close();
                    if window.app_handle().webview_windows().len() > 1 {
                        show_close_window_dialog(
                            window.clone(),
                            close_window_showing.clone(),
                            bypass_close_confirm.clone(),
                        );
                    } else {
                        show_quit_dialog(window.app_handle().clone(), quit_showing.clone());
                    }
                }
            }
        })
        // Intercept our custom "Quit Rally" menu item — shows confirmation dialog
        .on_menu_event({
            let quit_showing = quit_showing.clone();
            move |app, event| {
                match event.id().as_ref() {
                    "custom-quit" => {
                        show_quit_dialog(app.clone(), quit_showing.clone());
                    }
                    "file-new-workspace" => {
                        emit_to_focused_window(app, "rally-menu-new-workspace");
                    }
                    "file-add-folder" => {
                        emit_to_focused_window(app, "rally-menu-add-folder");
                    }
                    "file-new-window" => {
                        emit_to_focused_window(app, "rally-menu-new-window");
                    }
                    "file-open-current-workspace-new-window" => {
                        emit_to_focused_window(app, "rally-menu-open-current-workspace-new-window");
                    }
                    _ => {}
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

            let file_submenu = SubmenuBuilder::new(app, "File")
                .item(
                    &MenuItemBuilder::with_id("file-new-workspace", "New Workspace...")
                        .accelerator("CmdOrCtrl+N")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("file-add-folder", "Add Folder to Workspace...")
                        .accelerator("CmdOrCtrl+Shift+O")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("file-new-window", "New Window")
                        .accelerator("CmdOrCtrl+Shift+N")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id(
                        "file-open-current-workspace-new-window",
                        "Open Current Workspace in New Window",
                    )
                    .build(app)?,
                )
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
                &[&app_submenu, &file_submenu, &edit_submenu, &view_submenu, &window_submenu],
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
            // (code is None). When app.exit(code) is called explicitly
            // (code is Some), let the exit proceed.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
