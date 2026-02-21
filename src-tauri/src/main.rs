#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rally::commands;
use rally::config_ops;
use rally::pty_manager::{self, PtyManager};
use rally::ship_ops;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[tauri::command]
fn confirmed_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Show the native "Quit Rally?" confirmation dialog.
/// Uses `quit_showing` to prevent stacking. On confirm, sets `force_quit` and exits.
fn show_quit_dialog(
    app: tauri::AppHandle,
    quit_showing: Arc<AtomicBool>,
    force_quit: Arc<AtomicBool>,
) {
    // Don't stack dialogs
    if quit_showing.swap(true, Ordering::SeqCst) {
        return;
    }

    let s = quit_showing.clone();
    let f = force_quit.clone();

    app.dialog()
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
                f.store(true, Ordering::SeqCst);
                app.exit(0);
            }
        });
}

fn main() {
    let pty_state: pty_manager::PtyState = Arc::new(Mutex::new(PtyManager::new()));
    // Guard to prevent stacking multiple quit dialogs
    let quit_showing = Arc::new(AtomicBool::new(false));
    // When true, allow the quit to proceed (user already confirmed)
    let force_quit = Arc::new(AtomicBool::new(false));

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
            confirmed_quit,
        ])
        // Intercept window close button (red X) — show quit dialog
        .on_window_event({
            let quit_showing = quit_showing.clone();
            let force_quit = force_quit.clone();
            move |window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if force_quit.load(Ordering::SeqCst) {
                        return; // User already confirmed — let it close
                    }
                    api.prevent_close();
                    show_quit_dialog(
                        window.app_handle().clone(),
                        quit_showing.clone(),
                        force_quit.clone(),
                    );
                }
            }
        })
        .setup(|app| {
            // Install default commands (ship.md, review-pr.md) globally
            if let Err(e) = ship_ops::ensure_default_commands() {
                eprintln!("Warning: failed to install default commands: {}", e);
            }

            let win = app.get_webview_window("main").unwrap();
            // Position window on the largest monitor's left half
            if let Ok(monitors) = win.available_monitors() {
                // Pick the monitor with the largest width (likely the widescreen)
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
        .run({
            let quit_showing = quit_showing.clone();
            let force_quit = force_quit.clone();
            move |app_handle, event| {
                // Intercept Cmd+Q / app-level quit (ExitRequested)
                // This is separate from WindowEvent::CloseRequested — macOS Cmd+Q
                // triggers the app exit directly without going through window close.
                if let tauri::RunEvent::ExitRequested { api, .. } = event {
                    if force_quit.load(Ordering::SeqCst) {
                        return; // User already confirmed — let it exit
                    }
                    api.prevent_exit();
                    show_quit_dialog(
                        app_handle.clone(),
                        quit_showing.clone(),
                        force_quit.clone(),
                    );
                }
            }
        });
}
